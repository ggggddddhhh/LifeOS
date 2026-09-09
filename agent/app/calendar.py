"""Calendar 只读工具（Phase 5）。

- 只读取（ICS 文件解析，v1 真实数据源），绝不创建/修改/删除事件
- 与 GitHub 工具解耦：独立模块 + 依赖注入，Graph 可独立启用任一工具
- 任何失败转为 ok=False 事实对象，graph 永不因工具失败而失败
- 容量三层语义：用户声明 > Calendar 推断 > 默认 480/天；声明与推断冲突显式标注
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

# Agent 推断参数：每日总可支配窗口（清醒时间扣除必要事务的保守估计）。
# available_inferred = max(0, daily_window − busy)。非用户声明，仅推断。
DEFAULT_DAILY_WINDOW_MINUTES = 720
DEFAULT_CAPACITY_PER_DAY = 480  # 无任何数据时的系统默认（与 TS plan.ts 一致）
CONFLICT_TOLERANCE_MINUTES = 60  # 声明超出推断该值以上视为冲突


class CalendarClient(Protocol):
    def fetch_facts(self, days: int) -> CalendarFacts: ...


# ---------------------------------------------------------------- ICS 解析（只读，无第三方依赖）

def _unfold_ics(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw.startswith((" ", "\t")) and lines:
            lines[-1] += raw[1:].lstrip()
        else:
            lines.append(raw)
    return lines


def _parse_ics_dt(value: str) -> datetime | None:
    v = value.strip()
    try:
        if len(v) == 8:  # YYYYMMDD（全天事件）
            return datetime.strptime(v, "%Y%m%d")
        if "T" in v:
            core = v.split("T")[1].rstrip("Z")
            dt = datetime.strptime(f"{v.split('T')[0]}T{core}", "%Y%m%dT%H%M%S")
            return dt
        return datetime.strptime(v, "%Y%m%d")
    except ValueError:
        return None


def parse_ics(text: str) -> list[tuple[str, datetime, datetime, bool]]:
    """返回 [(title, start, end, all_day)]。all_day = DTSTART 为纯日期（YYYYMMDD）。"""
    events: list[tuple[str, datetime, datetime, bool]] = []
    title, start, end, all_day = None, None, None, False
    in_event = False
    for line in _unfold_ics(text):
        if line.startswith("BEGIN:VEVENT"):
            in_event, title, start, end, all_day = True, None, None, None, False
        elif line.startswith("END:VEVENT"):
            if in_event and start is not None:
                e = end or (start + timedelta(days=1) if all_day else start)
                events.append((title or "(无标题)", start, e, all_day))
            in_event = False
        elif in_event and ":" in line:
            key, value = line.split(":", 1)
            key = key.split(";")[0]
            if key == "SUMMARY":
                title = value.strip()
            elif key == "DTSTART":
                all_day = len(value.strip()) == 8
                start = _parse_ics_dt(value)
            elif key == "DTEND":
                end = _parse_ics_dt(value)
    return events


class IcsCalendarClient:
    """从本地 ICS 文件读取（用户从任意日历导出）。CAL_ICS_PATH 指定路径。"""

    def __init__(self, path: str | None = None, daily_window_minutes: int | None = None):
        self.path = path or os.environ.get("CAL_ICS_PATH", "")
        self.daily_window = daily_window_minutes or int(os.environ.get("CAL_DAILY_WINDOW_MINUTES", DEFAULT_DAILY_WINDOW_MINUTES))

    def fetch_facts(self, days: int) -> CalendarFacts:
        fetched_at = datetime.now().astimezone().isoformat(timespec="seconds")
        try:
            with open(self.path, encoding="utf-8") as f:
                raw = parse_ics(f.read())
        except OSError as e:
            return CalendarFacts(ok=False, error=f"{type(e).__name__}: {e}", window_days=days, fetched_at=fetched_at)

        today = date.today()
        window = [today + timedelta(days=i) for i in range(days)]
        by_date: dict[date, DayBusy] = {d: DayBusy(date=d.isoformat()) for d in window}
        kept_events: list[CalendarEvent] = []
        for title, start, end, all_day in raw:
            # 逐日切分忙碌分钟（跨天事件按天摊）
            cur = start
            while cur < end and cur.date() <= window[-1]:
                d = cur.date()
                if d in by_date:
                    day_end = min(end, datetime.combine(d, datetime.max.time()))
                    minutes = max(0, round((day_end - cur).total_seconds() / 60))
                    db = by_date[d]
                    if all_day:
                        db.all_day_event = True
                        db.busy_minutes = self.daily_window  # 全天事件占满推断窗口
                    else:
                        db.busy_minutes += min(minutes, self.daily_window)
                    db.event_count += 1
                    kept_events.append(CalendarEvent(
                        title=title, start=start.isoformat(), end=end.isoformat(), all_day=all_day,
                    ))
                cur = datetime.combine(d + timedelta(days=1), datetime.min.time())
            if len(kept_events) >= 100:
                break
        return CalendarFacts(
            ok=True,
            days=[by_date[d] for d in window],
            events=kept_events[:50],
            window_days=days,
            fetched_at=fetched_at,
        )


class StaticCalendarClient:
    """测试/评测注入：直接给定 DayBusy 列表。"""

    def __init__(self, days: list[DayBusy], daily_window_minutes: int = DEFAULT_DAILY_WINDOW_MINUTES):
        self._days = days
        self.daily_window = daily_window_minutes

    def fetch_facts(self, days: int) -> CalendarFacts:
        padded = self._days[:days]
        last_date = date.fromisoformat(padded[-1].date) if padded else date.today()
        avg_busy = round(sum(d.busy_minutes for d in padded) / max(1, len(padded)))
        while len(padded) < days:  # 窗口外天数按观测均值补齐
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
        while len(inferred) < days_left:  # 窗口外按均值补
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
    elif facts is not None and not facts.ok:
        signals.append(f"日历数据不可用: {facts.error or '未知'}")

    # 有效容量合成
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

    # 冲突检测：声明显著超出推断 → 显式标注（保留声明优先级，但暴露风险）
    conflicts: list[CapacityConflict] = []
    if has_declared and inferred is not None:
        for i in range(days_left):
            dec = effective[i]
            inf = inferred[i]
            if dec > inf + CONFLICT_TOLERANCE_MINUTES:
                dt = (date.today() + timedelta(days=i)).isoformat()
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
