"""FastAPI Agent Core。版本化路由 /v1/*，结构化错误响应（无 traceback）。
本服务无状态、不访问数据库；持久化由 Next.js 业务层负责。"""

from __future__ import annotations

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .calendar import CalendarClient, IcsCalendarClient
from .calendar_write import IcsWriteProvider, build_drafts, execute_drafts
from .errors import (
    AGENT_INTERNAL_ERROR,
    AGENT_INPUT_INVALID,
    AgentError,
)
from .github import HttpGithubClient
from .graph import run_plan, run_replan
from .llm import LLM, MockLLM, get_llm
from .schemas import (
    PROMPT_VERSION,
    DraftBuildRequest,
    DraftBuildResponse,
    ExecuteRequest,
    ExecuteResponse,
    PlanRequest,
    PlanResponse,
    PlannedTask,
    ReplanRequest,
    ReplanResponse,
)

app = FastAPI(title="LifeOS Agent Core", version="0.2.0")

_llm: LLM | None = None
_github: HttpGithubClient | None = None


def get_llm_dep() -> LLM:
    """依赖注入点：测试可通过 app.dependency_overrides 替换 LLM。"""
    global _llm
    if _llm is None:
        _llm = get_llm()
    return _llm


def get_github_dep() -> HttpGithubClient:
    """GitHub 只读工具（Phase 4）。失败在节点内降级，不影响服务可用性。"""
    global _github
    if _github is None:
        _github = HttpGithubClient()
    return _github


def get_calendar_dep() -> CalendarClient | None:
    """Calendar 只读工具（Phase 5）。CAL_ICS_PATH 未配置时返回 None = 工具停用（完全保持现有行为）。"""
    import os

    path = os.environ.get("CAL_ICS_PATH", "")
    return IcsCalendarClient(path) if path else None


def error_body(code: str, message: str, retryable: bool) -> dict:
    return {"error": {"code": code, "message": message, "retryable": retryable}}


@app.exception_handler(AgentError)
async def agent_error_handler(_req: Request, exc: AgentError):
    return JSONResponse(
        status_code=exc.status_code,
        content=error_body(exc.code, exc.message, exc.retryable),
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_req: Request, exc: RequestValidationError):
    # 摘要化错误，不暴露内部细节
    locs = [".".join(str(p) for p in e.get("loc", []) if p != "body") for e in exc.errors()]
    msg = f"请求不符合 schema: {', '.join(locs)}" if locs else "请求不符合 schema"
    return JSONResponse(status_code=422, content=error_body(AGENT_INPUT_INVALID, msg, False))


@app.exception_handler(Exception)
async def internal_error_handler(_req: Request, exc: Exception):
    # 永不向调用方暴露 Python traceback
    return JSONResponse(
        status_code=500,
        content=error_body(AGENT_INTERNAL_ERROR, "Agent 内部错误", False),
    )


@app.post("/v1/calendar/drafts", response_model=DraftBuildResponse)
def calendar_drafts(req: DraftBuildRequest, calendar: CalendarClient | None = Depends(get_calendar_dep)):
    """Draft Builder：只读排期（规划时区墙钟空间的事件级空闲窗口），永不写日历。
    独立于 Planner/LLM（Safety Gate）。"""
    busy: list[dict] = []
    if calendar is not None:
        try:
            facts = calendar.fetch_facts(max(7, min(30, req.daysLeft)), req.timezone)
            if facts.ok:
                busy = [
                    {"startUtc": e.startUtc, "endUtc": e.endUtc, "allDay": e.all_day, "localDate": e.local_date}
                    for e in facts.events
                ]
        except Exception:  # noqa: BLE001 —— 读失败按无日历处理（不阻断草稿）
            busy = []
    drafts = build_drafts(req.tasks, req.daysLeft, busy, req.goalId, req.planVersion, req.timezone)
    placed_ids = {d.taskId for d in drafts}
    unplaced = [t["taskId"] for t in req.tasks if t.get("status", "todo") != "done" and t["taskId"] not in placed_ids]
    return DraftBuildResponse(drafts=drafts, unplacedTaskIds=unplaced)


@app.post("/v1/calendar/execute", response_model=ExecuteResponse)
def calendar_execute(req: ExecuteRequest):
    """执行用户已确认的草稿：幂等复检 → 冲突复检（Instant）→ CREATE（UTC Z）→ Verify（Instant）。"""
    provider = IcsWriteProvider()
    if not provider.path:
        raise AgentError("CAL_AUTH_INVALID", "未配置 CAL_ICS_PATH（写目标缺失）", status_code=503, retryable=False)
    results = execute_drafts(req, provider)
    return ExecuteResponse(results=results, provider=provider.provider_name)


@app.get("/health")
def health(llm: LLM = Depends(get_llm_dep)):
    calendar_on = get_calendar_dep() is not None
    return {
        "ok": True,
        "service": "lifeos-agent",
        "version": app.version,
        "promptVersion": PROMPT_VERSION,
        "mode": "mock" if isinstance(llm, MockLLM) else "llm",
        "graph": "analyze->[github_tool]->[calendar_tool]->progress_analysis->plan|replan->validate->finalize",
        "tools": ["github(readonly)", *(["calendar(readonly)"] if calendar_on else [])],
        "maxLlmCalls": 2,
    }


def _raise_if_failed(state: dict) -> None:
    if state.get("error_code"):
        raise AgentError(
            state["error_code"],
            state.get("error_message", "Agent 处理失败"),
            status_code=502,
            retryable=True,
        )


VERSION_HEADER = "x-prompt-version"
LLM_CALLS_HEADER = "x-llm-calls"  # 本次请求实际 LLM 调用次数（1=一次成功，2=发生过一次重试）


@app.post("/v1/plan", response_model=PlanResponse)
def plan(req: PlanRequest, llm: LLM = Depends(get_llm_dep), github: HttpGithubClient = Depends(get_github_dep), calendar: CalendarClient | None = Depends(get_calendar_dep)):
    state = run_plan(req.model_dump(), llm, github, calendar)
    _raise_if_failed(state)
    return JSONResponse(
        status_code=200,
        headers={VERSION_HEADER: PROMPT_VERSION, LLM_CALLS_HEADER: str(state.get("llm_calls", 0))},
        content=PlanResponse(tasks=[PlannedTask(**t) for t in state["tasks"]]).model_dump(),
    )


@app.post("/v1/replan", response_model=ReplanResponse)
def replan(req: ReplanRequest, llm: LLM = Depends(get_llm_dep), github: HttpGithubClient = Depends(get_github_dep), calendar: CalendarClient | None = Depends(get_calendar_dep)):
    state = run_replan(req.model_dump(), llm, github, calendar)
    _raise_if_failed(state)
    capacity = (state.get("capacity") or {}).get("capacity_minutes")
    fin = state.get("finalize") or {}
    return JSONResponse(
        status_code=200,
        headers={VERSION_HEADER: PROMPT_VERSION, LLM_CALLS_HEADER: str(state.get("llm_calls", 0))},
        content=ReplanResponse(
            reason=state["reason"],
            tasks=[PlannedTask(**t) for t in state["tasks"]],
            capacityMinutes=capacity if isinstance(capacity, int) else None,
            finalize=fin if fin else None,
        ).model_dump(),
    )
