"""LangGraph 节点实现（纯函数，LLM 通过闭包注入）。
规范化语义镜像 src/lib/llm/parse.ts 的 normalizePlannedTasks。"""

from __future__ import annotations

import json
import re
from typing import Any, TypedDict

from .errors import AGENT_PARSE_ERROR, AGENT_VALIDATION_ERROR, AgentError
from .times import today_in
from .calendar import CalendarClient, analyze_capacity
from .github import GithubClient, analyze_progress, extract_repo
from .llm import LLM
from .prompts import CALENDAR_PAYLOAD_NOTE, GITHUB_PAYLOAD_NOTE, PLANNER_SYSTEM, REPLANNER_SYSTEM

MAX_ATTEMPTS = 2  # Validate 失败最多重试 1 次（首次 + 重试），禁止无限循环
CAPACITY_PER_DAY = 480

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TITLE_STRIP_RE = re.compile(r"[\s，。、,.:：;；!！?？·\-—_/\\()（）\[\]【】\"'']+")


class AgentState(TypedDict, total=False):
    kind: str  # "plan" | "replan"
    request: dict[str, Any]
    analysis: dict[str, Any]
    repo: dict[str, str] | None  # {"owner","name"}，analyze 从目标文本解析
    github: dict[str, Any] | None  # GithubFacts.model_dump()
    progress: dict[str, Any] | None  # ProgressReport.model_dump()
    calendar: dict[str, Any] | None  # CalendarFacts.model_dump()
    capacity: dict[str, Any] | None  # CapacityReport.model_dump()
    raw_output: str
    tasks: list[dict[str, Any]]
    reason: str
    attempts: int
    retry_feedback: str | None
    error_code: str | None
    error_message: str | None
    llm_calls: int
    github_calls: int
    calendar_calls: int


# ---------------------------------------------------------------- Analyze（确定性）

def _days_left(deadline: str | None, fallback: int = 14) -> int:
    if not deadline:
        return fallback
    try:
        from datetime import date

        target = date.fromisoformat(deadline[:10])
        import os

        return max(1, (target - today_in(os.environ.get("LIFEOS_USER_TZ", "Asia/Shanghai"))).days)
    except ValueError:
        return fallback


def analyze_node(state: AgentState) -> AgentState:
    req = state["request"]
    repo = extract_repo(req.get("goalTitle") or req.get("title"), req.get("goalDescription") or req.get("description"))
    if state["kind"] == "plan":
        analysis = {"daysLeft": _days_left(req.get("deadline"))}
    else:
        tasks = req.get("tasks", [])
        open_tasks = [t for t in tasks if t.get("status") != "done"]
        total_min = sum(t.get("estMinutes", 0) for t in open_tasks)
        days_left = max(1, int(req.get("daysLeft", 14)))
        analysis = {
            "daysLeft": days_left,
            "openCount": len(open_tasks),
            "doneCount": len(tasks) - len(open_tasks),
            "openTotalMinutes": total_min,
            "capacityMinutes": days_left * CAPACITY_PER_DAY,
            "overloaded": total_min > days_left * CAPACITY_PER_DAY,
        }
    return {"analysis": analysis, "repo": {"owner": repo[0], "name": repo[1]} if repo else None}


# ---------------------------------------------------------------- GitHub Tool / Progress（Phase 4）

def make_github_tool_node(github: GithubClient):
    def github_tool_node(state: AgentState) -> AgentState:
        repo = state.get("repo")
        if not repo:
            return {}  # 分支保证不会进入；防御性返回
        try:
            facts = github.fetch_facts(repo["owner"], repo["name"])
        except Exception as e:  # noqa: BLE001 —— 工具失败绝不扩散为 graph 失败
            from .schemas import GithubFacts

            facts = GithubFacts(ok=False, error=f"{type(e).__name__}: {e}", fetched_at=_today())
        return {"github": facts.model_dump(), "github_calls": state.get("github_calls", 0) + 1}

    return github_tool_node


def progress_analysis_node(state: AgentState) -> AgentState:
    from .schemas import GithubFacts

    facts_dump = state.get("github")
    if facts_dump is None:
        return {"progress": None}  # 无仓库路径：不注入任何 GitHub 字段
    facts = GithubFacts(**facts_dump)
    tasks = state["request"].get("tasks", []) if state["kind"] == "replan" else []
    report = analyze_progress(facts, tasks)
    return {"progress": report.model_dump()}


# ---------------------------------------------------------------- Calendar Tool（Phase 5）

def make_calendar_tool_node(calendar: CalendarClient | None):
    def calendar_tool_node(state: AgentState) -> AgentState:
        declared = state["request"].get("declaredMinutesPerDay") if state["kind"] == "replan" else None
        if calendar is None and not declared:
            return {}  # 工具停用且无用户声明 → 不注入任何容量字段（完全保持现有行为）
        days_left = max(1, int(state.get("analysis", {}).get("daysLeft", 7)))
        facts = None
        if calendar is not None:
            try:
                import os

                tz = os.environ.get("LIFEOS_USER_TZ", "Asia/Shanghai")
                window = max(7, min(30, days_left))  # 观测窗口 7~30 天
                facts = calendar.fetch_facts(window, tz)
            except Exception as e:  # noqa: BLE001 —— 工具失败绝不扩散为 graph 失败
                from .schemas import CalendarFacts

                facts = CalendarFacts(ok=False, error=f"{type(e).__name__}: {e}", window_days=0)
        report = analyze_capacity(facts if facts is not None and facts.ok else None, days_left=days_left, declared=declared)
        return {
            **({"calendar": facts.model_dump()} if facts is not None else {}),
            "capacity": report.model_dump() if report.available else None,
            "calendar_calls": state.get("calendar_calls", 0) + (1 if calendar is not None else 0),
        }

    return calendar_tool_node


def _user_payload(state: AgentState) -> str:
    """组装给 LLM 的 user 消息：请求 + 分析摘要 +（GitHub 上下文）+（容量上下文）+（重试反馈）。
    无对应数据的路径不注入任何相关字段——无仓库/无日历的 payload 与此前逐字节一致（容量字段除外）。"""
    req = dict(state["request"])
    req["analysis"] = state.get("analysis", {})
    if state.get("github") is not None:
        req["github_context"] = state["github"]
        req["progress_report"] = state.get("progress")
        req["github_usage"] = GITHUB_PAYLOAD_NOTE
    if state.get("capacity") is not None:
        req["capacity"] = state["capacity"]
        req["capacity_usage"] = CALENDAR_PAYLOAD_NOTE
    if state.get("retry_feedback"):
        req["retry_feedback"] = state["retry_feedback"]
    return json.dumps(req, ensure_ascii=False)


# ---------------------------------------------------------------- Plan / Replan（LLM）

def make_plan_node(llm: LLM):
    def plan_node(state: AgentState) -> AgentState:
        system = PLANNER_SYSTEM.replace("{TODAY}", _today())
        raw = llm.complete(system, _user_payload(state))
        return {"raw_output": raw, "llm_calls": state.get("llm_calls", 0) + 1}

    return plan_node


def make_replan_node(llm: LLM):
    def replan_node(state: AgentState) -> AgentState:
        raw = llm.complete(REPLANNER_SYSTEM, _user_payload(state))
        return {"raw_output": raw, "llm_calls": state.get("llm_calls", 0) + 1}

    return replan_node


def _today() -> str:
    import os

    return today_in(os.environ.get("LIFEOS_USER_TZ", "Asia/Shanghai")).isoformat()


# ---------------------------------------------------------------- Validate（确定性 + 有限重试）

def extract_json(text: str) -> Any:
    """镜像 TS extractJson：```json 围栏 → 首个 [/{ 起 → 从尾部回退解析。"""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    candidate = fenced.group(1) if fenced else text
    start = re.search(r"[\[{]", candidate)
    if not start:
        raise ValueError("输出中未找到 JSON")
    substr = candidate[start.start():]
    for end in range(len(substr), 0, -1):
        if substr[end - 1] in "]}":
            try:
                return json.loads(substr[:end])
            except json.JSONDecodeError:
                continue
    raise ValueError("无法解析输出的 JSON")


def _parse_date(v: Any) -> str | None:
    if not isinstance(v, str):
        return None
    s = v.strip()
    if not _DATE_RE.match(s):
        return None
    try:
        from datetime import date

        date.fromisoformat(s)
        return s
    except ValueError:
        return None


def normalize_title(title: str) -> str:
    return _TITLE_STRIP_RE.sub("", title.lower())


def normalize_tasks(raw: Any) -> list[dict[str, Any]]:
    """镜像 TS normalizePlannedTasks：坏条目丢弃、重复标题（归一化）只留首条、
    非法字段回退默认值。"""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        title = title.strip()[:200]
        key = normalize_title(title)
        if key in seen:
            continue
        seen.add(key)

        est = item.get("estMinutes")
        est_minutes = min(600, max(10, round(est))) if isinstance(est, (int, float)) else 60
        pri = item.get("priority")
        try:
            priority = round(float(pri)) if float(pri) >= 1 and float(pri) <= 3 else 2
        except (TypeError, ValueError):
            priority = 2
        task: dict[str, Any] = {"title": title, "priority": int(priority), "estMinutes": int(est_minutes)}

        notes = item.get("notes")
        if isinstance(notes, str) and notes.strip():
            task["notes"] = notes.strip()[:500]

        dur = item.get("durationDays")
        try:
            dur_i = int(float(dur))
            if dur_i >= 1:
                task["durationDays"] = min(365, dur_i)
        except (TypeError, ValueError):
            pass

        sd = _parse_date(item.get("startDate"))
        if sd:
            task["startDate"] = sd
        dd = _parse_date(item.get("dueDate"))
        if dd:
            task["dueDate"] = dd

        deps = item.get("dependsOn")
        if isinstance(deps, list):
            cleaned = [d.strip()[:200] for d in deps if isinstance(d, str) and d.strip()]
            if cleaned:
                task["dependsOn"] = cleaned

        out.append(task)
    return out[:20]


def make_validate_node():
    def validate_node(state: AgentState) -> AgentState:
        attempts = state.get("attempts", 0) + 1
        try:
            parsed = extract_json(state.get("raw_output", ""))
        except ValueError as e:
            if attempts < MAX_ATTEMPTS:
                return {"attempts": attempts, "retry_feedback": f"上次输出解析失败（{e}），请只输出严格的 JSON"}
            return {
                "attempts": attempts,
                "error_code": AGENT_PARSE_ERROR,
                "error_message": "LLM 输出两次均无法解析为 JSON",
            }

        tasks = normalize_tasks(parsed.get("tasks") if isinstance(parsed, dict) else parsed)
        reason = ""
        if state["kind"] == "replan":
            reason = parsed.get("reason", "") if isinstance(parsed, dict) else ""

        problem = None
        if len(tasks) == 0:
            problem = "任务列表为空"
        elif state["kind"] == "replan" and not str(reason).strip():
            problem = "reason 为空"
        if problem:
            if attempts < MAX_ATTEMPTS:
                return {"attempts": attempts, "retry_feedback": f"上次输出未通过校验：{problem}，请修正后重新输出"}
            return {
                "attempts": attempts,
                "error_code": AGENT_VALIDATION_ERROR,
                "error_message": f"LLM 输出两次均未通过校验：{problem}",
            }

        update: dict[str, Any] = {"attempts": attempts, "tasks": tasks, "retry_feedback": None}
        if state["kind"] == "replan":
            update["reason"] = str(reason).strip()
        return update

    return validate_node


# ---------------------------------------------------------------- Finalize（确定性）

def finalize_node(state: AgentState) -> AgentState:
    # Phase 6：主动收敛（依赖/日期/反扩散/容量/完成过滤）+ reason 同步重写。
    # 与 TS plan.ts 镜像（语义真源 docs/constraints-vectors.json），TS 侧退居 defense-in-depth。
    from .finalize import finalize_plan, norm_title

    tasks = [dict(t) for t in state["tasks"]]
    req = state["request"]
    if state["kind"] == "replan":
        old_open = {norm_title(t["title"]) for t in req.get("tasks", []) if t.get("status") != "done"}
        done = {norm_title(t["title"]) for t in req.get("tasks", []) if t.get("status") == "done"}
        capacity = (state.get("capacity") or {}).get("capacity_minutes")
        days_left = max(1, int(req.get("daysLeft", 7)))
        deadline = (req.get("deadline") or "")[:10] or None
        tasks, reason, finalize_block = finalize_plan(
            tasks, kind="replan", days_left=days_left, deadline=deadline,
            old_open_titles=old_open, done_titles=done,
            capacity_minutes=capacity if isinstance(capacity, int) else None,
            reason=state.get("reason", ""),
        )
    else:
        deadline = (req.get("deadline") or "")[:10] or None
        days_left = int(state.get("analysis", {}).get("daysLeft", 14))
        tasks, _reason, finalize_block = finalize_plan(
            tasks, kind="plan", days_left=days_left, deadline=deadline, reason="",
        )
    return {"tasks": tasks, **({"reason": reason} if state["kind"] == "replan" else {}), "finalize": finalize_block}


def fail_node(state: AgentState) -> AgentState:
    # 终态已写入 error_code/error_message；服务层据此转为结构化错误响应
    return {}
