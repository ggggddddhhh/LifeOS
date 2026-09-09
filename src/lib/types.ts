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
}

export interface ReplanResult {
  reason: string; // 一句话说明为何这样调整
  tasks: PlannedTask[]; // 未完成部分的全新计划
  capacityMinutes?: number | null; // 实际采用的可用容量（Calendar 观察/用户声明时返回）
}

export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
