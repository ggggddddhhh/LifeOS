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
        drafts = build_drafts([T("t1", "任务A", 120, 1)], 2, [busy_utc(0, 9, 13, "Asia/Tokyo")], "g1", 1, "Asia/Tokyo")
        assert len(drafts) == 1
        assert drafts[0].timezone == "Asia/Tokyo"
        # 13:00 Tokyo = 04:00 UTC
        assert drafts[0].startUtc.endswith("T04:00:00Z")
        assert drafts[0].idempotencyKey == "g1:1:t1:1"

    def test_busy_in_other_tz_blocks_correctly(self):
        # 会议以上海 17:00-19:00 表达（= Tokyo 18:00-20:00），规划 Tokyo：当天 08-18 仍可容纳 300min
        drafts = build_drafts([T("t1", "任务", 300, 1)], 2, [busy_utc(0, 17, 19, "Asia/Shanghai")], "g1", 1, "Asia/Tokyo")
        assert len(drafts) == 1
        from app.times import wall_in_tz

        start_wall = wall_in_tz(datetime.fromisoformat(drafts[0].startUtc.replace("Z", "+00:00")), "Asia/Tokyo")
        assert start_wall.strftime("%H:%M") == "08:00"  # Tokyo 墙钟 08:00 起排

    def test_all_day_local_date_blocks_day(self):
        from datetime import date

        busy = [{"startUtc": "", "endUtc": "", "allDay": True, "localDate": date.today().isoformat()}]
        drafts = build_drafts([T("t1", "任务", 60, 1)], 2, busy, "g1", 1, "Asia/Shanghai")
        assert drafts[0].startUtc > f"{date.today().isoformat()}T"  # 次日

    def test_periodic_occurrences(self):
        drafts = build_drafts([T("t1", "每日训练", 30, 2, dur=3)], 5, [], "g1", 1, "Asia/Shanghai")
        assert len(drafts) == 3 and len({d.idempotencyKey for d in drafts}) == 3

    def test_unplaced_when_full(self):
        busy = [busy_utc(i, 0, 24) for i in range(3)]
        drafts = build_drafts([T("t1", "大任务", 600, 1)], 3, busy, "g1", 1, "Asia/Shanghai")
        assert drafts == []

    def test_cross_midnight_event_blocks_both_windows(self):
        # 19:00-次日10:00 的跨午夜事件：当天窗口 08-20 剩 08-19，次日剩 10-20
        drafts = build_drafts([T("t1", "任务", 600, 1)], 3, [busy_utc(0, 19, 24), busy_utc(1, 0, 10)], "g1", 1, "Asia/Shanghai")
        assert len(drafts) == 1
        assert drafts[0].startUtc.startswith((datetime.fromisoformat(drafts[0].startUtc)).strftime("%Y-%m-%d"))  # 当天 08:00 起连续 600min


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
            taskId="t1", taskTitle="任务A", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T03:00:00Z",
            timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1",
        )
        results = execute_drafts(self._req([draft], [T("t1", "任务A", 120)]), p)
        assert results[0].status == "success"
        assert results[0].verify == {"found": True, "startOk": True, "endOk": True, "unique": True}

    def test_double_execute_idempotent(self):
        p = MemoryProvider()
        draft = CalendarDraftItem(taskId="t1", taskTitle="A", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
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
        draft = CalendarDraftItem(taskId="t1", taskTitle="A", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
        results = execute_drafts(self._req([draft], [T("t1", "A", 60)]), p)
        assert results[0].status == "stale_conflict"
        assert len(p.events) == 1

    def test_partial_failure(self):
        p = MemoryProvider(fail_on_uid_substr="t2")
        d1 = CalendarDraftItem(taskId="t1", taskTitle="A", startUtc="2027-03-10T01:00:00Z", endUtc="2027-03-10T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
        d2 = CalendarDraftItem(taskId="t2", taskTitle="B", startUtc="2027-03-10T04:00:00Z", endUtc="2027-03-10T05:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t2:1")
        results = execute_drafts(self._req([d1, d2], [T("t1", "A", 60), T("t2", "B", 60)]), p)
        assert [r.status for r in results] == ["success", "failed"]

    def test_all_day_user_event_no_crash_on_executor(self):
        p = MemoryProvider()
        p.events.append({"uid": "user-2", "title": "全天", "allDay": True, "localDate": "2027-03-10", "startUtc": "", "endUtc": ""})
        draft = CalendarDraftItem(taskId="t1", taskTitle="A", startUtc="2027-03-11T01:00:00Z", endUtc="2027-03-11T02:00:00Z", timezone="Asia/Shanghai", actionType="create", idempotencyKey="g1:1:t1:1")
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
