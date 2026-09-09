import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { planGoal } from "@/lib/llm";
import { sanitizeDependencies, sanitizeSchedule, computePlanDiff } from "@/lib/plan";
import { normalizeTitle } from "@/lib/llm/parse";

export async function GET() {
  const goals = await prisma.goal.findMany({
    where: { status: "active" },
    include: {
      tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { id: true, title: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ ok: true, data: goals });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      title?: string;
      description?: string;
      deadline?: string;
    };
    const title = body.title?.trim();
    if (!title) {
      return NextResponse.json({ ok: false, error: "title 必填" }, { status: 400 });
    }
    const deadline = body.deadline ? new Date(body.deadline) : undefined;
    if (deadline && isNaN(deadline.getTime())) {
      return NextResponse.json({ ok: false, error: "deadline 格式无效" }, { status: 400 });
    }

    const planned = await planGoal({
      title,
      description: body.description?.trim() || undefined,
      deadline: deadline?.toISOString(),
    });

    // Phase 2：依赖清洗 + 调度清洗（LLM 提议，代码强制）
    const { deps } = sanitizeDependencies(planned);
    const today = new Date().toISOString().slice(0, 10);
    sanitizeSchedule(planned, deps, { today, deadline: deadline?.toISOString().slice(0, 10) ?? null });

    const goal = await prisma.$transaction(async (tx) => {
      const goal = await tx.goal.create({
        data: {
          title,
          description: body.description?.trim() || undefined,
          deadline: deadline ?? undefined,
        },
      });
      const created: { id: string; title: string }[] = [];
      for (let i = 0; i < planned.length; i++) {
        const t = planned[i];
        const task = await tx.task.create({
          data: {
            goalId: goal.id,
            title: t.title,
            notes: t.notes,
            priority: t.priority,
            estMinutes: t.estMinutes,
            order: i,
            startDate: t.startDate ? new Date(`${t.startDate}T00:00:00Z`) : undefined,
            dueDate: t.dueDate ? new Date(`${t.dueDate}T00:00:00Z`) : undefined,
            durationDays: t.durationDays,
          },
        });
        created.push({ id: task.id, title: task.title });
      }
      // 连接依赖（标题 → id，已在 sanitizeDependencies 中保证引用存在且无环）
      const idByTitle = new Map(created.map((c) => [normalizeTitle(c.title), c.id]));
      for (const [key, ds] of Object.entries(deps)) {
        if (ds.length === 0) continue;
        const taskId = idByTitle.get(key);
        if (!taskId) continue;
        await tx.task.update({
          where: { id: taskId },
          data: { dependsOn: { connect: ds.map((d) => ({ id: idByTitle.get(d)! })) } },
        });
      }
      // 初始计划版本（diff = 全部新增）
      const diff = computePlanDiff([], planned);
      await tx.planVersion.create({
        data: {
          goalId: goal.id,
          revision: 1,
          reason: "初始计划：AI 拆解目标",
          diffJson: JSON.stringify(diff),
        },
      });
      return tx.goal.findUnique({
        where: { id: goal.id },
        include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], include: { dependsOn: { select: { id: true, title: true } } } } },
      });
    });

    return NextResponse.json({ ok: true, data: goal }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "创建目标失败" },
      { status: 500 },
    );
  }
}
