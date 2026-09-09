import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentReplanGoal, recentAgentCalls } from "@/lib/agent/client";
import { computePlanDiff } from "@/lib/plan";
import { normalizeTitle } from "@/lib/llm/parse";
import { traceEvent } from "@/lib/trace";
import { applyReplanTasks, convergePlanTasks, snapshotOpenTasks, toPlannedTasks } from "@/lib/replan";
import { getPlanningPolicy } from "@/lib/policy";
import { declaredMinutesPerDay, workdaysLeft } from "@/lib/policy-core";
import { toStableConflictError } from "@/lib/conflict";
import type { PlanDiff, TaskSnapshot } from "@/lib/types";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const t0 = Date.now();
  const runId = crypto.randomUUID().slice(0, 8); // Phase 9.5：请求级关联（web/agent trace 串联）
  // Phase 10：?preview=1 只计算并返回新计划（含 diff），不落库——由用户在确认对话框里
  // 审阅后再调 /replan/apply。默认（无 preview）保持旧行为：计算后直接应用。
  const preview = req.nextUrl.searchParams.get("preview") === "1";
  let goalId = "";
  try {
    const { id } = await ctx.params;
    goalId = id;
    const goal = await prisma.goal.findUnique({
      where: { id },
      include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { id: true, title: true } } } } },
    });
    if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });

    // 没有未完成任务时直接短路，避免 LLM 凭空发明新任务（Phase 1.5 评测发现）
    const openTasks = goal.tasks.filter((t) => t.status !== "done");
    if (openTasks.length === 0) {
      return NextResponse.json({ ok: false, error: "所有任务已完成，无需重新计划" }, { status: 400 });
    }

    const daysLeft = goal.deadline
      ? Math.max(1, Math.ceil((goal.deadline.getTime() - Date.now()) / 86400000))
      : 14;
    // Phase 12：策略驱动的容量口径（工作日 × 每日可投入）；LLM 输入仍用日历天数
    const policy = await getPlanningPolicy();
    const wdLeft = goal.deadline
      ? Math.max(0, workdaysLeft(goal.deadline.toISOString(), policy.workdays))
      : 14;

    const snapshots: TaskSnapshot[] = goal.tasks.map((t) => ({
      title: t.title,
      status: t.status as TaskSnapshot["status"],
      estMinutes: t.estMinutes,
      priority: t.priority,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
    }));

    const result = await agentReplanGoal({
      goalTitle: goal.title,
      goalDescription: goal.description ?? undefined,
      deadline: goal.deadline?.toISOString(),
      daysLeft,
      tasks: snapshots,
      declaredMinutesPerDay: declaredMinutesPerDay(daysLeft, policy),
    }, runId);

    const oldOpenTitles = new Set(openTasks.filter((t) => t.origin !== "user").map((t) => normalizeTitle(t.title)));
    const doneTitles = new Set(goal.tasks.filter((t) => t.status === "done").map((t) => normalizeTitle(t.title)));
    const userTasks = toPlannedTasks(openTasks.filter((t) => t.origin === "user"));
    // 用户任务以 DB 为准：LLM 回显的同名条目（常见，字段可能已被改写）必须剔除，
    // 否则与 DB 快照合并后同名任务出现两份（稳定性验证 S4 发现）
    const userKeys = new Set(userTasks.map((t) => normalizeTitle(t.title)));
    const aiProposed = result.tasks.filter((t) => !userKeys.has(normalizeTitle(t.title)));
    const converged = convergePlanTasks(aiProposed, {
      today: new Date().toISOString().slice(0, 10),
      deadlineIso: goal.deadline?.toISOString().slice(0, 10) ?? null,
      workdaysLeft: Math.max(1, wdLeft),
      capacityPerDay: policy.dailyCapacityMinutes,
      capacityMinutes: result.capacityMinutes ?? null,
      oldOpenTitles,
      doneTitles,
      finalizePresent: !!result.finalize,
      userTasks,
    });
    if (converged.invariantBreach) {
      // Phase 6 invariant breach：TS 守卫修改了 Agent 已收敛的计划，必须显式记录，绝不静默
      console.error(
        `[invariant-breach] TS 守卫修改了 Agent 已收敛的计划; ` +
          `python finalize=${JSON.stringify(result.finalize)}`,
      );
    }
    const reason =
      (converged.userPreserved > 0 ? `已保留 ${converged.userPreserved} 项你手动设定的任务。` : "") +
      result.reason +
      (converged.budgetNote ? `（${converged.budgetNote}）` : "");

    const oldOpen = openTasks.map((t) => ({
      title: t.title,
      estMinutes: t.estMinutes,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
    }));
    const diff: PlanDiff = computePlanDiff(oldOpen, converged.finalTasks);

    if (preview) {
      const lastCall = recentAgentCalls().at(-1);
      traceEvent("replan_preview", {
        runId,
        goalId,
        ok: true,
        openIn: openTasks.length,
        tasksOut: converged.finalTasks.length,
        diff: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
        capacityMinutes: result.capacityMinutes ?? null,
        finalizeAdjusted: result.finalize?.finalizeAdjusted ?? null,
        invariantBreach: converged.invariantBreach,
        agentProvider: lastCall?.provider ?? null,
        agentFallbackReason: lastCall?.fallbackReason ?? null,
        agentLatencyMs: lastCall?.latencyMs ?? null,
        latencyMs: Date.now() - t0,
      });
      return NextResponse.json({
        ok: true,
        data: {
          preview: true,
          reason,
          diff,
          tasks: converged.finalTasks,
          capacityMinutes: result.capacityMinutes ?? null,
          finalize: result.finalize ?? null,
        },
      });
    }

    const updated = await applyReplanTasks({
      goalId: goal.id,
      finalTasks: converged.finalTasks,
      deps: converged.deps,
      reason,
      diff,
      snapshot: snapshotOpenTasks(goal.tasks),
      runId,
      userTitleKeys: new Set(userTasks.map((t) => normalizeTitle(t.title))),
    });

    const lastCall = recentAgentCalls().at(-1);
    traceEvent("replan", {
      runId,
      goalId,
      ok: true,
      planVersion: updated.revision,
      openIn: openTasks.length,
      tasksOut: converged.finalTasks.length,
      diff: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length },
      capacityMinutes: result.capacityMinutes ?? null,
      finalizeAdjusted: result.finalize?.finalizeAdjusted ?? null,
      invariantBreach: converged.invariantBreach,
      agentProvider: lastCall?.provider ?? null,
      agentFallbackReason: lastCall?.fallbackReason ?? null,
      agentLatencyMs: lastCall?.latencyMs ?? null,
      latencyMs: Date.now() - t0,
    });

    return NextResponse.json({
      ok: true,
      data: { reason, diff, goal: updated, finalize: result.finalize ?? null },
    });
  } catch (e) {
    traceEvent("replan", { runId, goalId, ok: false, error: e instanceof Error ? e.message : "replan failed", latencyMs: Date.now() - t0 });
    // 并发删除等冲突 → 稳定错误码，绝不透传 Prisma 内部信息（稳定性验证发现 #3）
    const stable = toStableConflictError(e);
    if (stable) {
      return NextResponse.json({ ok: false, error: stable.message }, { status: stable.status });
    }
    return NextResponse.json(
      { ok: false, error: "重新规划失败，请稍后重试" },
      { status: 500 },
    );
  }
}
