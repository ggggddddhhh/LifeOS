"""Phase 7：Calendar 写入闭环测试（排期/校验/幂等/冲突/部分失败/verify/安全）。"""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta

import pytest

from app.calendar_write import (
    CalendarWriteError,
    IcsWriteProvider,
    build_drafts,
    execute_drafts,
    make_uid,
    parse_uid_source,
    validate_draft,
)
from app.schemas import CalendarDraftItem, ExecuteRequest


def T(task_id, title, est, pri=2, dur=None):
    return {"taskId": task_id, "title": title, "estMinutes": est, "priority": pri, **({"durationDays": dur} if dur else {})}


class MemoryProvider:
    provider_name = "memory"

    def __init__(self, fail_on_uid_substr: str | None = None):
        self.events: list[tuple[str, datetime, datetime, str]] = []
        self.fail_on = fail_on_uid_substr

    def read_events(self):
        return list(self.events)

    def create_event(self, uid, title, start, end):
        if self.fail_on and self.fail_on in uid:
            raise CalendarWriteError("CAL_SERVER", "simulated 5xx")
        self.events.append((uid, start, end, title))


def ev(day_offset: int, h1: int, h2: int) -> tuple[datetime, datetime]:
    d = date.today() + timedelta(days=day_offset)
    return (datetime.combine(d, time(h1)), datetime.combine(d, time(h2)))


# ---------------------------------------------------------------- Draft Builder（事件级空闲窗口）

class TestBuildDrafts:
    def test_places_around_busy_days(self):
        # 前 2 天 09-20 全占 → 排到第 3 天
        busy = [ev(0, 8, 20), ev(1, 8, 20)]
        drafts = build_drafts([T("t1", "任务A", 120, 1)], 3, busy, "g1", 1)
        assert len(drafts) == 1
        d = drafts[0]
        assert d.proposedStart[:10] == (date.today() + timedelta(days=2)).isoformat()
        assert d.idempotencyKey == "g1:1:t1:1"
        assert d.actionType == "create"

    def test_places_in_free_gap_within_day(self):
        # 上午 09-13 开会 → 120min 任务排 13:00
        busy = [ev(0, 9, 13)]
        drafts = build_drafts([T("t1", "任务A", 120, 1)], 2, busy, "g1", 1)
        assert drafts[0].proposedStart.endswith("13:00:00")
        assert drafts[0].proposedEnd.endswith("15:00:00")

    def test_never_overlaps_partial_busy(self):
        # 一天两段会（09-13、14-18）→ 空档 08-09/13-14 各 60min、18-20 共 120min；90min 任务排 18:00
        busy = [ev(0, 9, 13), ev(0, 14, 18)]
        drafts = build_drafts([T("t1", "任务A", 90, 1)], 2, busy, "g1", 1)
        assert drafts[0].proposedStart.endswith("18:00:00")  # 唯一容得下的空档
        assert drafts[0].proposedEnd.endswith("19:30:00")

    def test_priority_first_fills_gap_then_next_day(self):
        busy = [ev(0, 8, 12)]  # 当天 12-20 共 480min 可用
        drafts = build_drafts([T("t1", "高优先", 400, 1), T("t2", "中优先", 150, 2)], 2, busy, "g1", 1)
        by_task = {d.taskId: d.proposedStart[:10] for d in drafts}
        assert by_task["t1"] == date.today().isoformat()
        assert by_task["t2"] == (date.today() + timedelta(days=1)).isoformat()  # 剩 80 放不下 150

    def test_periodic_task_spreads_days(self):
        drafts = build_drafts([T("t1", "每日训练", 30, 2, dur=3)], 5, [], "g1", 1)
        assert len(drafts) == 3
        assert len({d.idempotencyKey for d in drafts}) == 3

    def test_unplaced_when_no_room(self):
        busy = [ev(i, 8, 20) for i in range(3)]
        drafts = build_drafts([T("t1", "大任务", 600, 1)], 3, busy, "g1", 1)
        assert drafts == []

    def test_all_day_event_blocks_day(self):
        busy = [ev(0, 0, 23)]
        drafts = build_drafts([T("t1", "任务", 60, 1)], 2, busy, "g1", 1)
        assert drafts[0].proposedStart[:10] == (date.today() + timedelta(days=1)).isoformat()

    def test_aware_datetimes_normalized(self):
        from datetime import timezone

        d0 = datetime.combine(date.today(), time(9)).replace(tzinfo=timezone.utc)
        drafts = build_drafts([T("t1", "任务", 60, 1)], 2, [(d0, d0 + timedelta(hours=2))], "g1", 1)
        assert len(drafts) == 1  # 不因 aware/naive 混比崩溃


# ---------------------------------------------------------------- Validator

class TestValidateDraft:
    def _draft(self, **kw):
        base = dict(
            taskId="t1", taskTitle="A", proposedStart="2026-09-10T09:00:00",
            proposedEnd="2026-09-10T11:00:00", calendarId="primary", actionType="create",
            reason="r", idempotencyKey="g1:1:t1:1",
        )
        base.update(kw)
        return CalendarDraftItem(**base)

    def test_ok(self):
        validate_draft(self._draft(), {"t1": {"estMinutes": 120}})

    def test_wrong_action_rejected(self):
        with pytest.raises(CalendarWriteError):
            validate_draft(self._draft(actionType="delete"), {"t1": {"estMinutes": 120}})

    def test_duration_mismatch_rejected(self):
        with pytest.raises(CalendarWriteError):
            validate_draft(self._draft(), {"t1": {"estMinutes": 90}})

    def test_bad_key_rejected(self):
        with pytest.raises(CalendarWriteError):
            validate_draft(self._draft(idempotencyKey="nope"), {"t1": {"estMinutes": 120}})

    def test_end_before_start_rejected(self):
        with pytest.raises(CalendarWriteError):
            validate_draft(
                self._draft(proposedStart="2026-09-10T11:00:00", proposedEnd="2026-09-10T09:00:00"),
                {"t1": {"estMinutes": 120}},
            )


# ---------------------------------------------------------------- Executor

class TestExecute:
    def _req(self, drafts, tasks):
        return ExecuteRequest(goalId="g1", planVersion=1, drafts=drafts, tasks=tasks)

    def test_success_and_verify(self):
        p = MemoryProvider()
        draft = CalendarDraftItem(
            taskId="t1", taskTitle="任务A", proposedStart="2026-09-10T09:00:00",
            proposedEnd="2026-09-10T11:00:00", actionType="create", idempotencyKey="g1:1:t1:1",
        )
        results = execute_drafts(self._req([draft], [T("t1", "任务A", 120)]), p)
        assert results[0].status == "success"
        assert results[0].verify == {"found": True, "startOk": True, "endOk": True, "unique": True}
        assert len(p.events) == 1
        uid, s, e, title = p.events[0]
        assert uid == make_uid("g1", 1, "t1", 1)
        assert title == "LifeOS:任务A"

    def test_double_execute_idempotent(self):
        """重复确认 → 不重复创建（UID 复检）。"""
        p = MemoryProvider()
        draft = CalendarDraftItem(
            taskId="t1", taskTitle="A", proposedStart="2026-09-10T09:00:00",
            proposedEnd="2026-09-10T10:00:00", actionType="create", idempotencyKey="g1:1:t1:1",
        )
        tasks = [T("t1", "A", 60)]
        execute_drafts(self._req([draft], tasks), p)
        second = execute_drafts(self._req([draft], tasks), p)
        assert second[0].status == "duplicate_skipped"
        assert len(p.events) == 1  # 只有一份

    def test_stale_conflict_not_written(self):
        """确认后时间段被用户占用 → stale，不硬写。"""
        p = MemoryProvider()
        # 用户在此前安排了冲突事件
        p.events.append(("user-1", datetime(2026, 9, 10, 8, 0), datetime(2026, 9, 10, 12, 0), "用户会议"))
        draft = CalendarDraftItem(
            taskId="t1", taskTitle="A", proposedStart="2026-09-10T09:00:00",
            proposedEnd="2026-09-10T10:00:00", actionType="create", idempotencyKey="g1:1:t1:1",
        )
        results = execute_drafts(self._req([draft], [T("t1", "A", 60)]), p)
        assert results[0].status == "stale_conflict"
        assert "CAL_CONFLICT" in results[0].error
        assert len(p.events) == 1  # 只有用户事件，无新增

    def test_own_lifeos_events_do_not_block(self):
        """自己的 lifeos 事件（不同 key）不作为冲突……实际上同 UID 幂等跳过；
        不同任务的 lifeos 事件在冲突复检中视为占用（保守）。"""
        p = MemoryProvider()
        p.events.append((make_uid("g1", 1, "t0", 1), datetime(2026, 9, 10, 9, 0), datetime(2026, 9, 10, 10, 0), "LifeOS:B"))
        draft = CalendarDraftItem(
            taskId="t1", taskTitle="A", proposedStart="2026-09-10T09:30:00",
            proposedEnd="2026-09-10T10:30:00", actionType="create", idempotencyKey="g1:1:t1:1",
        )
        results = execute_drafts(self._req([draft], [T("t1", "A", 60)]), p)
        # 与其他 lifeos 事件重叠 → 保守视为冲突（stale），宁可保守不硬写
        assert results[0].status == "stale_conflict"

    def test_partial_failure_reported_per_draft(self):
        """部分失败不能假装整体成功。"""
        p = MemoryProvider(fail_on_uid_substr="t2")
        d1 = CalendarDraftItem(taskId="t1", taskTitle="A", proposedStart="2026-09-10T09:00:00", proposedEnd="2026-09-10T10:00:00", actionType="create", idempotencyKey="g1:1:t1:1")
        d2 = CalendarDraftItem(taskId="t2", taskTitle="B", proposedStart="2026-09-10T11:00:00", proposedEnd="2026-09-10T12:00:00", actionType="create", idempotencyKey="g1:1:t2:1")
        results = execute_drafts(self._req([d1, d2], [T("t1", "A", 60), T("t2", "B", 60)]), p)
        by_key = {r.idempotencyKey: r.status for r in results}
        assert by_key["g1:1:t1:1"] == "success"
        assert by_key["g1:1:t2:1"] == "failed"
        assert len(p.events) == 1

    def test_invalid_draft_never_reaches_provider(self):
        p = MemoryProvider()
        bad = CalendarDraftItem(taskId="tX", taskTitle="X", proposedStart="2026-09-10T09:00:00", proposedEnd="2026-09-10T10:00:00", actionType="create", idempotencyKey="g1:1:tX:1")
        results = execute_drafts(self._req([bad], [T("t1", "A", 60)]), p)
        assert results[0].status == "failed"
        assert len(p.events) == 0


# ---------------------------------------------------------------- ICS Provider 与来源区分

class TestIcsProvider:
    def test_roundtrip_and_uid_source(self, tmp_path):
        p = tmp_path / "cal.ics"
        p.write_text("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", encoding="utf-8")
        provider = IcsWriteProvider(str(p))
        provider.create_event(make_uid("g1", 1, "t1", 1), "LifeOS:任务A", datetime(2026, 9, 10, 9, 0), datetime(2026, 9, 10, 11, 0))
        events = provider.read_events()
        assert len(events) == 1
        uid, s, e, title = events[0]
        assert uid.startswith("lifeos-g1")
        assert s == datetime(2026, 9, 10, 9, 0) and e == datetime(2026, 9, 10, 11, 0)
        assert title == "LifeOS:任务A"

    def test_uid_source_separation(self, tmp_path):
        p = tmp_path / "cal.ics"
        p.write_text(
            "BEGIN:VCALENDAR\r\n"
            "BEGIN:VEVENT\r\nUID:abc@x\r\nSUMMARY:用户会\r\nDTSTART:20260910T090000\r\nDTEND:20260910T100000\r\nEND:VEVENT\r\n"
            "BEGIN:VEVENT\r\nUID:lifeos-g1-v1-t1-o1@lifeos\r\nSUMMARY:LifeOS:任务\r\nDTSTART:20260911T090000\r\nDTEND:20260911T100000\r\nEND:VEVENT\r\n"
            "END:VCALENDAR\r\n",
            encoding="utf-8",
        )
        src = parse_uid_source(p.read_text(encoding="utf-8"))
        assert src["abc@x"] == "user"
        assert src["lifeos-g1-v1-t1-o1@lifeos"] == "lifeos"

    def test_missing_file_read_returns_empty(self):
        assert IcsWriteProvider("Z:/nope.ics").read_events() == []


# ---------------------------------------------------------------- API 层（确认制入口）

class TestApiEndpoints:
    def test_drafts_endpoint_never_writes(self, api_client, tmp_path, monkeypatch):
        monkeypatch.setenv("CAL_ICS_PATH", str(tmp_path / "cal.ics"))
        res = api_client.post("/v1/calendar/drafts", json={
            "goalId": "g1", "planVersion": 1, "daysLeft": 3,
            "tasks": [T("t1", "任务A", 120, 1)],
        })
        assert res.status_code == 200
        body = res.json()
        assert len(body["drafts"]) == 1
        assert body["unplacedTaskIds"] == []
        assert not (tmp_path / "cal.ics").exists() or "lifeos" not in (tmp_path / "cal.ics").read_text(encoding="utf-8")

    def test_execute_endpoint_requires_config(self, api_client, monkeypatch, tmp_path):
        monkeypatch.setenv("CAL_ICS_PATH", str(tmp_path / "cal.ics"))
        (tmp_path / "cal.ics").write_text("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", encoding="utf-8")
        res = api_client.post("/v1/calendar/execute", json={
            "goalId": "g1", "planVersion": 1,
            "drafts": [{
                "taskId": "t1", "taskTitle": "A", "proposedStart": "2026-09-10T09:00:00",
                "proposedEnd": "2026-09-10T10:00:00", "actionType": "create", "idempotencyKey": "g1:1:t1:1",
            }],
            "tasks": [T("t1", "A", 60)],
        })
        assert res.status_code == 200
        assert res.json()["results"][0]["status"] == "success"
        assert "lifeos-g1-v1-t1-o1@lifeos" in (tmp_path / "cal.ics").read_text(encoding="utf-8")

    def test_execute_without_cal_path_503(self, api_client, monkeypatch):
        monkeypatch.setenv("CAL_ICS_PATH", "")
        res = api_client.post("/v1/calendar/execute", json={
            "goalId": "g1", "planVersion": 1,
            "drafts": [{"taskId": "t1", "taskTitle": "A", "proposedStart": "2026-09-10T09:00:00", "proposedEnd": "2026-09-10T10:00:00", "actionType": "create", "idempotencyKey": "g1:1:t1:1"}],
            "tasks": [T("t1", "A", 60)],
        })
        assert res.status_code == 503
        assert res.json()["error"]["code"] == "CAL_AUTH_INVALID"
