"""Phase 7.5：统一时间语义（唯一 wall↔Instant 转换实现点）。

规则（canonical，不静默）：
- ambiguous（回拨重复墙钟）→ fold=0（较早 Instant），标记 ambiguous
- nonexistent（跳变空洞墙钟）→ 前移到间隔结束，标记 nonexistent
- 服务器本地时区依赖为零：today/now 一律按规划时区计算
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc
DEFAULT_PLANNING_TZ = "Asia/Shanghai"


@dataclass
class WallToInstant:
    instant: datetime  # aware UTC
    ambiguous: bool = False
    nonexistent: bool = False
    adjusted_wall: str | None = None  # nonexistent 时前移后的墙钟


def to_utc(wall: datetime, tz_name: str) -> WallToInstant:
    """墙钟（naive）+ IANA 时区 → UTC Instant。canonical 规则单点实现。

    判别（双 fold 回程校验，不靠 u0==u1）：
    - rt(u0)==wall 且 rt(u1)==wall → ambiguous（回拨重复）→ 取较早 fold=0
    - rt(u0)!=wall 且 rt(u1)!=wall → nonexistent（跳变空洞）→ 取 fold=0 解释的
      Instant（其回程墙钟 = 前移后的合法时间），并标记 + 记录 adjusted_wall
    - 否则 → 正常唯一映射
    """
    tz = ZoneInfo(tz_name)
    d0 = wall.replace(tzinfo=tz, fold=0)
    d1 = wall.replace(tzinfo=tz, fold=1)
    u0, u1 = d0.astimezone(UTC), d1.astimezone(UTC)
    rt0 = u0.astimezone(tz).replace(tzinfo=None)
    rt1 = u1.astimezone(tz).replace(tzinfo=None)
    if rt0 == wall and rt1 == wall:
        if u0 == u1:
            return WallToInstant(instant=u0)  # 正常
        return WallToInstant(instant=min(u0, u1), ambiguous=True)  # 回拨重复 → 较早
    if rt0 != wall and rt1 != wall:
        # 空洞：fold=0 的回程即"前移后的合法墙钟"，其 Instant 即最终值
        return WallToInstant(instant=u0, nonexistent=True, adjusted_wall=rt0.isoformat(timespec="seconds"))
    # 单 fold 有效（极少见的边界）：取有效者
    return WallToInstant(instant=u0 if rt0 == wall else u1)


def wall_in_tz(instant: datetime, tz_name: str) -> datetime:
    """UTC Instant → 规划时区墙钟（naive）。"""
    return instant.astimezone(ZoneInfo(tz_name)).replace(tzinfo=None)


def today_in(tz_name: str) -> date:
    """规划时区的"今天"（服务器时区无关）。"""
    return datetime.now(UTC).astimezone(ZoneInfo(tz_name)).date()


def now_utc() -> datetime:
    return datetime.now(UTC)


def local_date_in(instant: datetime, tz_name: str) -> str:
    return wall_in_tz(instant, tz_name).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- ICS 时间属性解析

def parse_ics_dtstart(value: str, tzid: str | None, planning_tz: str) -> WallToInstant | str:
    """返回 WallToInstant（定时时长）或 'YYYY-MM-DD'（all-day LocalDate 语义）。

    value 形态：
      20260910T090000Z      → UTC
      20260910T090000       → TZID 或规划时区墙钟
      20260910 (VALUE=DATE) → LocalDate（字符串原样返回）
    """
    v = value.strip()
    if len(v) == 8:
        return f"{v[0:4]}-{v[4:6]}-{v[6:8]}"  # all-day
    core = v.rstrip("Z")
    try:
        wall = datetime.strptime(core, "%Y%m%dT%H%M%S")
    except ValueError:
        raise ValueError(f"无法解析 ICS 时间: {value}") from None
    if v.endswith("Z"):
        return WallToInstant(instant=wall.replace(tzinfo=UTC))
    tz = tzid or planning_tz
    result = to_utc(wall, tz)
    if not tzid:
        result.implicit_tz = True  # type: ignore[attr-defined]  # 浮动时间标记
    return result


def ics_utc_str(instant: datetime) -> str:
    """PlanShift 写出格式：UTC Z（RFC5545），自建事件零歧义。"""
    return instant.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def parse_ics_utc(ics_utc: str) -> datetime:
    return datetime.strptime(ics_utc, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)


def overlaps(a1: datetime, a2: datetime, b1: datetime, b2: datetime) -> bool:
    """Instant 比较（aware）。"""
    return a1 < b2 and b1 < a2


def work_window(day: date) -> tuple[datetime, datetime]:
    """规划时区某日的墙钟工作窗 [08:00, 20:00]（naive 墙钟）。"""
    return (
        datetime.combine(day, time(8, 0)),
        datetime.combine(day, time(20, 0)),
    )


def _unfold_lines(text: str) -> list[str]:
    """ICS 折行展开（BEGIN/VEVENT 属性级解析共用）。"""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw.startswith((" ", "\t")) and lines:
            lines[-1] += raw[1:].lstrip()
        else:
            lines.append(raw)
    return lines
