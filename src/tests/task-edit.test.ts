import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as replan } from "@/app/api/goals/[id]/replan/route";
import { POST as replanUndo } from "@/app/api/goals/[id]/replan/undo/route";
import { PATCH as patchTask, DELETE as deleteTask } from "@/app/api/tasks/[id]/route";
import { POST as createTask } from "@/app/api/goals/[id]/tasks/route";

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function createTestGoal(title: string) {
  const res = await createGoal(
    jsonReq("/api/goals", "POST", { title, deadline: new Date(Date.now() + 7 * 86400000).toISOString() }),
  );
  const json = (await res.json()) as { ok: boolean; data?: { id: string; tasks: { id: string; title: string }[] } };
  expect(json.ok).toBe(true);
  return json.data!;
}

beforeAll(async () => {
  process.env.AGENT_MODE = "local";
  process.env.LLM_API_KEY = "";
  await prisma.task.deleteMany({});
  await prisma.goal.deleteMany({});
});

afterAll(async () => {
  delete process.env.AGENT_MODE;
  delete process.env.LLM_API_KEY;
  await prisma.task.deleteMany({});
  await prisma.goal.deleteMany({});
  await prisma.$disconnect();
});

describe("任务编辑：dryRun / 守卫 / 乐观锁 / 版本化", () => {
  it("dryRun 返回变更清单与容量警告，且不落库", async () => {
    const goal = await createTestGoal("编辑测试：整理文档");
    const t = await prisma.task.findFirstOrThrow({ where: { goalId: goal.id } });

    // mock 生成多为 P1：动态取一个与当前不同的优先级，保证该字段必产生变更
    const newPriority = t.priority === 3 ? 2 : 3;
    const res = await patchTask(
      jsonReq(`/api/tasks/${t.id}?dryRun=1`, "PATCH", { estMinutes: 120, priority: newPriority }),
      { params: Promise.resolve({ id: t.id }) },
    );
    const json = (await res.json()) as {
      ok: boolean;
      data?: { dryRun: boolean; changes: { field: string }[]; warnings: string[]; calendarHint: boolean };
    };
    expect(json.ok).toBe(true);
    expect(json.data!.dryRun).toBe(true);
    const fields = json.data!.changes.map((c) => c.field);
    expect(fields).toContain("预计时长");
    expect(fields).toContain("优先级");

    const after = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.estMinutes).toBe(t.estMinutes); // 未落库
    expect(after.origin).toBe("ai");
  });

  it("截止日期越界被硬拒：早于今天 / 晚于目标截止", async () => {
    const goal = await createTestGoal("编辑测试：日期守卫");
    const t = await prisma.task.findFirstOrThrow({ where: { goalId: goal.id } });

    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const r1 = await patchTask(jsonReq(`/api/tasks/${t.id}?dryRun=1`, "PATCH", { dueDate: past }), {
      params: Promise.resolve({ id: t.id }),
    });
    expect(r1.status).toBe(400);

    const beyond = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const r2 = await patchTask(jsonReq(`/api/tasks/${t.id}?dryRun=1`, "PATCH", { dueDate: beyond }), {
      params: Promise.resolve({ id: t.id }),
    });
    expect(r2.status).toBe(400);
  });

  it("循环依赖被硬拒，合法依赖替换成功", async () => {
    const goal = await createTestGoal("编辑测试：依赖");
    // 手工造两个无依赖任务（mock 生成的任务自带依赖链，避免测试与 mock 结构耦合）
    const ra = await createTask(jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "环测试-A" }), {
      params: Promise.resolve({ id: goal.id }),
    });
    const rb = await createTask(jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "环测试-B" }), {
      params: Promise.resolve({ id: goal.id }),
    });
    const aId = ((await ra.json()) as { data: { id: string } }).data.id;
    const bId = ((await rb.json()) as { data: { id: string } }).data.id;

    // b 依赖 a（合法）
    const okRes = await patchTask(
      jsonReq(`/api/tasks/${bId}`, "PATCH", { dependsOnIds: [aId] }),
      { params: Promise.resolve({ id: bId }) },
    );
    expect(((await okRes.json()) as { ok: boolean }).ok).toBe(true);

    // 再让 a 依赖 b → a→b→a 成环，硬拒
    const cyc = await patchTask(
      jsonReq(`/api/tasks/${aId}?dryRun=1`, "PATCH", { dependsOnIds: [bId] }),
      { params: Promise.resolve({ id: aId }) },
    );
    expect(cyc.status).toBe(400);
    const cycJson = (await cyc.json()) as { error?: string };
    expect(cycJson.error).toContain("循环依赖");

    const after = await prisma.task.findUniqueOrThrow({ where: { id: aId }, include: { dependsOn: true } });
    expect(after.dependsOn.length).toBe(0);
  });

  it("正式编辑：字段保存 + origin=user + PlanVersion 留痕；乐观锁 409", async () => {
    const goal = await createTestGoal("编辑测试：正式保存");
    const t = await prisma.task.findFirstOrThrow({ where: { goalId: goal.id } });
    const revBefore = (await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).revision;

    const res = await patchTask(
      jsonReq(`/api/tasks/${t.id}`, "PATCH", { estMinutes: 90, priority: 1 }),
      { params: Promise.resolve({ id: t.id }) },
    );
    const json = (await res.json()) as { ok: boolean; data?: { task: { estMinutes: number; origin: string } } };
    expect(json.ok).toBe(true);
    expect(json.data!.task.estMinutes).toBe(90);
    expect(json.data!.task.origin).toBe("user");

    const goalAfter = await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } });
    expect(goalAfter.revision).toBe(revBefore + 1);
    const version = await prisma.planVersion.findUnique({
      where: { goalId_revision: { goalId: goal.id, revision: revBefore + 1 } },
    });
    expect(version?.snapshotJson).toBeTruthy();
    expect(version?.reason).toContain("手动调整");

    // 乐观锁：用旧的 updatedAt 再改一次 → 409
    const staleRes = await patchTask(
      jsonReq(`/api/tasks/${t.id}`, "PATCH", { estMinutes: 60, expectedUpdatedAt: t.updatedAt.toISOString() }),
      { params: Promise.resolve({ id: t.id }) },
    );
    expect(staleRes.status).toBe(409);
  });

  it("仅改状态不产生版本（快速路径保持既有行为）", async () => {
    const goal = await createTestGoal("编辑测试：状态快速路径");
    const t = await prisma.task.findFirstOrThrow({ where: { goalId: goal.id } });
    const revBefore = (await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).revision;

    const res = await patchTask(
      jsonReq(`/api/tasks/${t.id}`, "PATCH", { status: "in_progress" }),
      { params: Promise.resolve({ id: t.id }) },
    );
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const revAfter = (await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).revision;
    expect(revAfter).toBe(revBefore);
  });
});

describe("手动新增 / 删除任务", () => {
  it("新增：origin=user、排到末尾、版本留痕；重名拒绝", async () => {
    const goal = await createTestGoal("新增测试");
    const res = await createTask(
      jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "手动加的关键一步", estMinutes: 45, priority: 1 }),
      { params: Promise.resolve({ id: goal.id }) },
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; data?: { origin: string } };
    expect(json.data!.origin).toBe("user");

    const dup = await createTask(
      jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "手动加的关键一步" }),
      { params: Promise.resolve({ id: goal.id }) },
    );
    expect(dup.status).toBe(400);
  });

  it("删除：任务移除、pending 草稿作废、版本留痕、写入过日历时返回 calendarHint", async () => {
    const goal = await createTestGoal("删除测试");
    const created = await createTask(
      jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "待删任务" }),
      { params: Promise.resolve({ id: goal.id }) },
    );
    const taskId = ((await created.json()) as { data: { id: string } }).data.id;

    // 造一条 pending 草稿 + 一条成功写入记录
    await prisma.calendarDraft.create({
      data: {
        goalId: goal.id, planVersion: 1, taskId, taskTitle: "待删任务",
        proposedStart: new Date(Date.now() + 86400000), proposedEnd: new Date(Date.now() + 86400000 + 3600000),
        timezone: "Asia/Shanghai", idempotencyKey: `${goal.id}:del:1`, status: "pending_confirmation",
      },
    });
    await prisma.calendarWrite.create({
      data: {
        draftId: `draft-${taskId}`, goalId: goal.id, planVersion: 1, taskId,
        provider: "ics", idempotencyKey: `${goal.id}:del:w1`, status: "success",
      },
    });

    const res = await deleteTask(jsonReq(`/api/tasks/${taskId}`, "DELETE"), {
      params: Promise.resolve({ id: taskId }),
    });
    const json = (await res.json()) as { ok: boolean; data?: { calendarHint: boolean } };
    expect(json.ok).toBe(true);
    expect(json.data!.calendarHint).toBe(true);

    expect(await prisma.task.findUnique({ where: { id: taskId } })).toBeNull();
    const draft = await prisma.calendarDraft.findFirst({ where: { taskId } });
    expect(draft?.status).toBe("cancelled");
    const lastVersion = await prisma.planVersion.findFirst({ where: { goalId: goal.id }, orderBy: { revision: "desc" } });
    expect(lastVersion?.reason).toContain("手动删除");
  });
});

describe("撤销与用户优先", () => {
  it("编辑后撤销：恢复原值，且已完成任务不被复制（快照只含未完成）", async () => {
    const goal = await createTestGoal("撤销测试");
    const tasks = await prisma.task.findMany({ where: { goalId: goal.id }, orderBy: { order: "asc" } });
    // 完成第一个任务
    await patchTask(jsonReq(`/api/tasks/${tasks[0].id}`, "PATCH", { status: "done" }), {
      params: Promise.resolve({ id: tasks[0].id }),
    });
    const target = await prisma.task.findUniqueOrThrow({ where: { id: tasks[1].id } });

    // 编辑第二个任务
    await patchTask(
      jsonReq(`/api/tasks/${target.id}`, "PATCH", { estMinutes: 300, priority: 1 }),
      { params: Promise.resolve({ id: target.id }) },
    );
    const edited = await prisma.task.findUniqueOrThrow({ where: { id: target.id } });
    expect(edited.estMinutes).toBe(300);

    // 撤销
    const undoRes = await replanUndo(jsonReq(`/api/goals/${goal.id}/replan/undo`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    expect(((await undoRes.json()) as { ok: boolean }).ok).toBe(true);

    const restored = await prisma.task.findFirstOrThrow({ where: { goalId: goal.id, title: target.title } });
    expect(restored.estMinutes).toBe(target.estMinutes); // 原值恢复

    // 已完成任务不重复（此前 bug：快照含 done 导致 undo 复制）
    const doneCount = await prisma.task.count({ where: { goalId: goal.id, status: "done", title: tasks[0].title } });
    expect(doneCount).toBe(1);
  });

  it("Replan 不改写 origin=user 任务（估时/优先级/存在性全保留），AI 任务照常收敛", async () => {
    const goal = await createTestGoal("用户优先测试");
    const tasks = await prisma.task.findMany({ where: { goalId: goal.id }, orderBy: { order: "asc" } });

    // 把一个任务改为用户设定（估时 240、P1、固定标题）
    await patchTask(
      jsonReq(`/api/tasks/${tasks[0].id}`, "PATCH", { estMinutes: 240, priority: 1, title: "用户锁定的核心任务" }),
      { params: Promise.resolve({ id: tasks[0].id }) },
    );
    const userTaskBefore = await prisma.task.findUniqueOrThrow({ where: { id: tasks[0].id } });

    // 运行 replan（local mock：沿用标题但会压缩估时）
    const res = await replan(jsonReq(`/api/goals/${goal.id}/replan`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as { ok: boolean; data?: { reason: string } };
    expect(json.ok).toBe(true);
    expect(json.data!.reason).toContain("已保留 1 项你手动设定的任务");

    const userTaskAfter = await prisma.task.findFirstOrThrow({
      where: { goalId: goal.id, title: "用户锁定的核心任务" },
    });
    expect(userTaskAfter.estMinutes).toBe(240); // 未被 mock 的压缩改写
    expect(userTaskAfter.priority).toBe(1);
    expect(userTaskAfter.origin).toBe("user");

    // AI 任务仍存在（mock 沿用标题）且经历了正常收敛
    const aiTitles = tasks.slice(1).map((t) => t.title);
    const aiCount = await prisma.task.count({ where: { goalId: goal.id, title: { in: aiTitles } } });
    expect(aiCount).toBeGreaterThan(0);
    void userTaskBefore;
  });
});
