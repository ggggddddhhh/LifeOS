"""FastAPI Agent Core。版本化路由 /v1/*，结构化错误响应（无 traceback）。
本服务无状态、不访问数据库；持久化由 Next.js 业务层负责。"""

from __future__ import annotations

import time

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
from .trace import trace
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

app = FastAPI(title="PlanShift Agent Core", version="0.2.0")


@app.middleware("http")
async def run_id_middleware(request: Request, call_next):
    """Phase 9.5：请求级 runId 透传（x-run-id header → trace 上下文），零业务侵入。"""
    from .trace import set_run_id

    set_run_id(request.headers.get("x-run-id"))
    try:
        return await call_next(request)
    finally:
        set_run_id(None)

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
    """Calendar 只读工具。CALENDAR_PROVIDER=google 时用 Google；ics 需 CAL_ICS_PATH；
    未配置 = 工具停用（完全保持现有行为）。"""
    import os

    provider = os.environ.get("CALENDAR_PROVIDER", "ics")
    if provider == "google":
        from .google_calendar import GoogleCalendarProvider

        gp = _google_provider()
        if gp is not None:
            return gp
        return None
    path = os.environ.get("CAL_ICS_PATH", "")
    return IcsCalendarClient(path) if path else None


_google: "GoogleCalendarProvider | None" = None


def _google_provider():
    """Google Provider 单例（OAuth + calendarId）。凭据缺失时返回 None（工具停用，不崩）。
    Phase 8.5：TokenStore 按环境选择（生产禁明文）；connect 做账号绑定校验。"""
    global _google
    import os

    if _google is None:
        creds = os.environ.get("GOOGLE_CREDENTIALS_FILE", "")
        if not creds:
            return None
        from .google_calendar import GoogleCalendarProvider, GoogleOAuth
        from .token_store import make_token_store

        auth = GoogleOAuth(creds, make_token_store("default"))
        _google = GoogleCalendarProvider(auth, os.environ.get("GOOGLE_CALENDAR_ID", "primary"))
        try:
            _google.connect()  # 远端绑定校验失败 = 工具降级（fetch_facts 带错误提示），不崩服务
        except Exception as e:  # noqa: BLE001 —— 打印稳定错误码（不含 token）
            print(f"[calendar] connect 绑定校验失败: {getattr(e, 'code', type(e).__name__)}")
    return _google


def _write_provider():
    """执行器写目标：CALENDAR_PROVIDER=google → Google；否则 ICS。"""
    import os

    if os.environ.get("CALENDAR_PROVIDER") == "google":
        gp = _google_provider()
        if gp is not None:
            return gp, "google"
        raise AgentError("auth_required", "CALENDAR_PROVIDER=google 但缺少 GOOGLE_CREDENTIALS_FILE", status_code=503, retryable=False)
    return IcsWriteProvider(), "ics"


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
            t0 = time.perf_counter()
            facts = calendar.fetch_facts(max(7, min(30, req.daysLeft)), req.timezone)
            trace("cal_facts", ok=bool(facts.ok),
                  error_code=None if facts.ok else (facts.error or "").split(":", 1)[0],
                  latency_ms=round((time.perf_counter() - t0) * 1000))
            if facts.ok:
                busy = [
                    {"startUtc": e.startUtc, "endUtc": e.endUtc, "allDay": e.all_day, "localDate": e.local_date}
                    for e in facts.events
                ]
        except Exception:  # noqa: BLE001 —— 读失败按无日历处理（不阻断草稿）
            trace("cal_facts", ok=False, error_code="exception")
            busy = []
    if req.workStartMinute >= req.workEndMinute:
        raise AgentError("CAL_INVALID_POLICY", "工作开始时间必须早于结束时间", status_code=400, retryable=False)
    drafts = build_drafts(
        req.tasks, req.daysLeft, busy, req.goalId, req.planVersion, req.timezone,
        workdays=set(req.workdays),
        work_start_minute=req.workStartMinute,
        work_end_minute=req.workEndMinute,
        daily_cap_minutes=req.dailyCapMinutes,
        calendar_id=req.calendarId,
    )
    placed_ids = {d.taskId for d in drafts}
    unplaced = [t["taskId"] for t in req.tasks if t.get("status", "todo") != "done" and t["taskId"] not in placed_ids]
    return DraftBuildResponse(drafts=drafts, unplacedTaskIds=unplaced)


@app.post("/v1/calendar/execute", response_model=ExecuteResponse)
def calendar_execute(req: ExecuteRequest):
    """执行用户已确认的草稿：幂等复检 → 冲突复检（Instant）→ CREATE（幂等协议）→ Verify。"""
    provider, name = _write_provider()
    if name == "ics" and not provider.path:  # type: ignore[attr-defined]
        raise AgentError("CAL_AUTH_INVALID", "未配置 CAL_ICS_PATH（写目标缺失）", status_code=503, retryable=False)
    t0 = time.perf_counter()
    results = execute_drafts(req, provider)
    statuses: dict[str, int] = {}
    for r in results:
        statuses[r.status] = statuses.get(r.status, 0) + 1
    trace("cal_execute", provider=name, goal_id=str(req.goalId), plan_version=req.planVersion,
          items=len(results), statuses=statuses,
          error_codes=[(r.error or "").split(":", 1)[0] for r in results if r.error],
          latency_ms=round((time.perf_counter() - t0) * 1000))
    return ExecuteResponse(results=results, provider=name)


@app.get("/v1/calendar/status")
def calendar_status():
    """连接状态（Phase 8.5 运维面）。绝不返回任何 token 值。"""
    import os

    if os.environ.get("CALENDAR_PROVIDER", "ics") != "google":
        return {"provider": "ics", "connected": bool(os.environ.get("CAL_ICS_PATH"))}
    creds = os.environ.get("GOOGLE_CREDENTIALS_FILE", "")
    if not creds:
        return {"provider": "google", "connected": False, "reason": "credentials_missing"}
    from .google_calendar import GoogleOAuth
    from .token_store import make_token_store

    auth = GoogleOAuth(creds, make_token_store("default"))
    out = auth.status()
    return {"provider": "google", "store": type(auth.store).__name__, **out}


@app.post("/v1/calendar/disconnect")
def calendar_disconnect():
    """断开 Google 连接：尽力 revoke 远端 token + 清除本地凭据；重置单例供 reconnect。"""
    global _google
    import os

    if os.environ.get("CALENDAR_PROVIDER", "ics") != "google":
        raise AgentError("CAL_CONFLICT", "当前 CALENDAR_PROVIDER 不是 google", status_code=409, retryable=False)
    creds = os.environ.get("GOOGLE_CREDENTIALS_FILE", "")
    if not creds:
        raise AgentError("auth_required", "缺少 GOOGLE_CREDENTIALS_FILE", status_code=503, retryable=False)
    from .google_calendar import GoogleOAuth
    from .token_store import make_token_store

    # 直接新开 OAuth 读当前 store（单例可能持有过期内存态）；revoke 成功与否都清本地
    auth = GoogleOAuth(creds, make_token_store("default"))
    out = auth.disconnect()
    _google = None  # 下次请求重建（reconnect = 重跑授权流程）
    return {"ok": out["ok"], "revoked": out["revoked"], "warning": out["warning"]}


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
    t0 = time.perf_counter()
    state = run_plan(req.model_dump(), llm, github, calendar)
    trace("plan", kind="plan", ok=not state.get("error_code"), error_code=state.get("error_code"),
          llm_calls=state.get("llm_calls", 0), tasks_out=len(state.get("tasks") or []),
          github_ok=(state.get("github") or {}).get("ok"), calendar_ok=(state.get("calendar") or {}).get("ok"),
          latency_ms=round((time.perf_counter() - t0) * 1000))
    _raise_if_failed(state)
    return JSONResponse(
        status_code=200,
        headers={VERSION_HEADER: PROMPT_VERSION, LLM_CALLS_HEADER: str(state.get("llm_calls", 0))},
        content=PlanResponse(tasks=[PlannedTask(**t) for t in state["tasks"]]).model_dump(),
    )


@app.post("/v1/replan", response_model=ReplanResponse)
def replan(req: ReplanRequest, llm: LLM = Depends(get_llm_dep), github: HttpGithubClient = Depends(get_github_dep), calendar: CalendarClient | None = Depends(get_calendar_dep)):
    t0 = time.perf_counter()
    state = run_replan(req.model_dump(), llm, github, calendar)
    fin = state.get("finalize") or {}
    trace("replan", kind="replan", ok=not state.get("error_code"), error_code=state.get("error_code"),
          llm_calls=state.get("llm_calls", 0), tasks_out=len(state.get("tasks") or []),
          attempts=state.get("attempts"),
          github_ok=(state.get("github") or {}).get("ok"), calendar_ok=(state.get("calendar") or {}).get("ok"),
          capacity_minutes=(state.get("capacity") or {}).get("capacity_minutes"),
          finalize_adjusted=bool(fin.get("finalizeAdjusted")),
          latency_ms=round((time.perf_counter() - t0) * 1000))
    _raise_if_failed(state)
    capacity = (state.get("capacity") or {}).get("capacity_minutes")
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
