import type { Goal, Task } from "@prisma/client";
import { computePlanDiff } from "@/lib/plan";
import { workdaysLeft, type PlanningPolicy } from "@/lib/policy-core";
import type { PlanDiff } from "@/lib/types";

/**
 * 手动任务编辑的确定性守卫（Phase 11：用户对 AI Plan 的最终控制权）。
 *
 * 原则（借鉴 Cline/Vikunja/Plane/Super Productivity，适配 PlanShift 单用户本地场景）：
 * - 用户改的是事实：schedule 越界（< 今天 / > 截止）与依赖成环 → 硬拒绝（400）；
 * - 容量超载 → 只警告不阻断（用户有权超额，警告在确认步骤呈现）；
 * - 已写入日历的任务被改 → 只提示（calendarHint），绝不自动 Update/Delete 日历事件；
 * - 并发防覆盖：expectedUpdatedAt 不匹配 → 409（乐观锁，Vikunja v2「防静默覆盖」的服务端化）。
 */

export const TASK_ORIGIN = { AI: "ai", USER: "user" } as const;

export interface TaskEditPatch {
  title?: string;
  notes?: string | null;
  priority?: number;
  estMinutes?: number;
  dueDate?: string | null; // YYYY-MM-DD | null（清除）
  dependsOnIds?: string[]; // 全量替换依赖（同 goal 内其他任务 id）
}

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface TaskEditCheck {
  ok: boolean;
  error?: string;
  changes: FieldChange[];
  warnings: string[];
  calendarHint: boolean;
  newDiff?: PlanDiff;
  /** 编辑后（含同 goal 其他未完成任务）用于容量计算的任务列表 */
  projectedOpen: { title: string; estMinutes: number; dueDate: string | null }[];
}

const PRIORITY_LABEL: Record<number, string> = { 1: "高", 2: "中", 3: "低" };

function isValidDateStr(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(new Date(`${v}T00:00:00Z`).getTime());
}

/**
 * 校验并投影一次任务编辑。goal.tasks 需含 dependsOn（至少 {id,title}）。
 * 返回 ok=false 时 error 面向用户；否则 changes/warnings 供 Preview 呈现。
 */
export function checkTaskEdit(params: {
  task: Task & { dependsOn: { id: string; title: string }[] };
  goal: Goal;
  siblings: (Task & { dependsOn: { id: string; title: string }[] })[]; // 同 goal 全部任务（含 task 自身）
  patch: TaskEditPatch;
  policy: PlanningPolicy; // Phase 12：容量口径 = 剩余工作日 × 每日可投入（策略）
}): TaskEditCheck {
  const { task, goal, siblings, patch, policy } = params;
  const changes: FieldChange[] = [];
  const warnings: string[] = [];

  // ---- 字段级校验 ----
  let newTitle = task.title;
  if (patch.title !== undefined) {
    newTitle = patch.title.trim();
    if (newTitle.length === 0) return fail("任务标题不能为空");
    if (newTitle.length > 120) return fail("任务标题过长（≤120 字）");
    if (
      newTitle !== task.title &&
      siblings.some((s) => s.id !== task.id && s.title.trim() === newTitle)
    ) {
      return fail(`同名任务已存在：「${newTitle}」`);
    }
    if (newTitle !== task.title) changes.push({ field: "标题", from: task.title, to: newTitle });
  }

  let newEst = task.estMinutes;
  if (patch.estMinutes !== undefined) {
    if (!Number.isInteger(patch.estMinutes)) return fail("预计时长必须是整数分钟");
    if (patch.estMinutes < 5 || patch.estMinutes > 1440) return fail("预计时长需在 5–1440 分钟之间");
    newEst = patch.estMinutes;
    if (newEst !== task.estMinutes) changes.push({ field: "预计时长", from: `${task.estMinutes}m`, to: `${newEst}m` });
  }

  let newPriority = task.priority;
  if (patch.priority !== undefined) {
    if (![1, 2, 3].includes(patch.priority)) return fail("优先级必须是 1（高）/2（中）/3（低）");
    newPriority = patch.priority;
    if (newPriority !== task.priority)
      changes.push({ field: "优先级", from: PRIORITY_LABEL[task.priority] ?? String(task.priority), to: PRIORITY_LABEL[newPriority] ?? String(newPriority) });
  }

  let newDue: string | null = task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null;
  if (patch.dueDate !== undefined) {
    if (patch.dueDate === null) {
      newDue = null;
    } else {
      if (!isValidDateStr(patch.dueDate)) return fail("截止日期格式无效（应为 YYYY-MM-DD）");
      newDue = patch.dueDate;
    }
    const oldDue = task.dueDate ? task.dueDate.toISOString().slice(0, 10) : "无";
    const dueTo = newDue ?? "无";
    if (dueTo !== oldDue) changes.push({ field: "截止日期", from: oldDue, to: dueTo });
  }

  // schedule guard（硬约束）：dueDate ∈ [today, goal.deadline]
  const today = new Date().toISOString().slice(0, 10);
  if (newDue !== null) {
    if (newDue < today) return fail(`截止日期不能早于今天（${today}）`);
    if (goal.deadline) {
      const deadline = goal.deadline.toISOString().slice(0, 10);
      if (newDue > deadline) return fail(`截止日期不能晚于目标截止日（${deadline}）`);
    }
  }

  if (patch.notes !== undefined && patch.notes !== task.notes) {
    changes.push({ field: "备注", from: task.notes ? "有" : "无", to: patch.notes ? "有" : "无" });
  }

  // ---- 依赖校验（环检测，硬拒绝）----
  let newDepIds: string[] = task.dependsOn.map((d) => d.id);
  if (patch.dependsOnIds !== undefined) {
    const siblingIds = new Set(siblings.filter((s) => s.id !== task.id).map((s) => s.id));
    if (patch.dependsOnIds.some((id) => !siblingIds.has(id))) {
      return fail("依赖引用了不存在的任务");
    }
    newDepIds = [...new Set(patch.dependsOnIds)];
    if (newDepIds.length !== task.dependsOn.length || newDepIds.some((id) => !task.dependsOn.some((d) => d.id === id))) {
      const nameOf = (id: string) => siblings.find((s) => s.id === id)?.title ?? id;
      changes.push({
        field: "依赖",
        from: task.dependsOn.map((d) => d.title).join("、") || "无",
        to: newDepIds.map(nameOf).join("、") || "无",
      });
    }
  }
  if (newDepIds.length > 0) {
    const cycle = findCycleAfterEdit(siblings, task.id, newDepIds);
    if (cycle) return fail(`不能创建循环依赖：${cycle.join(" → ")} → ${cycle[0]}`);
  }

  // ---- 容量 guard（软约束：警告）----
  const projectedOpen = siblings
    .filter((s) => s.status !== "done")
    .map((s) => {
      if (s.id === task.id) {
        return { title: newTitle, estMinutes: newEst, dueDate: newDue };
      }
      return {
        title: s.title,
        estMinutes: s.estMinutes,
        dueDate: s.dueDate ? s.dueDate.toISOString().slice(0, 10) : null,
      };
    });
  const estDelta = newEst - task.estMinutes;
  if (estDelta > 0) {
    const days = goal.deadline
      ? Math.max(1, workdaysLeft(goal.deadline.toISOString(), policy.workdays))
      : 14;
    const openMin = projectedOpen.reduce((s, t) => s + t.estMinutes, 0);
    const capMin = days * policy.dailyCapacityMinutes;
    if (openMin > capMin) {
      warnings.push(
        `调整后剩余工作量 ${Math.round(openMin / 60)}h 将超出估算容量 ${Math.round(capMin / 60)}h（剩 ${days} 个工作日 × ${Math.round(policy.dailyCapacityMinutes / 60)}h/天）`,
      );
    }
  }

  // ---- diff（Preview 呈现）----
  const oldOpen = siblings
    .filter((s) => s.status !== "done")
    .map((s) => ({
      title: s.title,
      estMinutes: s.estMinutes,
      dueDate: s.dueDate ? s.dueDate.toISOString().slice(0, 10) : null,
    }));
  const newDiff = computePlanDiff(oldOpen, projectedOpen.map((t) => ({ ...t, priority: task.priority, dueDate: t.dueDate ?? undefined })));

  return { ok: true, changes, warnings, calendarHint: false, newDiff, projectedOpen };
}

/** 在「task 的依赖替换为 newDepIds」后检测环；返回构成环的任务标题路径。 */
export function findCycleAfterEdit(
  siblings: { id: string; title: string; dependsOn: { id: string }[] }[],
  taskId: string,
  newDepIds: string[],
): string[] | null {
  const byId = new Map(siblings.map((s) => [s.id, s]));
  // 构造编辑后的依赖图：node -> 它依赖的节点
  const graph = new Map<string, string[]>();
  for (const s of siblings) {
    graph.set(s.id, s.id === taskId ? [...newDepIds] : s.dependsOn.map((d) => d.id));
  }
  // DFS 找环（从 taskId 出发可达自身即成环）
  const visiting = new Set<string>();
  const path: string[] = [];
  const title = (id: string) => byId.get(id)?.title ?? id;
  function dfs(nodeId: string): string[] | null {
    visiting.add(nodeId);
    path.push(nodeId);
    for (const next of graph.get(nodeId) ?? []) {
      if (next === taskId) {
        return [...path, next].map(title);
      }
      if (visiting.has(next)) continue; // 其他既有环不属于本次编辑引入，交由既有清洗兜底
      const found = dfs(next);
      if (found) return found;
    }
    visiting.delete(nodeId);
    path.pop();
    return null;
  }
  return dfs(taskId);
}

/** 版本化描述：手动编辑的 reason 文案。 */
export function describeEdit(changes: FieldChange[], taskTitle: string): string {
  if (changes.length === 0) return `手动调整任务「${taskTitle}」（无字段变化）`;
  const brief = changes.map((c) => `${c.field} ${c.from}→${c.to}`).join("，");
  return `手动调整「${taskTitle}」：${brief.length > 80 ? `${brief.slice(0, 80)}…` : brief}`;
}

function fail(error: string): TaskEditCheck {
  return { ok: false, error, changes: [], warnings: [], calendarHint: false, projectedOpen: [] };
}
