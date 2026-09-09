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


class ReplanResponse(BaseModel):
    reason: str
    tasks: list[PlannedTask]
