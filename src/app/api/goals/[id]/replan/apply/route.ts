import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { computePlanDiff } from "@/lib/plan";
import { normalizeTitle } from "@/lib/llm/parse";
import { traceEvent } from "@/lib/trace";
import { applyReplanTasks, convergePlanTasks, snapshotOpenTasks, toPlannedTasks } from "@/lib/replan";
import { getPlanningPolicy } from "@/lib/policy";
import { workdaysLeft } from "@/lib/policy-core";
import { toStableConflictError } from "@/lib/conflict";
import type { PlannedTask } from "@/lib/types";

/**
 * POST /api/goals/:id/replan/apply —— 应用预览确认过的新计划。
 * 输入是 /replan?preview=1 返回的任务列表；本路由不调用 LLM，只在服务端重跑同一套
 * 确定性守卫（清洗/预算/去重），然后事务落库并写入应用前快照（供撤销）。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const t0 = Date.now();
  const runId = crypto.randomUUID().slice(0, 8);
  let goalId = "";
  try {
    const { id } = await ctx.params;
    goalId = id;
    const body = (await req.json().catch(() => ({}))) as {
      reasonBase?: unknown;
      tasks?: unknown;
      capacityMinutes?: unknown;
    };
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return NextResponse.json({ ok: false, error: "缺少待应用的任务计划" }, { status: 400 });
    }
    const reasonBase = typeof body.reasonBase === "string" ? body.reasonBase : "";

    const goal = await prisma.goal.findUnique({
      where: { id },
      include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { id: true, title: true } } } } },
    });
    if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });
    const openTasks = goal.tasks.filter((t) => t.status !== "done");
    if (openTasks.length === 0) {
      return NextResponse.json({ ok: false, error: "所有任务已完成，无需重新计划" }, { status: 400 });
    }

    const capacityMinutes = typeof body.capacityMinutes === "number" ? body.capacityMinutes : null;
    // Phase 12：与预览同一策略口径（工作日 × 每日可投入）
    const policy = await getPlanningPolicy();
    const wdLeft = goal.deadline
      ? Math.max(1, workdaysLeft(goal.deadline.toISOString(), policy.workdays))
      : 14;

    // 用户任务以 DB 为准（预览列表中的同名条目是当时的副本，可能已过期）：
    // 剔除后与 DB 快照一并交给收敛管线，保证「用户优先」在 apply 时依然成立。
    const userOpen = openTasks.filter((t) => t.origin === "user");
    const userKeys = new Set(userOpen.map((t) => normalizeTitle(t.title)));
    const userTasks = toPlannedTasks(userOpen);
    const aiProposed = (body.tasks as PlannedTask[]).filter((t) => !userKeys.has(normalizeTitle(t.title)));

    // 与预览阶段同一套守卫：即使预览与确认之间任务状态有变，也不会写入越界计划
    const converged = convergePlanTasks(aiProposed, {
      today: new Date().toISOString().slice(0, 10),
      deadlineIso: goal.deadline?.toISOString().slice(0, 10) ?? null,
      workdaysLeft: wdLeft,
      capacityPerDay: policy.dailyCapacityMinutes,
      capacityMinutes,
      oldOpenTitles: new Set(openTasks.filter((t) => t.origin !== "user").map((t) => normalizeTitle(t.title))),
      doneTitles: new Set(goal.tasks.filter((t) => t.status === "done").map((t) => normalizeTitle(t.title))),
      finalizePresent: false,
      userTasks,
    });
    if (converged.finalTasks.length === 0) {
      return NextResponse.json({ ok: false, error: "计划在约束收敛后为空，已取消应用" }, { status: 400 });
    }
    const reason =
      (converged.userPreserved > 0 ? `已保留 ${converged.userPreserved} 项你手动设定的任务。` : "") +
      (reasonBase || "重新规划") +
      (converged.budgetNote ? `（${converged.budgetNote}）` : "");

    const oldOpen = openTasks.map((t) => ({
      title: t.title,
      estMinutes: t.estMinutes,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
    }));
    const diff = computePlanDiff(oldOpen, converged.finalTasks);

    const updated = await applyReplanTasks({
      goalId: goal.id,
      finalTasks: converged.finalTasks,
      deps: converged.deps,
      reason: reason || "重新规划",
      diff,
      snapshot: snapshotOpenTasks(goal.tasks),
      runId,
      userTitleKeys: userKeys,
    });
    traceEvent("replan_apply_route", { runId, goalId, ok: true, planVersion: updated.revision, latencyMs: Date.now() - t0 });
    return NextResponse.json({
      ok: true,
      data: { reason, diff, goal: updated, revision: updated.revision },
    });
  } catch (e) {
    traceEvent("replan_apply_route", { runId, goalId, ok: false, error: e instanceof Error ? e.message : "apply failed" });
    const stable = toStableConflictError(e);
    if (stable) {
      return NextResponse.json({ ok: false, error: stable.message }, { status: stable.status });
    }
    return NextResponse.json(
      { ok: false, error: "应用计划失败，请稍后重试" },
      { status: 500 },
    );
  }
}
