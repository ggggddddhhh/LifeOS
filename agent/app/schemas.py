"""输入输出契约。字段名与 TS PlannedTask / TaskSnapshot 严格对齐（camelCase）。"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

PROMPT_VERSION = "2"  # 与 src/lib/llm/index.ts 的 prompt 保持同步，修改时双侧同改


class PlanRequest(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    description: Optional[str] = Field(default=None, max_length=2000)
    deadline: Optional[str] = None  # ISO-8601


class PlannedTask(BaseModel):
    title: str
    notes: Optional[str] = None
    priority: int = 2  # 1 高 2 中 3 低
    estMinutes: int = 60
    durationDays: Optional[int] = None  # ≥1 时为周期型任务
    startDate: Optional[str] = None  # YYYY-MM-DD
    dueDate: Optional[str] = None  # YYYY-MM-DD
    dependsOn: Optional[list[str]] = None  # 依赖其他任务标题


class PlanResponse(BaseModel):
    tasks: list[PlannedTask]


class TaskSnapshot(BaseModel):
    title: str
    status: Literal["todo", "in_progress", "done"]
    estMinutes: int
    priority: int
    dueDate: Optional[str] = None


class ReplanRequest(BaseModel):
    goalTitle: str = Field(min_length=1, max_length=500)
    goalDescription: Optional[str] = Field(default=None, max_length=2000)
    deadline: Optional[str] = None  # ISO-8601
    daysLeft: int = Field(ge=1, le=3650)
    tasks: list[TaskSnapshot] = Field(min_length=1)
    # 用户主动声明的每日可投入分钟数（下标 = 剩余第几天，长度应≈daysLeft）。
    # 语义层级：用户声明 > Calendar 推断 > 默认 480/天；与推断冲突时显式标注。
    declaredMinutesPerDay: Optional[list[int]] = None


class FinalizeAdjustment(BaseModel):
    type: str  # capacity_trim | invalid_date | dependency_adjustment | anti_expansion_trim | completed_task_removed | minimal_plan_floor
    detail: str


class FinalizeInfo(BaseModel):
    """Phase 6 可观测块：LLM 提议 → 最终落库计划的收敛过程。"""
    llmProposedMinutes: int
    finalizedMinutes: int
    capacityMinutes: Optional[int] = None
    finalizeAdjusted: bool
    adjustments: list[FinalizeAdjustment] = []


class ReplanResponse(BaseModel):
    reason: str
    tasks: list[PlannedTask]
    # 本次 replan 实际采用的可用容量（分钟）。仅当存在 Calendar 数据或用户声明时返回；
    # TS 侧用它覆写 enforceTimeBudget 的默认 480×天数 上限（扩展容量输入来源，不改硬约束原则）。
    capacityMinutes: Optional[int] = None
    finalize: Optional[FinalizeInfo] = None


# ---------------------------------------------------------------- Phase 4：GitHub 只读工具

class RepoInfo(BaseModel):
    full_name: str
    description: str | None = None
    default_branch: str = ""
    pushed_at: str | None = None
    open_issues_count: int = 0


class IssueBrief(BaseModel):
    number: int
    title: str
    updated_at: str | None = None


class PRBrief(BaseModel):
    number: int
    title: str
    merged: bool = False
    draft: bool = False
    updated_at: str | None = None


class CIRunBrief(BaseModel):
    name: str
    status: str = ""
    conclusion: str | None = None
    branch: str = ""
    created_at: str | None = None


class CommitBrief(BaseModel):
    sha: str
    message: str
    date: str | None = None


class GithubFacts(BaseModel):
    """GitHub 观察到的事实（Tool 输出，与 Planner 解耦）。"""
    ok: bool
    error: str | None = None
    repo: RepoInfo | None = None
    open_issues: list[IssueBrief] = []
    closed_recent: list[IssueBrief] = []
    open_prs: list[PRBrief] = []
    ci_runs: list[CIRunBrief] = []
    commits: list[CommitBrief] = []
    fetched_at: str = ""


class TaskMatch(BaseModel):
    """LifeOS 任务 ↔ GitHub issue 匹配（带置信度，标题不等同）。"""
    task_title: str
    issue_number: int
    issue_title: str
    confidence: float
    method: str  # exact | substring | jaccard


class StatusConflict(BaseModel):
    """用户声明与 GitHub 观察冲突（Phase 4.5：必须显式标注，禁止静默覆盖）。"""
    task_title: str
    issue_number: int
    issue_title: str
    user_status: str  # 用户声明（如 done）
    github_state: str  # GitHub 观察（如 open）
    confidence: float


class ProgressReport(BaseModel):
    """进度分析：signals=事实观察，verdict/reasons=Agent 推断（明确分离）。"""
    available: bool
    signals: list[str] = []
    matches: list[TaskMatch] = []
    observed_done: list[str] = []
    conflicts: list[StatusConflict] = []
    verdict: str = "unknown"  # ahead | on_track | behind | unknown
    reasons: list[str] = []


# ---------------------------------------------------------------- Phase 5：Calendar 只读工具

class CalendarEvent(BaseModel):
    """Calendar 观察事实（原始事件，截断保留）。"""
    title: str
    start: str  # ISO
    end: str  # ISO
    all_day: bool = False


class DayBusy(BaseModel):
    """Calendar 观察事实：某日忙碌统计（无事件日 busy_minutes=0 也会出现）。"""
    date: str  # YYYY-MM-DD
    busy_minutes: int = 0
    event_count: int = 0
    all_day_event: bool = False


class CalendarFacts(BaseModel):
    ok: bool
    error: str | None = None
    days: list[DayBusy] = []
    events: list[CalendarEvent] = []
    window_days: int = 0
    fetched_at: str = ""


class CapacityConflict(BaseModel):
    """用户声明与 Calendar 推断冲突（显式标注，不静默采信任何一方）。"""
    day_index: int  # 剩余第几天（1 起）
    date: str
    declared_minutes: int
    inferred_minutes: int
    note: str


class CapacityReport(BaseModel):
    """容量三层语义汇总：声明（用户）/ 推断（Agent，由观察计算）/ 默认（480）。
    effective 优先级：声明 > 推断 > 默认；冲突进 conflicts。"""
    available: bool
    source: str = "default"  # declared | calendar_inferred | declared+calendar | default
    per_day_effective: list[int] = []
    per_day_declared: list[int] | None = None
    per_day_inferred: list[int] | None = None
    capacity_minutes: int = 0
    window_days: int = 0
    daily_window_minutes: int = 0  # 推断参数：每日总窗口
    conflicts: list[CapacityConflict] = []
    signals: list[str] = []
