"""Calendar 只读工具（Phase 5 起；Phase 7.5 升级为 Instant + IANA 时区语义）。

- 只读取（ICS 文件解析，v1 真实数据源），绝不创建/修改/删除事件
- ICS TZID 解析与 canonical 转换见 times.py（唯一实现点）
- DayBusy 按规划时区日历日统计；all-day 保持 LocalDate 语义
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from typing import Protocol

from .schemas import (
    CalendarEvent,
    CalendarFacts,
    CapacityConflict,
    CapacityReport,
    DayBusy,
)
from .times import (
    DEFAULT_PLANNING_TZ,
    overlaps,
    parse_ics_dtstart,
    today_in,
    to_utc,
    wall_in_tz,
    WallToInstant,
    work_window,
    _unfold_lines,
)

# Agent 推断参数：每日总可支配窗口（墙钟分钟数，规划时区）
DEFAULT_DAILY_WINDOW_MINUTES = 720
DEFAULT_CAPACITY_PER_DAY = 480
CONFLICT_TOLERANCE_MINUTES = 60


class CalendarClient(Protocol):
    def fetch_facts(self, days: int, timezone: str = DEFAULT_PLANNING_TZ) -> CalendarFacts: ...


class _VEvent:
    __slots__ = ("uid", "title", "dtstart", "dtend", "tzid", "all_day")

    def __init__(self):
        self.uid = ""
        self.title = ""
        self.dtstart = ""
        self.dtend = ""
        self.tzid = ""
        self.all_day = False


def _parse_vevents(text: str) -> list[_VEvent]:
    events: list[_VEvent] = []
    cur: _VEvent | None = None
    for line in _unfold_lines(text):
        if line.startswith("BEGIN:VEVENT"):
            cur = _VEvent()
        elif line.startswith("END:VEVENT"):
            if cur is not None and cur.dtstart:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            head, value = line.split(":", 1)
            key = head.split(";")[0]
            params = head.split(";")[1:]
            if key == "SUMMARY":
                cur.title = value.strip()
            elif key == "UID":
                cur.uid = value.strip()
            elif key == "DTSTART":
                cur.dtstart = value
                cur.all_day = any(p.startswith("VALUE=DATE") for p in params)
                cur.tzid = next((p.split("=", 1)[1] for p in params if p.startswith("TZID=")), "")
            elif key == "DTEND":
                cur.dtend = value
    return events


def _event_minutes_on_day(ev: CalendarEvent, day: date, tz_name: str) -> int:
    """事件在规划时区某日占用的墙钟分钟（跨天按日切分）；all-day = 整日阻塞。"""
    if ev.all_day:
        return ev.local_date == day.isoformat()
    s = datetime.fromisoformat(ev.startUtc)
    e = datetime.fromisoformat(ev.endUtc)
    ws, we = work_window(day)
    ws_utc = to_utc(ws, tz_name).instant
    we_utc = to_utc(we, tz_name).instant
    ov = min(e, we_utc) - max(s, ws_utc)
    return max(0, int(ov.total_seconds() // 60))


class IcsCalendarClient:
    """从本地 ICS 文件读取（用户从任意日历导出）。CAL_ICS_PATH 指定路径。"""

    def __init__(self, path: str | None = None, daily_window_minutes: int | None = None):
        self.path = path or os.environ.get("CAL_ICS_PATH", "")
        self.daily_window = daily_window_minutes or int(os.environ.get("CAL_DAILY_WINDOW_MINUTES", DEFAULT_DAILY_WINDOW_MINUTES))

    def fetch_facts(self, days: int, timezone: str = DEFAULT_PLANNING_TZ) -> CalendarFacts:
        fetched_at = datetime.now().astimezone().isoformat(timespec="seconds")
        try:
            with open(self.path, encoding="utf-8") as f:
                raw = _parse_vevents(f.read())
        except OSError as e:
            return CalendarFacts(ok=False, error=f"{type(e).__name__}: {e}", window_days=days, fetched_at=fetched_at)

        events: list[CalendarEvent] = []
        for ve in raw:
            source = "lifeos" if ve.uid.startswith("lifeos-") else "user"
            try:
                start = parse_ics_dtstart(ve.dtstart, ve.tzid or None, timezone)
            except ValueError:
                continue
            if isinstance(start, str):
                # all-day：LocalDate 语义，不转 Instant（存储用当日窗口 Instant 占位以便统一处理）
                events.append(CalendarEvent(
                    title=ve.title or "(无标题)", startUtc="", endUtc="", timezone=timezone,
                    all_day=True, local_date=start, source=source,
                ))
                continue
            end_wall = WallToInstant(instant=start.instant)
            if ve.dtend:
                try:
                    parsed_end = parse_ics_dtstart(ve.dtend, ve.tzid or None, timezone)
                    if isinstance(parsed_end, WallToInstant):
                        end_wall = parsed_end
                except ValueError:
                    pass
            if end_wall.instant <= start.instant:
                end_wall = WallToInstant(instant=start.instant + timedelta(hours=1))
            events.append(CalendarEvent(
                title=ve.title or "(无标题)",
                startUtc=start.instant.isoformat(timespec="seconds").replace("+00:00", "Z"),
                endUtc=end_wall.instant.isoformat(timespec="seconds").replace("+00:00", "Z"),
                timezone=ve.tzid or timezone,
                source=source,
                ambiguous=start.ambiguous or end_wall.ambiguous,
                nonexistent=start.nonexistent or end_wall.nonexistent,
            ))
            if len(events) >= 100:
                break

        # DayBusy：规划时区日历日
        base = today_in(timezone)
        window_days = [base + timedelta(days=i) for i in range(days)]
        by_date = {d: DayBusy(date=d.isoformat()) for d in window_days}
        for ev in events:
            if ev.all_day:
                if ev.local_date and date.fromisoformat(ev.local_date) in by_date:
                    db = by_date[date.fromisoformat(ev.local_date)]
                    db.all_day_event = True
                    db.busy_minutes = self.daily_window
                    db.event_count += 1
                continue
            s = datetime.fromisoformat(ev.startUtc)
            for d in window_days:
                minutes = _event_minutes_on_day(ev, d, timezone)
                if minutes > 0:
                    by_date[d].busy_minutes += minutes
                    by_date[d].event_count += 1

        return CalendarFacts(
            ok=True,
            days=[by_date[d] for d in window_days],
            events=events[:50],
            window_days=days,
            fetched_at=fetched_at,
        )


class StaticCalendarClient:
    """测试/评测注入：直接给定 DayBusy 列表（日级，用于容量分析）。"""

    def __init__(self, days: list[DayBusy], daily_window_minutes: int = DEFAULT_DAILY_WINDOW_MINUTES):
        self._days = days
        self.daily_window = daily_window_minutes

    def fetch_facts(self, days: int, timezone: str = DEFAULT_PLANNING_TZ) -> CalendarFacts:
        padded = self._days[:days]
        last_date = date.fromisoformat(padded[-1].date) if padded else today_in(timezone)
        avg_busy = round(sum(d.busy_minutes for d in padded) / max(1, len(padded)))
        while len(padded) < days:
            last_date = last_date + timedelta(days=1)
            padded.append(DayBusy(date=last_date.isoformat(), busy_minutes=avg_busy))
        return CalendarFacts(
            ok=True,
            days=padded,
            events=[],
            window_days=days,
            fetched_at=datetime.now().astimezone().isoformat(timespec="seconds"),
        )


# ---------------------------------------------------------------- 容量分析（确定性）

def analyze_capacity(
    facts: CalendarFacts | None,
    days_left: int,
    declared: list[int] | None,
    daily_window_minutes: int = DEFAULT_DAILY_WINDOW_MINUTES,
) -> CapacityReport:
    """三层语义：声明 > 推断 > 默认。声明与推断冲突显式标注（不静默覆盖声明）。"""
    has_declared = declared is not None and len(declared) > 0
    inferred: list[int] | None = None
    signals: list[str] = []

    if facts is not None and facts.ok and facts.days:
        inferred = [max(0, daily_window_minutes - d.busy_minutes) for d in facts.days[:days_left]]
        while len(inferred) < days_left:
            avg = round(sum(inferred) / max(1, len(inferred)))
            inferred.append(avg)
        busy_days = [d for d in facts.days[:days_left] if d.busy_minutes > 0]
        signals.append(f"日历观察（{min(days_left, facts.window_days)} 天）：{len(busy_days)} 天有事件，日均推断可用 {round(sum(inferred) / len(inferred))} 分钟")
        dense = [d for d in facts.days[:days_left] if d.event_count >= 5]
        if dense:
            signals.append(f"会议密集日（≥5 事件）: {'、'.join(d.date for d in dense[:5])}")
        full = [d for d in facts.days[:days_left] if d.all_day_event]
        if full:
            signals.append(f"全天事件日（推断可用 0 分钟）: {'、'.join(d.date for d in full[:5])}")
        amb = [e for e in facts.events if e.ambiguous or e.nonexistent]
        if amb:
            signals.append(f"{len(amb)} 个事件的本地时间处于 DST 边界（已按 canonical 规则处理并标记）")
    elif facts is not None and not facts.ok:
        signals.append(f"日历数据不可用: {facts.error or '未知'}")

    if has_declared and inferred is not None:
        effective = [declared[i] if i < len(declared) else declared[-1] for i in range(days_left)]
        source = "declared+calendar"
    elif has_declared:
        effective = [declared[i] if i < len(declared) else declared[-1] for i in range(days_left)]
        source = "declared"
    elif inferred is not None:
        effective = inferred
        source = "calendar_inferred"
    else:
        return CapacityReport(available=False, source="default", signals=signals)

    conflicts: list[CapacityConflict] = []
    if has_declared and inferred is not None:
        for i in range(days_left):
            dec = effective[i]
            inf = inferred[i]
            if dec > inf + CONFLICT_TOLERANCE_MINUTES:
                dt = (today_in(DEFAULT_PLANNING_TZ) + timedelta(days=i)).isoformat()
                conflicts.append(CapacityConflict(
                    day_index=i + 1, date=dt, declared_minutes=dec, inferred_minutes=inf,
                    note=f"第 {i + 1} 天用户声明可投入 {dec} 分钟，但日历推断仅 {inf} 分钟（忙碌 {daily_window_minutes - inf} 分钟）",
                ))
    if conflicts:
        signals.append(f"{len(conflicts)} 天的声明容量与日历推断冲突（已按用户声明规划并标注风险，建议用户确认）")

    return CapacityReport(
        available=True,
        source=source,
        per_day_effective=effective,
        per_day_declared=declared[:days_left] if has_declared else None,
        per_day_inferred=inferred,
        capacity_minutes=sum(effective),
        window_days=days_left,
        daily_window_minutes=daily_window_minutes,
        conflicts=conflicts,
        signals=signals,
    )
