export const TASK_STATUSES = ["todo", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const GOAL_STATUSES = ["active", "achieved", "archived"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

/** AI 拆解出的单个任务（LLM 层输出，尚未入库） */
export interface PlannedTask {
  title: string;
  notes?: string;
  priority: number; // 1 高 2 中 3 低
  estMinutes: number; // 单次型=总耗时；周期型=每次耗时
  durationDays?: number; // ≥1 时为周期型任务
  startDate?: string; // YYYY-MM-DD
  dueDate?: string; // YYYY-MM-DD
  dependsOn?: string[]; // 依赖的其他任务标题
}

/** 计划版本 diff（replan 时生成，要求 #3） */
export interface PlanDiffItem {
  title: string;
  estMinutes?: number;
  estMinutesFrom?: number;
  estMinutesTo?: number;
  dueFrom?: string | null;
  dueTo?: string | null;
  moved?: "延后" | "提前" | "不变";
}

export interface PlanDiff {
  added: PlanDiffItem[]; // 新标题
  removed: PlanDiffItem[]; // 旧标题消失（done 任务永不在此）
  changed: PlanDiffItem[]; // 保留但估时/日期变化
  summary: {
    added: number;
    removed: number;
    kept: number;
    estDelta: number; // 新计划总估时 - 旧未完成总估时（分钟）
  };
}

export interface PlanGoalInput {
  title: string;
  description?: string;
  deadline?: string; // ISO
}

export interface TaskSnapshot {
  title: string;
  status: TaskStatus;
  estMinutes: number;
  priority: number;
  dueDate?: string | null;
}

export interface ReplanInput {
  goalTitle: string;
  goalDescription?: string;
  deadline?: string; // ISO
  daysLeft: number;
  tasks: TaskSnapshot[]; // 当前全部任务（含 done）
  declaredMinutesPerDay?: number[]; // Phase 12：策略声明容量（工作日=每日可投入，非工作日=0）；Python 三层容量的「声明层」
}

export interface FinalizeAdjustment {
  type: string;
  detail: string;
}

export interface FinalizeInfo {
  llmProposedMinutes: number;
  finalizedMinutes: number;
  capacityMinutes: number | null;
  finalizeAdjusted: boolean;
  adjustments: FinalizeAdjustment[];
}

export interface ReplanResult {
  reason: string; // 一句话说明为何这样调整
  tasks: PlannedTask[]; // 未完成部分的全新计划
  capacityMinutes?: number | null; // 实际采用的可用容量（Calendar 观察/用户声明时返回）
  finalize?: FinalizeInfo | null; // Phase 6：Python Finalize 收敛观测块（python 路径才有）
}

/** Phase 7/7.5：日历写入提案（未落日历；确认后才执行）。时间为 Instant + 规划时区。 */
export interface CalendarDraftItem {
  taskId: string;
  taskTitle: string;
  startUtc: string; // ISO-8601 Z（Instant）
  endUtc: string; // ISO-8601 Z（Instant）
  timezone: string; // IANA 规划时区
  calendarId: string;
  actionType: "create";
  reason?: string | null;
  idempotencyKey: string;
  ambiguous?: boolean;
  nonexistent?: boolean;
}

export type CalendarDraftStatus =
  | "pending_confirmation"
  | "confirmed"
  | "executed"
  | "failed"
  | "stale_conflict"
  | "duplicate_skipped"
  | "cancelled";

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
