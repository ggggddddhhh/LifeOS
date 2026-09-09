"""Phase 7/7.5：Calendar 写入闭环（确认制，Instant 语义）。

铁律：本模块之外的任何代码路径都不能触发写操作；执行器只处理显式确认过的草稿；
v1 仅支持 CREATE，永不覆盖用户事件。

时间语义：startUtc/endUtc = Instant；墙钟计算只在规划时区（IANA）内进行；
冲突检测与 Verify 全部 Instant 比较；LifeOS 写出 ICS 用 UTC Z 格式（零歧义回读）。
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Protocol

from .schemas import CalendarDraftItem, ExecuteRequest, ExecuteResultItem
from .times import (
    UTC,
    _unfold_lines,
    ics_utc_str,
    overlaps,
    parse_ics_utc,
    today_in,
    to_utc,
    wall_in_tz,
    work_window,
)

UID_PREFIX = "lifeos"
TITLE_PREFIX = "LifeOS:"
MINUTES_PER_DAY = 1440


class CalendarWriteError(Exception):
    """code 是稳定错误码；hint 是用户可理解的行动提示（Phase 8.5），随 str(e) 透传到 TS；
    retry_after 是 429 响应建议的等待秒数（供读重试退避）。"""

    def __init__(self, code: str, message: str, hint: str | None = None, retry_after: float | None = None):
        super().__init__(f"{message}（提示：{hint}）" if hint else message)
        self.code = code
        self.hint = hint
        self.retry_after = retry_after


def make_uid(goal_id: str, plan_version: int, task_id: str, occurrence: int = 1) -> str:
    return f"{UID_PREFIX}-{goal_id}-v{plan_version}-{task_id}-o{occurrence}@lifeos"


# ---------------------------------------------------------------- Draft Builder（只读，确定性，规划时区墙钟空间）

def _free_windows(days_left: int, planning_tz: str, busy: list[dict]) -> dict[str, list[tuple[datetime, datetime]]]:
    """按规划时区墙钟日计算 [08:00,20:00] 空闲区间。

    busy: [{startUtc,endUtc,allDay,localDate}] —— Instant 或 all-day LocalDate。
    all-day 阻塞其 LocalDate 对应的规划时区日；定时长事件 Instant→墙钟后做区间减法。
    """
    base = today_in(planning_tz)
    windows: dict[str, list[tuple[datetime, datetime]]] = {}
    all_day_dates = {b.get("localDate") for b in busy if b.get("allDay")}
    timed: list[tuple[datetime, datetime]] = []
    for b in busy:
        if b.get("allDay"):
            continue
        timed.append((
            datetime.fromisoformat(b["startUtc"]),
            datetime.fromisoformat(b["endUtc"]),
        ))

    for i in range(days_left):
        d = base + timedelta(days=i)
        iso = d.isoformat()
        if iso in all_day_dates:
            windows[iso] = []
            continue
        ws, we = work_window(d)
        ws_utc, we_utc = to_utc(ws, planning_tz).instant, to_utc(we, planning_tz).instant
        # 规划时区的窗口 Instant（DST 日窗口跨度可为 11h/13h，墙钟空间仍为 12h——以墙钟为准）
        busy_walls: list[tuple[datetime, datetime]] = []
        for s, e in timed:
            if e <= ws_utc or s >= we_utc:
                continue
            s_wall = max(ws, wall_in_tz(s, planning_tz)) if s > ws_utc else ws
            e_wall = min(we, wall_in_tz(e, planning_tz)) if e < we_utc else we
            busy_walls.append((s_wall, e_wall))
        busy_walls.sort()
        free: list[tuple[datetime, datetime]] = []
        cur = ws
        for s, e in busy_walls:
            if s > cur:
                free.append((cur, s))
            cur = max(cur, e)
        if cur < we:
            free.append((cur, we))
        windows[iso] = free
    return windows


def build_drafts(
    tasks: list[dict],
    days_left: int,
    busy: list[dict],
    goal_id: str,
    plan_version: int,
    planning_tz: str,
) -> list[CalendarDraftItem]:
    """确定性贪心：规划时区墙钟空间内按优先级排入空闲窗口，落位后 canonical 转 Instant。"""
    drafts: list[CalendarDraftItem] = []
    free = _free_windows(days_left, planning_tz, busy)

    ordered = sorted(
        [t for t in tasks if t.get("status", "todo") != "done"],
        key=lambda t: (t.get("priority", 2), -t.get("estMinutes", 60)),
    )

    def place(wall_start: datetime, est: int, task: dict, occurrence: int, reason: str) -> CalendarDraftItem:
        wall_end = wall_start + timedelta(minutes=est)
        conv_s = to_utc(wall_start, planning_tz)
        conv_e = to_utc(wall_end, planning_tz)
        return CalendarDraftItem(
            taskId=task["taskId"], taskTitle=task["title"],
            startUtc=conv_s.instant.isoformat(timespec="seconds").replace("+00:00", "Z"),
            endUtc=conv_e.instant.isoformat(timespec="seconds").replace("+00:00", "Z"),
            timezone=planning_tz, calendarId="primary", actionType="create", reason=reason,
            idempotencyKey=f"{goal_id}:{plan_version}:{task['taskId']}:{occurrence}",
            ambiguous=conv_s.ambiguous or conv_e.ambiguous,
            nonexistent=conv_s.nonexistent or conv_e.nonexistent,
        )

    for t in ordered:
        est = max(15, int(t.get("estMinutes", 60)))
        dur_days = int(t.get("durationDays") or 0)
        if dur_days >= 1:
            placed = 0
            for iso, intervals in free.items():
                if placed >= min(dur_days, days_left):
                    break
                for idx, (s, e) in enumerate(intervals):
                    if (e - s).total_seconds() / 60 >= est:
                        drafts.append(place(s, est, t, placed + 1, f"周期任务每日 {est} 分钟（{placed + 1}/{dur_days}）"))
                        intervals[idx] = (s + timedelta(minutes=est), e)
                        placed += 1
                        break
        else:
            for iso, intervals in free.items():
                for idx, (s, e) in enumerate(intervals):
                    if (e - s).total_seconds() / 60 >= est:
                        drafts.append(place(s, est, t, 1, "按剩余可用时间排期"))
                        intervals[idx] = (s + timedelta(minutes=est), e)
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
        start = datetime.fromisoformat(d.startUtc.replace("Z", "+00:00"))
        end = datetime.fromisoformat(d.endUtc.replace("Z", "+00:00"))
    except ValueError as e:
        raise CalendarWriteError("CAL_INVALID_DRAFT", f"非法 Instant: {e}") from e
    if start.tzinfo is None or end.tzinfo is None:
        raise CalendarWriteError("CAL_INVALID_DRAFT", "startUtc/endUtc 必须是带时区的 Instant")
    if end <= start:
        raise CalendarWriteError("CAL_INVALID_DRAFT", "endUtc 必须晚于 startUtc")
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
    def read_events(self) -> list[dict]:  # {uid,startUtc,endUtc,title,allDay,localDate}
        ...

    def create_event(self, uid: str, title: str, start: datetime, end: datetime) -> None:
        ...


class IcsWriteProvider:
    """v1 真实写目标：向 ICS 文件追加 VEVENT（UTC Z 格式，零歧义回读）。"""

    provider_name = "ics"

    def __init__(self, path: str | None = None):
        self.path = path or os.environ.get("CAL_ICS_PATH", "")

    def read_events(self) -> list[dict]:
        from .calendar import _parse_vevents
        from .times import parse_ics_dtstart

        try:
            with open(self.path, encoding="utf-8") as f:
                raw = _parse_vevents(f.read())
        except OSError:
            return []
        events: list[dict] = []
        for ve in raw:
            try:
                start = parse_ics_dtstart(ve.dtstart, ve.tzid or None, "UTC")
            except ValueError:
                continue
            if isinstance(start, str):
                events.append({"uid": ve.uid, "title": ve.title, "allDay": True, "localDate": start, "startUtc": "", "endUtc": ""})
                continue
            end = start.instant
            if ve.dtend:
                try:
                    pe = parse_ics_dtstart(ve.dtend, ve.tzid or None, "UTC")
                    if not isinstance(pe, str):
                        end = pe.instant
                except ValueError:
                    pass
            events.append({
                "uid": ve.uid, "title": ve.title, "allDay": False, "localDate": None,
                "startUtc": start.instant.isoformat(timespec="seconds").replace("+00:00", "Z"),
                "endUtc": end.isoformat(timespec="seconds").replace("+00:00", "Z"),
            })
        return events

    def create_event(self, uid: str, title: str, start: datetime, end: datetime) -> None:
        vevent = (
            f"UID:{uid}\r\n"
            f"SUMMARY:{title}\r\n"
            f"DTSTART:{ics_utc_str(start)}\r\n"
            f"DTEND:{ics_utc_str(end)}\r\n"
            "END:VEVENT\r\n"
        )
        try:
            existing_text = ""
            try:
                with open(self.path, encoding="utf-8") as f:
                    existing_text = f.read()
            except OSError:
                existing_text = ""
            if "END:VCALENDAR" in existing_text:
                # 结构正确性：插到 VCALENDAR 结束标记之前
                head, marker, tail = existing_text.rpartition("END:VCALENDAR")
                sep = "" if head.endswith("\n") else "\r\n"
                after = "" if tail.startswith("\n") else "\r\n"
                new_text = f"{head}{sep}BEGIN:VEVENT\r\n{vevent}{after}{marker}{tail}"
            else:
                sep = "" if (not existing_text or existing_text.endswith("\n")) else "\r\n"
                new_text = f"{existing_text}{sep}BEGIN:VEVENT\r\n{vevent}"
            with open(self.path, "w", encoding="utf-8", newline="") as f:
                f.write(new_text)
        except OSError as e:
            raise CalendarWriteError("CAL_SERVER", f"ICS 写入失败: {e}") from e


# ---------------------------------------------------------------- Executor（确认后，Instant 比较）

def execute_drafts(req: ExecuteRequest, provider: CalendarWriteProvider) -> list[ExecuteResultItem]:
    results: list[ExecuteResultItem] = []
    try:
        existing = provider.read_events()
    except CalendarWriteError as e:
        # Phase 9：读阶段失败（如 token 失效）也必须逐条结构化上报，绝不整批 500
        return [ExecuteResultItem(idempotencyKey=d.idempotencyKey, status="failed", error=f"{e.code}: {e}")
                for d in req.drafts]
    for d in req.drafts:
        try:
            validate_draft(d, {t["taskId"]: t for t in req.tasks})
        except CalendarWriteError as e:
            results.append(ExecuteResultItem(idempotencyKey=d.idempotencyKey, status="failed", error=f"{e.code}: {e}"))
            continue

        start = datetime.fromisoformat(d.startUtc.replace("Z", "+00:00"))
        end = datetime.fromisoformat(d.endUtc.replace("Z", "+00:00"))
        ics_uid = make_uid(req.goalId, req.planVersion, d.taskId, int(d.idempotencyKey.split(":")[3]))
        # Google Provider 用草稿幂等键做外部防重复（privateExtendedProperty 查询语义）；
        # ICS 用 lifeos UID。两者都唯一且可回溯。
        is_google = hasattr(provider, "verify_event")
        uid = d.idempotencyKey if is_google else ics_uid

        # 幂等身份判定（Phase 9 修复）：Google 事件 uid 是 Google eventId，与幂等键不同源——
        # 必须按 private.idempotencyKey 匹配；ICS 事件 uid 即 lifeos UID。
        def _is_self(e: dict) -> bool:
            if is_google:
                priv = e.get("private")
                return isinstance(priv, dict) and priv.get("idempotencyKey") == d.idempotencyKey
            return e["uid"] == ics_uid

        # 幂等：同 key 既有事件 → 跳过（超时/重放恢复语义：收敛为 duplicate_skipped，
        # 绝不把"自己的既有事件"误判为用户占用）
        mine = [e for e in existing if _is_self(e)]
        if mine:
            m = mine[0]
            verify = {"found": True, "unique": len(mine) == 1, "startOk": True, "endOk": True}
            if m.get("startUtc") and m.get("endUtc"):
                verify["startOk"] = datetime.fromisoformat(m["startUtc"].replace("Z", "+00:00")) == start
                verify["endOk"] = datetime.fromisoformat(m["endUtc"].replace("Z", "+00:00")) == end
            results.append(ExecuteResultItem(
                idempotencyKey=d.idempotencyKey, status="duplicate_skipped", externalEventId=m["uid"],
                verify=verify,
                error=None if all(verify.values()) else "CAL_CONFLICT: 同幂等键既有事件时间不一致",
            ))
            continue

        # 冲突复检（Instant 比较）：任何非自身事件重叠 → stale，不硬写
        conflict = any(
            (not e["allDay"]) and overlaps(start, end, datetime.fromisoformat(e["startUtc"].replace("Z", "+00:00")), datetime.fromisoformat(e["endUtc"].replace("Z", "+00:00")))
            for e in existing if not _is_self(e)
        )
        if conflict:
            results.append(ExecuteResultItem(
                idempotencyKey=d.idempotencyKey, status="stale_conflict",
                error="CAL_CONFLICT: 草稿生成后日历状态已变化（时间段被占用）",
            ))
            continue

        metadata = {
            "goalId": req.goalId, "planVersion": req.planVersion, "taskId": d.taskId,
            "idempotencyKey": uid, "timezone": d.timezone,
        }
        created: dict | None = None
        try:
            try:
                # Google Provider：幂等 CREATE 协议（pre-check→insert→异常回查），返回事件体
                created = provider.create_event(uid, f"{TITLE_PREFIX}{d.taskTitle}", start, end, metadata=metadata)  # type: ignore[call-arg]
            except TypeError:
                provider.create_event(uid, f"{TITLE_PREFIX}{d.taskTitle}", start, end)  # ICS 等简单 provider
        except CalendarWriteError as e:
            results.append(ExecuteResultItem(idempotencyKey=d.idempotencyKey, status="failed", error=f"{e.code}: {e}"))
            continue
        except Exception as e:  # noqa: BLE001 —— 单条失败不炸整批
            results.append(ExecuteResultItem(idempotencyKey=d.idempotencyKey, status="failed", error=f"CAL_SERVER: {type(e).__name__}: {e}"))
            continue

        # Verify：Google Provider 用 GET 回读（Instant+calendarId+metadata 全检）；
        # 其余 provider 走 read_events 比对（uid 即 externalEventId）
        verify: dict
        external_id: str | None
        if created is not None and hasattr(provider, "verify_event"):
            external_id = created.get("id")
            try:
                if not external_id:
                    raise CalendarWriteError("verify_failed", "创建响应缺少事件 id")
                provider.verify_event(external_id, expect_start=start, expect_end=end, metadata=metadata)  # type: ignore[attr-defined]
                verify = {"found": True, "startOk": True, "endOk": True, "unique": True}
            except CalendarWriteError as e:
                results.append(ExecuteResultItem(
                    idempotencyKey=d.idempotencyKey, status="failed", externalEventId=external_id,
                    verify={"found": e.code != "event_not_found", "startOk": False, "endOk": False, "unique": True},
                    error=f"{e.code}: {e}",
                ))
                continue
        else:
            after = provider.read_events()
            mine = [
                (datetime.fromisoformat(e["startUtc"].replace("Z", "+00:00")), datetime.fromisoformat(e["endUtc"].replace("Z", "+00:00")))
                for e in after if e["uid"] == uid
            ]
            verify = {
                "found": len(mine) == 1,
                "startOk": bool(mine) and mine[0][0] == start,
                "endOk": bool(mine) and mine[0][1] == end,
                "unique": len(mine) == 1,
            }
            external_id = uid if verify["found"] else None
            existing = after
        results.append(ExecuteResultItem(
            idempotencyKey=d.idempotencyKey, status="success" if all(verify.values()) else "failed",
            externalEventId=external_id, verify=verify,
            error=None if all(verify.values()) else f"CAL_SERVER: Verify 失败 {verify}",
        ))
        if created is not None and hasattr(provider, "verify_event"):
            existing = provider.read_events()  # 后续草稿冲突复检基于最新状态
    return results
