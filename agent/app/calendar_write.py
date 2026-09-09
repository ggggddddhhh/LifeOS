"""Phase 7：Calendar 写入闭环（确认制）。

铁律：本模块之外的任何代码路径都不能触发写操作；执行器只处理显式确认过的草稿；
v1 仅支持 CREATE，永不覆盖用户事件。

分层：Draft Builder（只读排期）→ Deterministic Validator → [用户确认，发生在 Next.js]
     → Executor（冲突复检 + 幂等复检 + CREATE + Verify）。
"""

from __future__ import annotations

import os
import re
import uuid
from datetime import date, datetime, time, timedelta
from typing import Protocol

from .calendar import CalendarClient, DEFAULT_DAILY_WINDOW_MINUTES, IcsCalendarClient, parse_ics, _unfold_ics
from .schemas import CalendarDraftItem, DraftBuildRequest, ExecuteRequest, ExecuteResultItem

UID_PREFIX = "lifeos"
TITLE_PREFIX = "LifeOS:"


class CalendarWriteError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code  # CAL_AUTH_INVALID | CAL_RATE_LIMIT | CAL_TIMEOUT | CAL_SERVER | CAL_CONFLICT | CAL_INVALID_DRAFT


def make_uid(goal_id: str, plan_version: int, task_id: str, occurrence: int = 1) -> str:
    return f"{UID_PREFIX}-{goal_id}-v{plan_version}-{task_id}-o{occurrence}@lifeos"


def parse_uid_source(ics_text: str) -> dict[str, str]:
    """UID → 归属（lifeos|user）。用于事实来源区分。"""
    mapping: dict[str, str] = {}
    uid = None
    for line in _unfold_ics(ics_text):
        if line.startswith("BEGIN:VEVENT"):
            uid = None
        elif line.startswith("END:VEVENT"):
            if uid:
                mapping[uid] = "lifeos" if uid.startswith(f"{UID_PREFIX}-") else "user"
        elif ":" in line:
            key, value = line.split(":", 1)
            if key.split(";")[0] == "UID":
                uid = value.strip()
    return mapping


# ---------------------------------------------------------------- Draft Builder（只读，确定性）

WORK_START_HOUR = 8  # 排期工作窗口 [08:00, 20:00]（与 720 分钟推断窗口一致）
WORK_END_HOUR = 20


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _free_intervals(days_left: int, busy_events: list[tuple[datetime, datetime]]) -> dict[str, list[tuple[datetime, datetime]]]:
    """按天计算 [08:00, 20:00] 内的空闲区间（事件级，永不与用户事件重叠）。"""
    intervals: dict[str, list[tuple[datetime, datetime]]] = {}
    for i in range(days_left):
        d = date.today() + timedelta(days=i)
        day_start = datetime.combine(d, time(WORK_START_HOUR))
        day_end = datetime.combine(d, time(WORK_END_HOUR))
        busy: list[tuple[datetime, datetime]] = []
        for s, e in busy_events:
            s, e = _naive(s), _naive(e)
            if e <= day_start or s >= day_end:
                continue
            busy.append((max(s, day_start), min(e, day_end)))
        busy.sort()
        free: list[tuple[datetime, datetime]] = []
        cur = day_start
        for s, e in busy:
            if s > cur:
                free.append((cur, s))
            cur = max(cur, e)
        if cur < day_end:
            free.append((cur, day_end))
        intervals[d.isoformat()] = free
    return intervals


def build_drafts(
    tasks: list[dict],
    days_left: int,
    busy_events: list[tuple[datetime, datetime]],
    goal_id: str,
    plan_version: int,
) -> list[CalendarDraftItem]:
    """确定性贪心：按优先级（P1 先）把任务排入事件级空闲窗口的最早可容纳位置。
    单次型任务占一段连续区间；周期型任务每天占一段。永不与观察到的忙碌重叠。"""
    drafts: list[CalendarDraftItem] = []
    free = _free_intervals(days_left, busy_events)

    ordered = sorted(
        [t for t in tasks if t.get("status", "todo") != "done"],
        key=lambda t: (t.get("priority", 2), -t.get("estMinutes", 60)),
    )
    for t in ordered:
        est = max(15, int(t.get("estMinutes", 60)))
        dur_days = int(t.get("durationDays") or 0)
        if dur_days >= 1:
            placed = 0
            for i in range(days_left):
                if placed >= min(dur_days, days_left):
                    break
                iso = (date.today() + timedelta(days=i)).isoformat()
                for idx, (s, e) in enumerate(free[iso]):
                    if (e - s).total_seconds() / 60 >= est:
                        drafts.append(CalendarDraftItem(
                            taskId=t["taskId"], taskTitle=t["title"],
                            proposedStart=s.isoformat(timespec="seconds"),
                            proposedEnd=(s + timedelta(minutes=est)).isoformat(timespec="seconds"),
                            calendarId="primary", actionType="create",
                            reason=f"周期任务每日 {est} 分钟（{placed + 1}/{dur_days}）",
                            idempotencyKey=f"{goal_id}:{plan_version}:{t['taskId']}:{placed + 1}",
                        ))
                        free[iso][idx] = (s + timedelta(minutes=est), e)
                        placed += 1
                        break
        else:
            for i in range(days_left):
                iso = (date.today() + timedelta(days=i)).isoformat()
                for idx, (s, e) in enumerate(free[iso]):
                    if (e - s).total_seconds() / 60 >= est:
                        drafts.append(CalendarDraftItem(
                            taskId=t["taskId"], taskTitle=t["title"],
                            proposedStart=s.isoformat(timespec="seconds"),
                            proposedEnd=(s + timedelta(minutes=est)).isoformat(timespec="seconds"),
                            calendarId="primary", actionType="create",
                            reason="按剩余可用时间排期",
                            idempotencyKey=f"{goal_id}:{plan_version}:{t['taskId']}:1",
                        ))
                        free[iso][idx] = (s + timedelta(minutes=est), e)
                        break
                else:
                    continue
                break
    return drafts


def validate_draft(d: CalendarDraftItem, tasks_by_id: dict[str, dict]) -> None:
    """确定性校验（Draft Builder 输出与执行器输入都跑一遍）。"""
    if d.actionType != "create":
        raise CalendarWriteError("CAL_INVALID_DRAFT", f"v1 仅支持 create，收到 {d.actionType}")
    try:
        start = datetime.fromisoformat(d.proposedStart)
        end = datetime.fromisoformat(d.proposedEnd)
    except ValueError as e:
        raise CalendarWriteError("CAL_INVALID_DRAFT", f"非法时间: {e}") from e
    if end <= start:
        raise CalendarWriteError("CAL_INVALID_DRAFT", "proposedEnd 必须晚于 proposedStart")
    task = tasks_by_id.get(d.taskId)
    if task is None:
        raise CalendarWriteError("CAL_INVALID_DRAFT", f"未知 taskId {d.taskId}")
    est = max(15, int(task.get("estMinutes", 60)))
    if (end - start).total_seconds() / 60 != est:
        raise CalendarWriteError("CAL_INVALID_DRAFT", f"时长 {int((end - start).total_seconds() / 60)} != 任务估时 {est}")
    if not d.idempotencyKey or len(d.idempotencyKey.split(":")) != 4:
        raise CalendarWriteError("CAL_INVALID_DRAFT", "idempotencyKey 必须为 goalId:planVersion:taskId:occurrence")


# ---------------------------------------------------------------- Provider（写目标）

class CalendarWriteProvider(Protocol):
    def read_events(self) -> list[tuple[str, datetime, datetime, str]]:  # (uid, start, end, title)
        ...

    def create_event(self, uid: str, title: str, start: datetime, end: datetime) -> None:
        ...


class IcsWriteProvider:
    """v1 真实写目标：向 ICS 文件追加 VEVENT。"""

    provider_name = "ics"

    def __init__(self, path: str | None = None):
        self.path = path or os.environ.get("CAL_ICS_PATH", "")

    def read_events(self) -> list[tuple[str, datetime, datetime, str]]:
        try:
            with open(self.path, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            return []
        events: list[tuple[str, datetime, datetime, str]] = []
        title = uid = None
        start = end = None
        in_event = False
        for line in _unfold_ics(text):
            if line.startswith("BEGIN:VEVENT"):
                in_event, title, uid, start, end = True, None, None, None, None
            elif line.startswith("END:VEVENT"):
                if in_event and start is not None:
                    events.append((uid or uuid.uuid4().hex, start, end or start, title or ""))
                in_event = False
            elif in_event and ":" in line:
                key, value = line.split(":", 1)
                key = key.split(";")[0]
                if key == "UID":
                    uid = value.strip()
                elif key == "SUMMARY":
                    title = value.strip()
                elif key == "DTSTART":
                    start = _parse_dt(value.strip())
                elif key == "DTEND":
                    end = _parse_dt(value.strip())
        return events

    def create_event(self, uid: str, title: str, start: datetime, end: datetime) -> None:
        def fmt(dt: datetime) -> str:
            return dt.strftime("%Y%m%dT%H%M%S")

        vevent = (
            "BEGIN:VEVENT\r\n"
            f"UID:{uid}\r\n"
            f"SUMMARY:{title}\r\n"
            f"DTSTART:{fmt(start)}\r\n"
            f"DTEND:{fmt(end)}\r\n"
            "END:VEVENT\r\n"
        )
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(vevent)
        except OSError as e:
            raise CalendarWriteError("CAL_SERVER", f"ICS 写入失败: {e}") from e


def _parse_dt(value: str) -> datetime | None:
    v = value.strip()
    try:
        if len(v) == 8:
            return datetime.strptime(v, "%Y%m%d")
        if "T" in v:
            return datetime.strptime(v.replace("Z", ""), "%Y%m%dT%H%M%S")
        return datetime.strptime(v, "%Y%m%d")
    except ValueError:
        return None


# ---------------------------------------------------------------- Executor（确认后）

def _overlaps(a1: datetime, a2: datetime, b1: datetime, b2: datetime) -> bool:
    return a1 < b2 and b1 < a2


def execute_drafts(req: ExecuteRequest, provider: CalendarWriteProvider) -> list[ExecuteResultItem]:
    """逐条执行（部分失败如实上报）：幂等复检 → 冲突复检 → CREATE → Verify 回读。"""
    results: list[ExecuteResultItem] = []
    existing = provider.read_events()
    for d in req.drafts:
        try:
            validate_draft(d, {t["taskId"]: t for t in req.tasks})
        except CalendarWriteError as e:
            results.append(ExecuteResultItem(idempotencyKey=d.idempotencyKey, status="failed", error=f"{e.code}: {e}"))
            continue

        start = _naive(datetime.fromisoformat(d.proposedStart))
        end = _naive(datetime.fromisoformat(d.proposedEnd))
        uid = make_uid(req.goalId, req.planVersion, d.taskId, int(d.idempotencyKey.split(":")[3]))

        # 幂等：UID 已存在 → 跳过
        if any(u == uid for u, _, _, _ in existing):
            results.append(ExecuteResultItem(
                idempotencyKey=d.idempotencyKey, status="duplicate_skipped", externalEventId=uid,
                verify={"found": True, "startOk": True, "endOk": True, "unique": True},
            ))
            continue

        # 冲突复检：与用户事件（或他人 lifeos 事件）重叠 → stale，不硬写
        conflict = any(
            _overlaps(start, end, s, e) for (u, s, e, _) in existing if u != uid
        )
        if conflict:
            results.append(ExecuteResultItem(
                idempotencyKey=d.idempotencyKey, status="stale_conflict",
                error="CAL_CONFLICT: 草稿生成后日历状态已变化（时间段被占用）",
            ))
            continue

        try:
            provider.create_event(uid, f"{TITLE_PREFIX}{d.taskTitle}", start, end)
        except CalendarWriteError as e:
            results.append(ExecuteResultItem(
                idempotencyKey=d.idempotencyKey, status="failed", error=f"{e.code}: {e}",
            ))
            continue
        except Exception as e:  # noqa: BLE001 —— 单条失败不炸整批
            results.append(ExecuteResultItem(
                idempotencyKey=d.idempotencyKey, status="failed", error=f"CAL_SERVER: {type(e).__name__}: {e}",
            ))
            continue

        # Verify：回读确认存在、时间正确、无重复
        after = provider.read_events()
        mine = [(s, e) for (u, s, e, _) in after if u == uid]
        verify = {
            "found": len(mine) == 1,
            "startOk": bool(mine) and mine[0][0] == start,
            "endOk": bool(mine) and mine[0][1] == end,
            "unique": len(mine) == 1,
        }
        status = "success" if all(verify.values()) else "failed"
        results.append(ExecuteResultItem(
            idempotencyKey=d.idempotencyKey, status=status, externalEventId=uid if verify["found"] else None,
            verify=verify,
            error=None if status == "success" else f"CAL_SERVER: Verify 失败 {verify}",
        ))
        existing = after  # 后续草稿的冲突复检基于最新状态
    return results
