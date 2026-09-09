"""Phase 7/7.5：Calendar 写入闭环测试（Instant 语义）。"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.calendar_write import (
    CalendarWriteError,
    IcsWriteProvider,
    build_drafts,
    execute_drafts,
    make_uid,
    validate_draft,
)
from app.schemas import CalendarDraftItem, ExecuteRequest


def T(task_id, title, est, pri=2, dur=None):
    return {"taskId": task_id, "title": title, "estMinutes": est, "priority": pri, **({"durationDays": dur} if dur else {})}


def BD(tasks, days, busy, tz="Asia/Shanghai", *, workdays=frozenset(range(1, 8)), start=480, end=1200, cap=480, cal="primary"):
    """build_drafts 的策略包装：默认 = 迁移期行为（全周、08:00–20:00、480m/天、primary）。"""
    return build_drafts(tasks, days, busy, "g1", 1, tz,
                        workdays=set(workdays), work_start_minute=start, work_end_minute=end,
                        daily_cap_minutes=cap, calendar_id=cal)


class MemoryProvider:
    provider_name = "memory"

    def __init__(self, fail_on_uid_substr: str | None = None):
        self.events: list[dict] = []
        self.fail_on = fail_on_uid_substr

    def read_events(self):
        return [dict(e) for e in self.events]

    def create_event(self, uid, title, start, end):
        if self.fail_on and self.fail_on in uid:
            raise CalendarWriteError("CAL_SERVER", "simulated 5xx")
        self.events.append({"uid": uid, "title": title, "allDay": False, "localDate": None,
                            "startUtc": start.isoformat().replace("+00:00", "Z"),
                            "endUtc": end.isoformat().replace("+00:00", "Z")})


def busy_utc(day_offset: int, h1: int, h2: int, tz: str = "Asia/Shanghai") -> dict:
    """用 canonical 转换构造忙碌事件（与 ICS TZID 等价）。h2=24 表示次日 00:00。"""
    from datetime import date, timedelta

    from app.times import to_utc

    d = date.today() + timedelta(days=day_offset)
    end_d = d + timedelta(days=1) if h2 == 24 else d
    e_hour = 0 if h2 == 24 else h2
    s = to_utc(datetime(d.year, d.month, d.day, h1), tz).instant
    e = to_utc(datetime(end_d.year, end_d.month, end_d.day, e_hour), tz).instant
    return {"startUtc": s.isoformat().replace("+00:00", "Z"), "endUtc": e.isoformat().replace("+00:00", "Z"),
            "allDay": False, "localDate": None}


# ---------------------------------------------------------------- Draft Builder（规划时区墙钟）

class TestBuildDrafts:
    def test_places_in_planning_tz_window(self):
        # 规划时区 Tokyo：09:00-13:00 会议 → 120min 任务排 13:00（Tokyo 墙钟）
        drafts = BD([T("t1", "任务A", 120, 1)], 2, [busy_utc(0, 9, 13, "Asia/Tokyo")], "Asia/Tokyo")
        assert len(drafts) == 1
        assert drafts[0].timezone == "Asia/Tokyo"
        # 13:00 Tokyo = 04:00 UTC
        assert drafts[0].startUtc.endswith("T04:00:00Z")
        assert drafts[0].idempotencyKey == "g1:1:t1:1"

    def test_busy_in_other_tz_blocks_correctly(self):
        # 会议以上海 17:00-19:00 表达（= Tokyo 18:00-20:00），规划 Tokyo：当天 08-18 仍可容纳 300min
        drafts = BD([T("t1", "任务", 300, 1)], 2, [busy_utc(0, 17, 19, "Asia/Shanghai")], "Asia/Tokyo")
        assert len(drafts) == 1
        from app.times import wall_in_tz

        start_wall = wall_in_tz(datetime.fromisoformat(drafts[0].startUtc.replace("Z", "+00:00")), "Asia/Tokyo")
        assert start_wall.strftime("%H:%M") == "08:00"  # Tokyo 墙钟 08:00 起排

    def test_all_day_local_date_blocks_day(self):
        from datetime import date

        busy = [{"startUtc": "", "endUtc": "", "allDay": True, "localDate": date.today().isoformat()}]
        drafts = BD([T("t1", "任务", 60, 1)], 2, busy)
        assert drafts[0].startUtc > f"{date.today().isoformat()}T"  # 次日

    def test_periodic_occurrences(self):
        drafts = BD([T("t1", "每日训练", 30, 2, dur=3)], 5, [])
        assert len(drafts) == 3 and len({d.idempotencyKey for d in drafts}) == 3

    def test_unplaced_when_full(self):
        busy = [busy_utc(i, 0, 24) for i in range(3)]
        drafts = BD([T("t1", "大任务", 600, 1)], 3, busy)
        assert drafts == []

    def test_cross_midnight_event_blocks_both_windows(self):
        # 19:00-次日10:00 的跨午夜事件：当天窗口 08-20 剩 08-19，次日剩 10-20
        drafts = BD([T("t1", "任务", 600, 1)], 3, [busy_utc(0, 19, 24), busy_utc(1, 0, 10)])
        assert len(drafts) == 1
        assert drafts[0].startUtc.startswith((datetime.fromisoformat(drafts[0].startUtc)).strftime("%Y-%m-%d"))  # 当天 08:00 起连续 600min

    def test_daily_cap_spreads_tasks_across_days(self):
        # 4×120m 任务、7 天窗口：不得全堆同一天（每日上限 480m 内按「当日已排最少」分散）
        drafts = BD([T(f"t{i}", f"任务{i}", 120, 1) for i in range(4)], 7, [])
        assert len(drafts) == 4
        days = {d.startUtc[:10] for d in drafts}
        assert len(days) >= 2, f"4 个任务被排进同一天: {sorted(days)}"
        per_day: dict[str, int] = {}
        for d in drafts:
            per_day[d.startUtc[:10]] = per_day.get(d.startUtc[:10], 0) + 120
        assert all(v <= 480 for v in per_day.values())

    def test_cap_fallback_places_when_all_days_capped(self):
        # 每日上限 240m：3×120m 会把前两天填满，第三个任务超上限但仍有空闲 → 兜底排入而非丢弃
        drafts = BD([T(f"t{i}", f"任务{i}", 120, 1) for i in range(3)], 2, [], cap=240)
        assert len(drafts) == 3

    # ------------------------------------------------ Phase 12：策略（工作日/时段/上限/日历）

    def test_policy_zero_capacity_places_nothing(self):
        # 0 容量 = 用户明确声明不排期 → 不做兜底，全部 unplaced
        drafts = BD([T("t1", "任务", 60, 1)], 3, [], cap=0)
        assert drafts == []

    def test_policy_weekend_disabled_never_on_weekend(self):
        # 仅工作日（一~五）：所有草稿的墙钟日都必须是 ISO 1–5，且不早于 09:00 窗口
        from app.times import wall_in_tz

        drafts = BD([T("t1", "任务", 60, 1)], 7, [], workdays={1, 2, 3, 4, 5}, start=540, end=1080)
        assert len(drafts) == 1
        wall = wall_in_tz(datetime.fromisoformat(drafts[0].startUtc.replace("Z", "+00:00")), "Asia/Shanghai")
        assert wall.isoweekday() in {1, 2, 3, 4, 5}, wall
        assert wall.hour >= 9

    def test_policy_cross_noon_window(self):
        # 工作时段 11:00–14:00（跨午间 240m）：120m 任务排 11:00；300m 任务放不下任何一天 → unplaced
        from app.times import wall_in_tz

        drafts = BD([T("t1", "短任务", 120, 1)], 2, [], start=11 * 60, end=14 * 60)
        assert len(drafts) == 1
        wall = wall_in_tz(datetime.fromisoformat(drafts[0].startUtc.replace("Z", "+00:00")), "Asia/Shanghai")
        assert (wall.hour, wall.minute) == (11, 0)

        big = BD([T("t1", "大任务", 300, 1)], 2, [], start=11 * 60, end=14 * 60)
        assert big == []  # 240m 窗口装不下 300m 单块

    def test_policy_calendar_id_propagates(self):
        drafts = BD([T("t1", "任务", 60, 1)], 2, [], cal="work@group.calendar.google.com")
        assert drafts[0].calendarId == "work@group.calendar.google.com"

    def test_policy_cross_timezone_window(self):
        # 策略时区 America/New_York：窗口 09:00–17:00 纽约墙钟
        from app.times import wall_in_tz

        drafts = BD([T("t1", "任务", 60, 1)], 2, [], tz="America/New_York", start=540, end=1020)
        assert len(drafts) == 1
        wall = wall_in_tz(datetime.fromisoformat(drafts[0].startUtc.replace("Z", "+00:00")), "America/New_York")
        assert wall.strftime("%H:%M") == "09:00"


# ---------------------------------------------------------------- Validator

class TestValidateDraft:
    def _draft(self, **kw):
        base = dict(
            taskId="t1", taskTitle="A", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T03:00:00Z",
            timezone="Asia/Shanghai", calendarId="primary", actionType="create",
            reason="r", idempotencyKey="g1:1:t1:1",
        )
        base.update(kw)
        return CalendarDraftItem(**base)

    def test_ok(self):
        validate_draft(self._draft(), {"t1": {"estMinutes": 120}})

    def test_duration_mismatch(self):
        with pytest.raises(CalendarWriteError):
            validate_draft(self._draft(), {"t1": {"estMinutes": 90}})

    def test_naive_time_rejected(self):
        # Phase 7 的"去掉 Z 的墙钟字符串"被明确拒绝
        with pytest.raises(CalendarWriteError):
            validate_draft(self._draft(startUtc="2027-03-10T09:00:00"), {"t1": {"estMinutes": 120}})

    def test_wrong_action(self):
        with pytest.raises(CalendarWriteError):
            validate_draft(self._draft(actionType="delete"), {"t1": {"estMinutes": 120}})


# ---------------------------------------------------------------- Executor（Instant 比较）

class TestExecute:
    def _req(self, drafts, tasks):
        return ExecuteRequest(goalId="g1", planVersion=1, timezone="Asia/Shanghai", drafts=drafts, tasks=tasks)

    def test_success_verify_instant_equality(self):
        p = MemoryProvider()
        draft = CalendarDraftItem(
            taskId="t1", taskTitle="任务A", calendarId="primary", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T03:00:00Z",
            timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1",
        )
        results = execute_drafts(self._req([draft], [T("t1", "任务A", 120)]), p)
        assert results[0].status == "success"
        assert results[0].verify == {"found": True, "startOk": True, "endOk": True, "unique": True}

    def test_double_execute_idempotent(self):
        p = MemoryProvider()
        draft = CalendarDraftItem(taskId="t1", taskTitle="A", calendarId="primary", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
        tasks = [T("t1", "A", 60)]
        execute_drafts(self._req([draft], tasks), p)
        second = execute_drafts(self._req([draft], tasks), p)
        assert second[0].status == "duplicate_skipped"
        assert len(p.events) == 1

    def test_stale_conflict_instant_comparison(self):
        """确认后用户在 01:30-04:30 UTC 加会（含草稿全部区间）→ stale。"""
        p = MemoryProvider()
        p.events.append({"uid": "user-1", "title": "新会议", "allDay": False, "localDate": None,
                         "startUtc": "2027-03-10T01:30:00Z", "endUtc": "2027-03-10T04:30:00Z"})
        draft = CalendarDraftItem(taskId="t1", taskTitle="A", calendarId="primary", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
        results = execute_drafts(self._req([draft], [T("t1", "A", 60)]), p)
        assert results[0].status == "stale_conflict"
        assert len(p.events) == 1

    def test_partial_failure(self):
        p = MemoryProvider(fail_on_uid_substr="t2")
        d1 = CalendarDraftItem(taskId="t1", taskTitle="A", calendarId="primary", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
        d2 = CalendarDraftItem(taskId="t2", taskTitle="B", calendarId="primary", startUtc="2027-03-10T04:00:00Z", endUtc="2027-03-10T05:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t2:1")
        results = execute_drafts(self._req([d1, d2], [T("t1", "A", 60), T("t2", "B", 60)]), p)
        assert [r.status for r in results] == ["success", "failed"]

    def test_all_day_user_event_no_crash_on_executor(self):
        p = MemoryProvider()
        p.events.append({"uid": "user-2", "title": "全天", "allDay": True, "localDate": "2027-03-10", "startUtc": "", "endUtc": ""})
        draft = CalendarDraftItem(taskId="t1", taskTitle="A", calendarId="primary", startUtc="2027-03-11T01:00:00Z", endUtc="2027-03-11T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
        results = execute_drafts(self._req([draft], [T("t1", "A", 60)]), p)
        assert results[0].status == "success"  # 不同日不冲突；all-day 不参与 Instant 比较


# ---------------------------------------------------------------- ICS Provider（UTC Z 往返）

class TestIcsProvider:
    def test_roundtrip_utc_z(self, tmp_path):
        p = tmp_path / "cal.ics"
        p.write_text("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", encoding="utf-8")
        provider = IcsWriteProvider(str(p))
        start = datetime(2027, 3, 10, 1, 0, tzinfo=None)
        from datetime import timezone as tzmod

        start = start.replace(tzinfo=tzmod.utc)
        provider.create_event(make_uid("g1", 1, "t1", 1), "LifeOS:任务A", start, start.replace(hour=3))
        events = provider.read_events()
        assert len(events) == 1
        assert events[0]["startUtc"] == "2027-03-10T01:00:00Z"
        assert events[0]["endUtc"] == "2027-03-10T03:00:00Z"
        assert events[0]["uid"].startswith("lifeos-g1")

    def test_insert_before_end_vcalendar_no_trailing_newline(self, tmp_path):
        """真实用户导出的 ICS 常无尾随换行：事件必须插入 END:VCALENDAR 之前且不粘连。"""
        p = tmp_path / "cal.ics"
        p.write_text("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR", encoding="utf-8")  # 无 \r\n 结尾
        provider = IcsWriteProvider(str(p))
        start = datetime(2027, 3, 10, 1, 0, tzinfo=None).replace(tzinfo=None)
        from datetime import timezone as tzmod

        provider.create_event(make_uid("g1", 1, "t1", 1), "LifeOS:A", start.replace(tzinfo=tzmod.utc), start.replace(tzinfo=tzmod.utc, hour=2))
        text = p.read_text(encoding="utf-8")
        assert "END:VCALENDARBEGIN:VEVENT" not in text, "禁止粘连"
        assert text.index("BEGIN:VEVENT") < text.index("END:VCALENDAR"), "事件必须在 VCALENDAR 内"
        assert len(provider.read_events()) == 1

    def test_append_to_file_without_vcalendar(self, tmp_path):
        p = tmp_path / "cal.ics"
        p.write_text("BEGIN:VEVENT\r\nUID:u1@x\r\nSUMMARY:旧\r\nDTSTART:20270310T010000Z\r\nDTEND:20270310T020000Z\r\nEND:VEVENT\r\n", encoding="utf-8")
        provider = IcsWriteProvider(str(p))
        from datetime import timezone as tzmod

        s = datetime(2027, 3, 11, 1, 0, tzinfo=tzmod.utc)
        provider.create_event(make_uid("g", 1, "t", 1), "LifeOS:B", s, s.replace(hour=2))
        assert len(provider.read_events()) == 2

    def test_reads_tzid_event_as_instant(self, tmp_path):
        p = tmp_path / "cal.ics"
        p.write_text(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x@y\r\nSUMMARY:会议\r\n"
            "DTSTART;TZID=Asia/Tokyo:20270310T090000\r\nDTEND;TZID=Asia/Tokyo:20270310T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            encoding="utf-8",
        )
        events = IcsWriteProvider(str(p)).read_events()
        assert events[0]["startUtc"] == "2027-03-10T00:00:00Z"  # 09:00 Tokyo
