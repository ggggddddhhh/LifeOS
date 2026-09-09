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
  estMinutes: number;
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
}

export interface ReplanInput {
  goalTitle: string;
  goalDescription?: string;
  deadline?: string; // ISO
  daysLeft: number;
  tasks: TaskSnapshot[]; // 当前全部任务（含 done）
}

export interface ReplanResult {
  reason: string; // 一句话说明为何这样调整
  tasks: PlannedTask[]; // 未完成部分的全新计划
}

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
