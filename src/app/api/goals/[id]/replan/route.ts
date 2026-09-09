import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { agentReplanGoal } from "@/lib/agent/client";
import { computePlanDiff, enforceTaskBudget, enforceTimeBudget, sanitizeDependencies, sanitizeSchedule } from "@/lib/plan";
import { normalizeTitle } from "@/lib/llm/parse";
import type { PlanDiff, TaskSnapshot } from "@/lib/types";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const goal = await prisma.goal.findUnique({
      where: { id },
      include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
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
    });

    // Phase 2：清洗 + 反扩散 guard + diff（在改动数据库前完成全部计算）
    const { deps } = sanitizeDependencies(result.tasks);
    const today = new Date().toISOString().slice(0, 10);
    sanitizeSchedule(result.tasks, deps, { today, deadline: goal.deadline?.toISOString().slice(0, 10) ?? null });
    const oldOpenTitles = new Set(openTasks.map((t) => normalizeTitle(t.title)));
    let finalTasks = enforceTaskBudget(result.tasks, oldOpenTitles);
    // 容量输入源扩展：Agent 返回真实可用容量（Calendar 观察/用户声明）时覆写默认 480×天数
    const budget = enforceTimeBudget(finalTasks, daysLeft, 480, result.capacityMinutes ?? null);
    finalTasks = budget.tasks;
    // 丢弃与已完成任务同名的条目：LLM 偶尔会"复活"已完成工作（Phase 2 评测发现）
    const doneTitles = new Set(goal.tasks.filter((t) => t.status === "done").map((t) => normalizeTitle(t.title)));
    finalTasks = finalTasks.filter((t) => !doneTitles.has(normalizeTitle(t.title)));
    const reason = budget.note ? `${result.reason}（${budget.note}）` : result.reason;

    const oldOpen = openTasks.map((t) => ({
      title: t.title,
      estMinutes: t.estMinutes,
      dueDate: t.dueDate?.toISOString().slice(0, 10) ?? null,
    }));
    const diff: PlanDiff = computePlanDiff(oldOpen, finalTasks);

    const updated = await prisma.$transaction(async (tx) => {
      // 保留已完成任务，重写未完成任务
      await tx.task.deleteMany({ where: { goalId: goal.id, status: { not: "done" } } });
      const remaining = await tx.task.findMany({ where: { goalId: goal.id } });
      const baseOrder = remaining.length;
      const created: { id: string; title: string }[] = [];
      for (let i = 0; i < finalTasks.length; i++) {
        const t = finalTasks[i];
        const task = await tx.task.create({
          data: {
            goalId: goal.id,
            title: t.title,
            notes: t.notes,
            priority: t.priority,
            estMinutes: t.estMinutes,
            order: baseOrder + i,
            startDate: t.startDate ? new Date(`${t.startDate}T00:00:00Z`) : undefined,
            dueDate: t.dueDate ? new Date(`${t.dueDate}T00:00:00Z`) : undefined,
            durationDays: t.durationDays,
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
        where: { id: goal.id },
        data: { revision: { increment: 1 } },
        include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { id: true, title: true } } } } },
      });
      await tx.planVersion.create({
        data: {
          goalId: goal.id,
          revision: goalUpdated.revision,
          reason: reason,
          diffJson: JSON.stringify(diff),
        },
      });
      return goalUpdated;
    });

    return NextResponse.json({ ok: true, data: { reason, diff, goal: updated } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Replan 失败" },
      { status: 500 },
    );
  }
}
