"""Phase 5：Calendar 只读工具测试（六要求场景 + ICS 解析 + 容量组合 + 图独立启用分支）。"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.calendar import (
    DEFAULT_DAILY_WINDOW_MINUTES,
    IcsCalendarClient,
    StaticCalendarClient,
    analyze_capacity,
    parse_ics,
)
from app.graph import run_plan, run_replan
from app.llm import MockLLM
from app.schemas import CalendarFacts, DayBusy, GithubFacts, IssueBrief, RepoInfo
from tests.test_github import FakeGithub, make_facts as gh_facts


def day(i: int, busy: int, events: int = 0, all_day: bool = False) -> DayBusy:
    return DayBusy(date=(date.today() + timedelta(days=i)).isoformat(), busy_minutes=busy, event_count=events, all_day_event=all_day)


# ---------------------------------------------------------------- ICS 解析

class TestParseIcs:
    def test_timed_event(self):
        ics = """BEGIN:VCALENDAR
BEGIN:VEVENT
SUMMARY:周会
DTSTART:20260910T090000
DTEND:20260910T100000
END:VEVENT
END:VCALENDAR"""
        events = parse_ics(ics)
        assert len(events) == 1
        title, start, end, all_day = events[0]
        assert title == "周会"
        assert start == datetime(2026, 9, 10, 9, 0)
        assert (end - start).total_seconds() == 3600
        assert all_day is False

    def test_all_day_event(self):
        ics = "BEGIN:VEVENT\nSUMMARY:外出团建\nDTSTART:20260911\nDTEND:20260912\nEND:VEVENT"
        events = parse_ics(ics)
        assert events[0][3] is True  # all_day

    def test_folded_lines(self):
        ics = "BEGIN:VEVENT\nSUMMARY:很长的标题\n  续行\nDTSTART:20260910T090000\nDTEND:20260910T093000\nEND:VEVENT"
        events = parse_ics(ics)
        assert events[0][0] == "很长的标题续行"

    def test_ics_client_reads_file(self, tmp_path):
        today = date.today()
        ics = f"BEGIN:VEVENT\nSUMMARY:评审会\nDTSTART:{today.strftime('%Y%m%d')}T140000\nDTEND:{today.strftime('%Y%m%d')}T160000\nEND:VEVENT"
        p = tmp_path / "cal.ics"
        p.write_text(ics, encoding="utf-8")
        facts = IcsCalendarClient(str(p)).fetch_facts(7)
        assert facts.ok
        assert facts.days[0].busy_minutes == 120
        assert facts.days[0].event_count == 1
        assert all(d.busy_minutes == 0 for d in facts.days[1:])

    def test_missing_file_degrades(self):
        facts = IcsCalendarClient("Z:/不存在/cal.ics").fetch_facts(7)
        assert facts.ok is False
        assert facts.error


# ---------------------------------------------------------------- 六个要求场景

class TestCapacityScenarios:
    def test_all_day_meetings(self):
        """全天有会议：该日推断可用 0。"""
        facts = StaticCalendarClient([day(0, DEFAULT_DAILY_WINDOW_MINUTES, 3, all_day=True)]).fetch_facts(7)
        cap = analyze_capacity(facts, 7, None)
        assert cap.available
        assert cap.per_day_inferred[0] == 0
        assert any("全天事件" in s for s in cap.signals)

    def test_half_day_free(self):
        """半天空闲：忙碌 360 → 推断可用 360。"""
        facts = StaticCalendarClient([day(0, 360, 4)]).fetch_facts(7)
        cap = analyze_capacity(facts, 7, None)
        assert cap.per_day_inferred[0] == 360

    def test_weekend_fully_free(self):
        """周末完全空闲：忙碌 0 → 推断可用 = 全窗口。"""
        facts = StaticCalendarClient([day(0, 0, 0), day(1, 0, 0)]).fetch_facts(7)
        cap = analyze_capacity(facts, 2, None)
        assert cap.per_day_inferred == [DEFAULT_DAILY_WINDOW_MINUTES] * 2
        assert cap.capacity_minutes == 2 * DEFAULT_DAILY_WINDOW_MINUTES

    def test_conflict_with_declaration(self):
        """Calendar 与用户声明冲突：显式标注，声明优先。"""
        facts = StaticCalendarClient([day(0, 600, 5)]).fetch_facts(7)  # 推断 120
        cap = analyze_capacity(facts, 1, [480])  # 用户声明 480
        assert cap.source == "declared+calendar"
        assert cap.per_day_effective == [480]  # 声明优先
        assert len(cap.conflicts) == 1
        assert cap.conflicts[0].declared_minutes == 480
        assert cap.conflicts[0].inferred_minutes == 120
        assert any("冲突" in s for s in cap.signals)

    def test_calendar_unavailable(self):
        """Calendar API 不可用：available=False → 完全回退默认行为。"""
        facts = CalendarFacts(ok=False, error="HTTPError: 503")
        cap = analyze_capacity(facts, 5, None)
        assert cap.available is False
        assert cap.source == "default"

    def test_no_events(self):
        """无事件（但日历可用）：推断 = 全窗口。"""
        facts = StaticCalendarClient([]).fetch_facts(7)
        cap = analyze_capacity(facts, 7, None)
        assert cap.available
        assert cap.source == "calendar_inferred"

    def test_focal_pattern_3x1h_4x4h(self):
        """重点场景：前 3 天每天 1h 空闲，后 4 天每天 4h → 容量 3×60+4×240=1140。"""
        days = [day(i, DEFAULT_DAILY_WINDOW_MINUTES - 60) for i in range(3)] + \
               [day(i, DEFAULT_DAILY_WINDOW_MINUTES - 240) for i in range(3, 7)]
        facts = StaticCalendarClient(days).fetch_facts(7)
        cap = analyze_capacity(facts, 7, None)
        assert cap.capacity_minutes == 3 * 60 + 4 * 240

    def test_declaration_only(self):
        cap = analyze_capacity(None, 5, [120] * 5)
        assert cap.source == "declared"
        assert cap.capacity_minutes == 600


# ---------------------------------------------------------------- 图分支：工具独立启用

REPLAN_REQ = {
    "goalTitle": "7 天内上线",
    "goalDescription": "repo:lifeos/demo",
    "daysLeft": 5,
    "tasks": [{"title": "实现登录", "status": "todo", "estMinutes": 240, "priority": 1}],
}


class TestGraphToolIndependence:
    def test_calendar_only(self):
        cal = StaticCalendarClient([day(0, 660, 6)])
        state = run_replan(REPLAN_REQ, MockLLM(), github=None, calendar=cal)
        assert state.get("github") is None  # GitHub 未启用（无 repo 字段写入）
        assert state["capacity"]["capacity_minutes"] > 0
        assert state.get("error_code") is None

    def test_github_only_no_capacity(self):
        gh = FakeGithub(gh_facts(open_issue_titles=["实现登录"]))
        state = run_replan(REPLAN_REQ, MockLLM(), github=gh, calendar=None)
        assert state["github"]["ok"] is True
        assert state.get("capacity") is None  # 无日历无声明 → 不注入容量（保持现有行为）
        assert state.get("error_code") is None

    def test_both_tools(self):
        gh = FakeGithub(gh_facts(open_issue_titles=["实现登录"]))
        cal = StaticCalendarClient([day(0, 660, 6)])
        state = run_replan(REPLAN_REQ, MockLLM(), github=gh, calendar=cal)
        assert state["github"]["ok"] and state["capacity"]["available"]
        assert state.get("error_code") is None

    def test_calendar_exception_degrades(self):
        class Exploding:
            def fetch_facts(self, days):
                raise RuntimeError("boom")

        state = run_replan(REPLAN_REQ, MockLLM(), github=None, calendar=Exploding())
        assert state.get("error_code") is None  # graph 不失败
        assert state["calendar"]["ok"] is False
        assert state["capacity"] is None  # 无容量 → 默认行为

    def test_declared_capacity_flows_into_payload_and_state(self):
        import json

        captured = {}

        from app.llm import ScriptedLLM

        class Capturing(ScriptedLLM):
            def complete(self, system, user):
                captured["user"] = user
                return super().complete(system, user)

        good = json.dumps({"reason": "按真实容量重排", "tasks": [{"title": "实现登录", "priority": 1, "estMinutes": 60}]})
        req = dict(REPLAN_REQ, declaredMinutesPerDay=[60, 60, 60, 240, 240])
        state = run_replan(req, Capturing([good]), github=None, calendar=None)
        payload = json.loads(captured["user"])
        assert payload["capacity"]["capacity_minutes"] == 60 * 3 + 240 * 2
        assert "capacity_usage" in payload
        assert state["capacity"]["source"] == "declared"
