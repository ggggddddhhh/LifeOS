"""Phase 6：Finalize 收敛链。

把 TS plan.ts 的确定性约束前移到 Python Finalize——两侧算法保持镜像
（语义真源：docs/constraints-vectors.json，由 pytest 与 vitest 双侧消费）。
TS plan.ts 保留为 defense-in-depth；正常情况下对 Python 输出为 no-op。
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from .times import today_in

PLANNING_TZ_ENV = "LIFEOS_USER_TZ"
DEFAULT_PLANNING_TZ = "Asia/Shanghai"

CONSTRAINTS_SPEC_VERSION = "1"
CAPACITY_PER_DAY = 480
DAY_MS = 86400000
MIN_TASK_MINUTES = 15

_STRIP_RE = re.compile(r"[\s，。、,.:：;；!！?？·\-—_/\\()（）\[\]【】\"'']+")


def norm_title(title: str) -> str:
    return _STRIP_RE.sub("", title.lower())


def _to_ms(d: str) -> int:
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=datetime.now().astimezone().tzinfo).timestamp() * 1000)


def _to_str(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def _today() -> str:
    import os

    return today_in(os.environ.get(PLANNING_TZ_ENV, DEFAULT_PLANNING_TZ)).isoformat()


# ---------------------------------------------------------------- 依赖（镜像 sanitizeDependencies）

def sanitize_dependencies(tasks: list[dict]) -> tuple[dict[str, list[str]], list[str]]:
    """返回 {norm(title): [norm(dep), ...]} 与调整说明。去自引用/未知引用/重复边/环。"""
    titles = {norm_title(t["title"]) for t in tasks}
    deps: dict[str, list[str]] = {}
    notes: list[str] = []
    dropped = 0
    for t in tasks:
        key = norm_title(t["title"])
        valid: list[str] = []
        for d in t.get("dependsOn") or []:
            dn = norm_title(d)
            if dn == key or dn not in titles:
                dropped += 1
                continue
            if dn not in valid:
                valid.append(dn)
        deps[key] = valid
    adj: dict[str, list[str]] = {n: [] for n in titles}
    indeg: dict[str, int] = {n: 0 for n in titles}
    for k, ds in deps.items():
        indeg[k] = len(ds)
        for d in ds:
            adj[d].append(k)
    queue = [n for n, d in indeg.items() if d == 0]
    order: list[str] = []
    while queue:
        n = queue.pop(0)
        order.append(n)
        for nxt in adj[n]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    cyclic = {n for n in titles if n not in set(order)}
    if cyclic:
        for k in list(deps):
            deps[k] = [d for d in deps[k] if not (d in cyclic and k in cyclic)]
    if dropped or cyclic:
        notes.append(f"dependency_adjustment: 丢弃非法/环形依赖边 {dropped + len(cyclic)} 条")
    return deps, notes


# ---------------------------------------------------------------- 调度（镜像 sanitizeSchedule）

def sanitize_schedule(tasks: list[dict], deps: dict[str, list[str]], deadline: str | None, today: str | None = None) -> list[str]:
    today = today or _today()
    today_ms = _to_ms(today)
    if deadline and re.match(r"^\d{4}-\d{2}-\d{2}$", deadline):
        deadline_ms = _to_ms(deadline)
    else:
        deadline_ms = today_ms + 14 * DAY_MS

    notes: list[str] = []
    by_key = {norm_title(t["title"]): t for t in tasks}

    def clamp(ms: int) -> int:
        return max(today_ms, min(deadline_ms, ms))

    for t in tasks:
        before = (t.get("startDate"), t.get("dueDate"))
        if t.get("startDate"):
            t["startDate"] = _to_str(clamp(_to_ms(t["startDate"])))
        if t.get("dueDate"):
            t["dueDate"] = _to_str(clamp(_to_ms(t["dueDate"])))
        if t.get("startDate") and t.get("dueDate") and _to_ms(t["startDate"]) > _to_ms(t["dueDate"]):
            t["startDate"], t["dueDate"] = t["dueDate"], t["startDate"]
        dur = t.get("durationDays")
        if isinstance(dur, int) and dur >= 1 and t.get("startDate"):
            t["dueDate"] = _to_str(min(deadline_ms, _to_ms(t["startDate"]) + (dur - 1) * DAY_MS))
        if (t.get("startDate"), t.get("dueDate")) != before:
            notes.append("invalid_date: 日期已钳制到 [今天, 截止日] 并保证 start ≤ due")

    # 依赖顺序传播
    dependents: dict[str, list[str]] = {}
    indeg: dict[str, int] = {}
    for t in tasks:
        k = norm_title(t["title"])
        ds = deps.get(k, [])
        indeg[k] = len(ds)
        for d in ds:
            dependents.setdefault(d, []).append(k)
    queue = [n for n, d in indeg.items() if d == 0]
    while queue:
        n = queue.pop(0)
        t = by_key.get(n)
        due = _to_ms(t["dueDate"]) if t and t.get("dueDate") else None
        if due is not None:
            for nxt in dependents.get(n, []):
                nt = by_key.get(nxt)
                if nt and nt.get("dueDate") and _to_ms(nt["dueDate"]) < due:
                    nt["dueDate"] = _to_str(min(deadline_ms, due))
                    notes.append("invalid_date: 依赖任务的完成日已不早于前置任务")
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    queue.append(nxt)
        else:
            for nxt in dependents.get(n, []):
                indeg[nxt] -= 1
                if indeg[nxt] == 0:
                    queue.append(nxt)
    return notes


# ---------------------------------------------------------------- 反扩散（镜像 enforceTaskBudget）

def enforce_task_budget(tasks: list[dict], old_titles: set[str]) -> tuple[list[dict], list[str]]:
    cap = len(old_titles) + 1
    out = [dict(t) for t in tasks]
    depended_by = {norm_title(d) for t in out for d in (t.get("dependsOn") or [])}

    def pick(prefer_added: bool) -> int:
        best = -1
        for i, t in enumerate(out):
            if norm_title(t["title"]) in depended_by:
                continue
            added = norm_title(t["title"]) not in old_titles
            if prefer_added != added:
                continue
            if best == -1 or t.get("priority", 2) > out[best].get("priority", 2):
                best = i
        return best

    removed: list[str] = []
    while len(out) > cap:
        idx = pick(True)
        if idx == -1:
            idx = pick(False)
        if idx == -1:
            break
        removed.append(out.pop(idx)["title"])
        depended_by.discard(norm_title(removed[-1]))
    notes = [f"anti_expansion_trim: 任务数超限，移除 {('、'.join(removed))}"] if removed else []
    return out, notes


# ---------------------------------------------------------------- 容量（镜像 enforceTimeBudget）

def enforce_time_budget(tasks: list[dict], days_left: int, capacity_override: int | None = None) -> tuple[list[dict], list[str]]:
    # 覆写语义（与 TS 镜像）：override >= 0 即合法（0 = 零容量 → 最小可行计划下限 15min）；
    # 仅 None / 负数回退默认 max(480, daysLeft×480)。
    if capacity_override is not None and capacity_override >= 0:
        cap = max(capacity_override, MIN_TASK_MINUTES)
    else:
        cap = max(CAPACITY_PER_DAY, days_left * CAPACITY_PER_DAY)
    out = [dict(t) for t in tasks]

    def total() -> int:
        return sum(t["estMinutes"] for t in out)

    if total() <= cap:
        return out, []

    depended_by = {norm_title(d) for t in out for d in (t.get("dependsOn") or [])}
    cut: list[str] = []
    while total() > cap:
        victim = -1
        for i, t in enumerate(out):
            if t.get("priority", 2) == 1:
                continue
            if norm_title(t["title"]) in depended_by:
                continue
            if victim == -1 or t.get("priority", 2) > out[victim].get("priority", 2):
                victim = i
        if victim == -1:
            break
        cut.append(out.pop(victim)["title"])
        depended_by.discard(norm_title(cut[-1]))

    scaled = False
    if total() > cap and out:
        factor = cap / total()
        for t in out:
            t["estMinutes"] = max(MIN_TASK_MINUTES, round(t["estMinutes"] * factor))
        scaled = True

    notes = []
    if cut:
        notes.append(f"capacity_trim: 容量不足，砍掉 {('、'.join(cut))}")
    if scaled:
        notes.append("capacity_trim: 剩余任务估时已按容量等比压缩")
    if capacity_override is not None and capacity_override < MIN_TASK_MINUTES and out:
        notes.append("minimal_plan_floor: 容量为 0，保留最小核心任务")
    return out, notes


# ---------------------------------------------------------------- Finalize 主流程

def finalize_plan(
    tasks: list[dict],
    *,
    kind: str,
    days_left: int,
    deadline: str | None,
    old_open_titles: set[str] | None = None,
    done_titles: set[str] | None = None,
    capacity_minutes: int | None = None,
    reason: str = "",
) -> tuple[list[dict], str, dict]:
    """返回 (最终任务, 最终 reason, finalize 观测块)。调整顺序与 TS replan 路由逐一对齐。"""
    adjustments: list[dict] = []
    llm_minutes = sum(t["estMinutes"] for t in tasks)

    deps, notes = sanitize_dependencies(tasks)
    adjustments += [{"type": "dependency_adjustment", "detail": n.split(": ", 1)[1]} for n in notes]
    adjustments += [{"type": "invalid_date", "detail": n.split(": ", 1)[1]} for n in sanitize_schedule(tasks, deps, deadline)]

    if kind == "replan":
        tasks, notes = enforce_task_budget(tasks, old_open_titles or set())
        adjustments += [{"type": "anti_expansion_trim", "detail": n.split(": ", 1)[1]} for n in notes]

        tasks, notes = enforce_time_budget(tasks, days_left, capacity_minutes)
        adjustments += [{"type": n.split(":")[0], "detail": n.split(": ", 1)[1]} for n in notes]

        done_titles = done_titles or set()
        before = len(tasks)
        tasks = [t for t in tasks if norm_title(t["title"]) not in done_titles]
        if len(tasks) < before:
            adjustments.append({"type": "completed_task_removed", "detail": "移除与已完成任务同名的条目"})

    final_minutes = sum(t["estMinutes"] for t in tasks)
    adjusted = len(adjustments) > 0 or final_minutes != llm_minutes
    if adjusted:
        cap_str = capacity_minutes if capacity_minutes else days_left * CAPACITY_PER_DAY
        detail = "；".join(a["detail"] for a in adjustments) if adjustments else "估时已对齐容量"
        reason = f"{reason}（最终调整：{detail}。最终计划 {len(tasks)} 项共 {final_minutes} 分钟，容量上限 {cap_str} 分钟）"

    finalize_block = {
        "llmProposedMinutes": llm_minutes,
        "finalizedMinutes": final_minutes,
        "capacityMinutes": capacity_minutes,
        "finalizeAdjusted": adjusted,
        "adjustments": adjustments,
    }
    return tasks, reason, finalize_block
