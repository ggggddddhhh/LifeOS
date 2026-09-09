"""Phase 7.5：Calendar 读取的时区语义测试（TZID/UTC-Z/全天/floating/DST 标记）。"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.calendar import DEFAULT_DAILY_WINDOW_MINUTES, IcsCalendarClient, StaticCalendarClient, analyze_capacity
from app.schemas import CalendarFacts, DayBusy


def day(i: int, busy: int, events: int = 0, all_day: bool = False) -> DayBusy:
    return DayBusy(date=(date.today() + timedelta(days=i)).isoformat(), busy_minutes=busy, event_count=events, all_day_event=all_day)


def _ics_with(vevent: str) -> str:
    return f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{vevent}\r\nEND:VCALENDAR"


class TestIcsTimezoneSemantics:
    def test_tzid_event_becomes_instant(self, tmp_path):
        today = date.today().strftime("%Y%m%d")
        ics = _ics_with(
            f"BEGIN:VEVENT\r\nSUMMARY:上海晨会\r\nDTSTART;TZID=Asia/Shanghai:{today}T090000\r\nDTEND;TZID=Asia/Shanghai:{today}T100000\r\nEND:VEVENT"
        )
        p = tmp_path / "c.ics"
        p.write_text(ics, encoding="utf-8")
        facts = IcsCalendarClient(str(p)).fetch_facts(7, "Asia/Tokyo")
        assert facts.ok
        ev = facts.events[0]
        assert ev.timezone == "Asia/Shanghai"
        # 09:00 上海 = 01:00 UTC（与规划时区 Tokyo 无关）
        assert ev.startUtc == f"{date.today().isoformat()}T01:00:00Z"
        assert ev.endUtc == f"{date.today().isoformat()}T02:00:00Z"
        assert ev.source == "user"
        # 规划时区 Tokyo（+9）下：10:00-11:00 → 当天忙碌 60min
        assert facts.days[0].busy_minutes == 60

    def test_utc_z_event(self, tmp_path):
        today = date.today().strftime("%Y%m%d")
        ics = _ics_with(
            f"BEGIN:VEVENT\r\nSUMMARY:UTC 会\r\nDTSTART:{today}T010000Z\r\nDTEND:{today}T020000Z\r\nEND:VEVENT"
        )
        p = tmp_path / "c.ics"
        p.write_text(ics, encoding="utf-8")
        facts = IcsCalendarClient(str(p)).fetch_facts(7, "Asia/Shanghai")
        ev = facts.events[0]
        assert ev.startUtc == f"{date.today().isoformat()}T01:00:00Z"
        # 上海 09:00-10:00 → busy 60
        assert facts.days[0].busy_minutes == 60

    def test_all_day_keeps_local_date_semantics(self, tmp_path):
        today = date.today().strftime("%Y%m%d")
        ics = _ics_with(
            f"BEGIN:VEVENT\r\nSUMMARY:外出\r\nDTSTART;VALUE=DATE:{today}\r\nDTEND;VALUE=DATE:{today}\r\nEND:VEVENT"
        )
        p = tmp_path / "c.ics"
        p.write_text(ics, encoding="utf-8")
        facts = IcsCalendarClient(str(p)).fetch_facts(7, "Asia/Shanghai")
        ev = facts.events[0]
        assert ev.all_day is True
        assert ev.local_date == date.today().isoformat()
        assert ev.startUtc == ""  # 不用 00:00 模拟
        assert facts.days[0].all_day_event is True  # 当天阻塞
        assert facts.days[1].busy_minutes == 0

    def test_floating_time_uses_planning_tz(self, tmp_path):
        today = date.today().strftime("%Y%m%d")
        ics = _ics_with(f"BEGIN:VEVENT\r\nSUMMARY:浮动\r\nDTSTART:{today}T090000\r\nDTEND:{today}T100000\r\nEND:VEVENT")
        p = tmp_path / "c.ics"
        p.write_text(ics, encoding="utf-8")
        facts = IcsCalendarClient(str(p)).fetch_facts(7, "Asia/Tokyo")
        ev = facts.events[0]
        # 浮动 09:00 按规划时区 Tokyo 解释 = 00:00 UTC
        assert ev.startUtc == f"{date.today().isoformat()}T00:00:00Z"
        assert ev.timezone == "Asia/Tokyo"

    def test_dst_ambiguous_flagged_not_silent(self, tmp_path):
        # 2027-11-07 01:30 America/New_York（回拨出现两次）→ fold=0 + ambiguous 标记
        ics = _ics_with(
            "BEGIN:VEVENT\r\nSUMMARY:DST 会\r\nDTSTART;TZID=America/New_York:20271107T013000\r\nDTEND;TZID=America/New_York:20271107T023000\r\nEND:VEVENT"
        )
        p = tmp_path / "c.ics"
        p.write_text(ics, encoding="utf-8")
        facts = IcsCalendarClient(str(p)).fetch_facts(7, "Asia/Shanghai")
        ev = facts.events[0]
        assert ev.ambiguous is True
        assert ev.startUtc == "2027-11-07T05:30:00Z"  # fold=0（EDT -4）

    def test_lifeos_uid_marks_source(self, tmp_path):
        ics = _ics_with(
            "BEGIN:VEVENT\r\nUID:lifeos-g1-v1-t1-o1@lifeos\r\nSUMMARY:LifeOS:任务\r\nDTSTART:20270310T010000Z\r\nDTEND:20270310T020000Z\r\nEND:VEVENT"
        )
        p = tmp_path / "c.ics"
        p.write_text(ics, encoding="utf-8")
        facts = IcsCalendarClient(str(p)).fetch_facts(7, "Asia/Shanghai")
        assert facts.events[0].source == "lifeos"


class TestCapacityUnchanged:
    def test_static_client_default_tz(self):
        facts = StaticCalendarClient([day(0, 600, 5)]).fetch_facts(7)
        cap = analyze_capacity(facts, 1, [480])
        assert cap.source == "declared+calendar"
        assert cap.conflicts and cap.conflicts[0].inferred_minutes == 120

    def test_unavailable(self):
        cap = analyze_capacity(CalendarFacts(ok=False, error="x"), 5, None)
        assert cap.available is False
