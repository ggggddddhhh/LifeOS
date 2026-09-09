import { prisma } from "@/lib/db";
import {
  computePlanDiff,
  enforceTaskBudget,
  enforceTimeBudget,
  sanitizeDependencies,
  sanitizeSchedule,
  type DepGraph,
} from "@/lib/plan";
import { normalizeTitle } from "@/lib/llm/parse";
import { traceEvent } from "@/lib/trace";
import type { PlannedTask, PlanDiff } from "@/lib/types";

/**
 * Replan 共享管线（Phase 10：预览 → 确认 → 应用 → 可撤销）。
 * 预览与应用跑同一套确定性守卫（LLM 只参与预览阶段），应用不重复调用 LLM。
 */

export interface ReplanAgentResult {
  reason: string;
  tasks: PlannedTask[];
  capacityMinutes?: number | null;
  finalize?: { finalizeAdjusted?: boolean; reason?: string } | null;
}

export interface ConvergedPlan {
  finalTasks: PlannedTask[];
  deps: DepGraph;
  budgetNote: string | null;
  invariantBreach: boolean;
  userPreserved: number;
}

/** DB Task（含 dependsOn 标题）→ PlannedTask（origin=user 的任务以 DB 字段为准）。 */
export function toPlannedTasks(
  tasks: {
    title: string;
    notes: string | null;
    priority: number;
    estMinutes: number;
    startDate: Date | null;
    dueDate: Date | null;
    durationDays: number | null;
    dependsOn: { title: string }[];
  }[],
): PlannedTask[] {
  return tasks.map((t) => ({
    title: t.title,
    notes: t.notes ?? undefined,
    priority: t.priority,
    estMinutes: t.estMinutes,
    startDate: t.startDate ? t.startDate.toISOString().slice(0, 10) : undefined,
    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : undefined,
    durationDays: t.durationDays ?? undefined,
    dependsOn: t.dependsOn.map((d) => d.title),
  }));
}

/**
 * 确定性收敛：清洗依赖 → 排期清洗 → 任务数守卫 → 容量守卫 → 丢弃已完成同名。
 * Phase 11 用户优先：origin=user 的任务以 DB 快照原样保留（标题/估时/优先级/日期/依赖
 * 均不被 LLM 提议改写，也不因 LLM 未提及而丢失）；容量与任务数守卫只作用于 AI 任务，
 * 用户任务的投入从可用容量中先扣除。
 */
export function convergePlanTasks(
  rawTasks: PlannedTask[],
  ctx: {
    today: string;
    deadlineIso: string | null;
    workdaysLeft: number; // 剩余工作日数（策略 workdays 口径；无截止日回退 14）
    capacityPerDay: number; // 每日可投入分钟数（策略）
    capacityMinutes: number | null;
    oldOpenTitles: Set<string>;
    doneTitles: Set<string>;
    finalizePresent: boolean;
    userTasks?: PlannedTask[]; // origin=user 的未完成任务（权威，不被改写）
  },
): ConvergedPlan {
  const userTasks = ctx.userTasks ?? [];
  const merged = [...userTasks, ...rawTasks];

  // 用户任务的日期冻结：sanitizeSchedule 的钳制/传播只应作用于 AI 任务（用户日期是权威输入）
  const frozenDates = userTasks.map((t) => ({ startDate: t.startDate, dueDate: t.dueDate }));

  const { deps } = sanitizeDependencies(merged);
  sanitizeSchedule(merged, deps, { today: ctx.today, deadline: ctx.deadlineIso });
  userTasks.forEach((t, i) => {
    t.startDate = frozenDates[i].startDate;
    t.dueDate = frozenDates[i].dueDate;
  });

  // 任务数守卫只数 AI 任务：用户任务不占反扩散配额（配额随用户任务数自然上浮）
  const afterCountGuard = enforceTaskBudget(rawTasks, ctx.oldOpenTitles);

  // 用户投入先扣容量，AI 任务在剩余预算内收敛（统一走 override 通道：
  // enforceTimeBudget 对 capPerDay 会再乘 daysLeft，语义不同）
  const userLoad = userTasks.reduce((s, t) => s + t.estMinutes, 0);
  const rawCapacity =
    ctx.capacityMinutes !== null && ctx.capacityMinutes !== undefined && ctx.capacityMinutes >= 0
      ? ctx.capacityMinutes
      : ctx.workdaysLeft * ctx.capacityPerDay;
  const budget = enforceTimeBudget(afterCountGuard, ctx.workdaysLeft, ctx.capacityPerDay, Math.max(15, rawCapacity - userLoad));

  let finalTasks = [...userTasks, ...budget.tasks];
  // 丢弃与已完成任务同名的条目：LLM 偶尔会"复活"已完成工作（Phase 2 评测发现）
  finalTasks = finalTasks.filter((t) => !ctx.doneTitles.has(normalizeTitle(t.title)));

  // Phase 6 invariant breach 检测：Python finalize 已收敛而 TS 守卫仍在修改 = 语义漂移信号
  let invariantBreach = false;
  if (ctx.finalizePresent) {
    const trimmedByCount = afterCountGuard.length < rawTasks.length;
    const trimmedByTime = budget.note !== null;
    const trimmedByDone = finalTasks.length < merged.length;
    if (trimmedByCount || trimmedByTime || trimmedByDone) {
      invariantBreach = true;
    }
  }
  const budgetNote = budget.note ? (userTasks.length > 0 ? `用户任务优先保留后，AI 任务${budget.note}` : budget.note) : null;
  return { finalTasks, deps, budgetNote, invariantBreach, userPreserved: userTasks.length };
}

/** 应用前快照当前未完成任务（含依赖标题），供撤销恢复。
 *  只快照未完成任务：undo 只重写未完成任务，已完成任务永不被触碰（避免恢复时与
 *  存留的完成任务重复——快照含 done 会让 undo 复制出第二份）。 */
export interface TaskSnapshotForUndo {
  title: string;
  notes: string | null;
  status: string;
  priority: number;
  estMinutes: number;
  order: number;
  startDate: string | null;
  dueDate: string | null;
  durationDays: number | null;
  origin: string; // ai | user（撤销恢复时原样带回，用户设定不因撤销丢失）
  deps: string[];
}

export function snapshotOpenTasks(tasks: TaskSnapshotForUndoInput[]): TaskSnapshotForUndo[] {
  return tasks
    .filter((t) => t.status !== "done")
    .map((t) => ({
      title: t.title,
      notes: t.notes,
      status: t.status,
      priority: t.priority,
      estMinutes: t.estMinutes,
      order: t.order,
      startDate: t.startDate?.toISOString().slice(0, 10) ?? null,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
      durationDays: t.durationDays,
      origin: t.origin ?? "ai",
      deps: t.dependsOn.map((d) => d.title),
    }));
}

export interface TaskSnapshotForUndoInput {
  title: string;
  notes: string | null;
  status: string;
  priority: number;
  estMinutes: number;
  order: number;
  startDate: Date | null;
  dueDate: Date | null;
  durationDays: number | null;
  origin?: string | null;
  dependsOn: { title: string }[];
}

/**
 * 事务内重写未完成任务：删旧建新 + 连依赖 + revision+1 + PlanVersion（含应用前快照）。
 * 预览确认后的 apply 与旧版直接 POST 共用此落库路径，行为与 Phase 2 起完全一致。
 */
export async function applyReplanTasks(params: {
  goalId: string;
  finalTasks: PlannedTask[];
  deps: DepGraph;
  reason: string;
  diff: PlanDiff;
  snapshot: TaskSnapshotForUndo[];
  runId: string;
  userTitleKeys?: Set<string>; // origin=user 的任务标题（归一化）：重建时保留用户设定标记
}) {
  const { goalId, finalTasks, deps, reason, diff, snapshot, runId, userTitleKeys } = params;
  const updated = await prisma.$transaction(async (tx) => {
    // 保留已完成任务，重写未完成任务
    await tx.task.deleteMany({ where: { goalId, status: { not: "done" } } });
    const remaining = await tx.task.findMany({ where: { goalId } });
    const baseOrder = remaining.length;
    const created: { id: string; title: string }[] = [];
    for (let i = 0; i < finalTasks.length; i++) {
      const t = finalTasks[i];
      const task = await tx.task.create({
        data: {
          goalId,
          title: t.title,
          notes: t.notes,
          priority: t.priority,
          estMinutes: t.estMinutes,
          order: baseOrder + i,
          startDate: t.startDate ? new Date(`${t.startDate}T00:00:00Z`) : undefined,
          dueDate: t.dueDate ? new Date(`${t.dueDate}T00:00:00Z`) : undefined,
          durationDays: t.durationDays,
          origin: userTitleKeys?.has(normalizeTitle(t.title)) ? "user" : "ai",
        },
      });
      created.push({ id: task.id, title: task.title });
    }
    // 连接依赖：新任务之间 + 对保留(done)任务的依赖
    const idByTitle = new Map(created.map((c) => [normalizeTitle(c.title), c.id]));
    for (const done of remaining) idByTitle.set(normalizeTitle(done.title), done.id);
    for (const [key, ds] of Object.entries(deps)) {
      if (ds.length === 0) continue;
      const taskId = idByTitle.get(key);
      const targets = ds.map((d) => idByTitle.get(d)).filter((v): v is string => !!v);
      if (!taskId || targets.length === 0) continue;
      await tx.task.update({
        where: { id: taskId },
        data: { dependsOn: { connect: targets.map((tid) => ({ id: tid })) } },
      });
    }
    const goalUpdated = await tx.goal.update({
      where: { id: goalId },
      data: { revision: { increment: 1 } },
      include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { id: true, title: true } } } } },
    });
    await tx.planVersion.create({
      data: {
        goalId,
        revision: goalUpdated.revision,
        reason,
        diffJson: JSON.stringify(diff),
        snapshotJson: JSON.stringify(snapshot),
      },
    });
    return goalUpdated;
  });
  traceEvent("replan_apply", {
    runId,
    goalId,
    ok: true,
    planVersion: updated.revision,
    tasksOut: finalTasks.length,
    snapshotTasks: snapshot.length,
  });
  return updated;
}

/** 撤销最近一次重排：按 PlanVersion.snapshotJson 恢复任务列表（含状态与依赖）。 */
export async function undoLastReplan(goalId: string, runId: string) {
  const goal = await prisma.goal.findUnique({
    where: { id: goalId },
    include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { title: true } } } } },
  });
  if (!goal) return { error: "目标不存在" as const, status: 404 as const };

  // 逐级回退（稳定性验证 S7 发现 #5）：取「最新未被撤销消费过」的快照版本。
  // 不再绑死 goal.revision——撤销版本本身无快照，绑死会让上一级快照永远不可达，
  // 第二次撤销直接 400。undoneAt 标记消费，连续撤销沿版本链逐级向前。
  const version = await prisma.planVersion.findFirst({
    where: { goalId, snapshotJson: { not: null }, undoneAt: null },
    orderBy: { revision: "desc" },
  });
  if (!version || !version.snapshotJson) {
    return { error: "没有可恢复的历史快照（更早的变更没有留快照，或都已撤销过）" as const, status: 400 as const };
  }

  const snapshot = JSON.parse(version.snapshotJson) as TaskSnapshotForUndo[];
  const currentOpen = goal.tasks.filter((t) => t.status !== "done");
  const oldOpen = currentOpen.map((t) => ({
    title: t.title,
    estMinutes: t.estMinutes,
    dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
  }));
  const restored = snapshot.map((s) => ({
    title: s.title,
    estMinutes: s.estMinutes,
    dueDate: s.dueDate,
  }));
  const diff = computePlanDiff(oldOpen, restored);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.task.deleteMany({ where: { goalId, status: { not: "done" } } });
    const remaining = await tx.task.findMany({ where: { goalId } });
    const baseOrder = remaining.length;
    const created: { id: string; title: string }[] = [];
    for (let i = 0; i < snapshot.length; i++) {
      const s = snapshot[i];
      const task = await tx.task.create({
        data: {
          goalId,
          title: s.title,
          notes: s.notes ?? undefined,
          status: s.status,
          priority: s.priority,
          estMinutes: s.estMinutes,
          order: baseOrder + i,
          startDate: s.startDate ? new Date(`${s.startDate}T00:00:00Z`) : undefined,
          dueDate: s.dueDate ? new Date(`${s.dueDate}T00:00:00Z`) : undefined,
          durationDays: s.durationDays ?? undefined,
          origin: s.origin === "user" ? "user" : "ai",
        },
      });
      created.push({ id: task.id, title: task.title });
    }
    const idByTitle = new Map(created.map((c) => [normalizeTitle(c.title), c.id]));
    for (const done of remaining) idByTitle.set(normalizeTitle(done.title), done.id);
    for (const s of snapshot) {
      if (s.deps.length === 0) continue;
      const taskId = idByTitle.get(normalizeTitle(s.title));
      const targets = s.deps.map((d) => idByTitle.get(normalizeTitle(d))).filter((v): v is string => !!v);
      if (!taskId || targets.length === 0) continue;
      await tx.task.update({
        where: { id: taskId },
        data: { dependsOn: { connect: targets.map((tid) => ({ id: tid })) } },
      });
    }
    const goalUpdated = await tx.goal.update({
      where: { id: goalId },
      data: { revision: { increment: 1 } },
      include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { id: true, title: true } } } } },
    });
    await tx.planVersion.create({
      data: {
        goalId,
        revision: goalUpdated.revision,
        reason: `撤销重排：恢复「${version.reason.slice(0, 40)}」之前的任务列表`,
        diffJson: JSON.stringify(diff),
      },
    });
    // 标记该快照已被消费：下一次撤销继续向前找更早的未消费快照（逐级回退）
    await tx.planVersion.update({
      where: { id: version.id },
      data: { undoneAt: new Date() },
    });
    return goalUpdated;
  });
  traceEvent("replan_undo", { runId, goalId, ok: true, planVersion: updated.revision, restored: snapshot.length });
  return { goal: updated };
}
