import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { POST as createGoal, GET as listGoals } from "@/app/api/goals/route";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";
import { POST as replan } from "@/app/api/goals/[id]/replan/route";
import { DELETE as deleteGoal } from "@/app/api/goals/[id]/route";

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

let cleanupIds: string[] = [];

async function createTestGoal(title: string) {
  const res = await createGoal(jsonReq("/api/goals", "POST", { title, deadline: new Date(Date.now() + 7 * 86400000).toISOString() }));
  const json = (await res.json()) as { ok: boolean; data?: { id: string; tasks: { id: string }[] } };
  expect(json.ok).toBe(true);
  cleanupIds.push(json.data!.id);
  return json.data!;
}

beforeAll(async () => {
  await prisma.task.deleteMany({});
  await prisma.goal.deleteMany({});
});

afterAll(async () => {
  await prisma.task.deleteMany({});
  await prisma.goal.deleteMany({});
  await prisma.$disconnect();
});

describe("POST /api/goals", () => {
  it("创建目标并生成任务", async () => {
    const goal = await createTestGoal("集成测试：写周报");
    expect(goal.tasks.length).toBeGreaterThanOrEqual(3);
    expect(goal.tasks.every((t) => t.id)).toBe(true);
  });

  it("缺少 title 返回 400", async () => {
    const res = await createGoal(jsonReq("/api/goals", "POST", {}));
    expect(res.status).toBe(400);
  });

  it("非法 deadline 返回 400", async () => {
    const res = await createGoal(jsonReq("/api/goals", "POST", { title: "x", deadline: "not-a-date" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/goals", () => {
  it("返回目标列表", async () => {
    const res = await listGoals();
    const json = (await res.json()) as { ok: boolean; data: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("更新任务状态", async () => {
    const goal = await createTestGoal("集成测试：状态流转");
    const task = goal.tasks[0];
    const res = await patchTask(jsonReq(`/api/tasks/${task.id}`, "PATCH", { status: "done" }), {
      params: Promise.resolve({ id: task.id }),
    });
    const json = (await res.json()) as { ok: boolean; data?: { status: string } };
    expect(json.ok).toBe(true);
    expect(json.data!.status).toBe("done");
  });

  it("非法 status 返回 400", async () => {
    const goal = await createTestGoal("集成测试：非法状态");
    const task = goal.tasks[0];
    const res = await patchTask(jsonReq(`/api/tasks/${task.id}`, "PATCH", { status: "blocked" }), {
      params: Promise.resolve({ id: task.id }),
    });
    expect(res.status).toBe(400);
  });

  it("不存在任务返回 404", async () => {
    const res = await patchTask(jsonReq("/api/tasks/nope", "PATCH", { status: "done" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/goals/:id/replan", () => {
  it("保留 done 任务、重写未完成任务并递增 revision", async () => {
    const goal = await createTestGoal("集成测试：Replan");
    // 完成第一个任务
    await patchTask(jsonReq(`/api/tasks/${goal.tasks[0].id}`, "PATCH", { status: "done" }), {
      params: Promise.resolve({ id: goal.tasks[0].id }),
    });

    const res = await replan(jsonReq(`/api/goals/${goal.id}/replan`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as {
      ok: boolean;
      data?: { reason: string; goal: { revision: number; tasks: { id: string; status: string }[] } };
    };
    expect(json.ok).toBe(true);
    expect(json.data!.reason.length).toBeGreaterThan(0);
    expect(json.data!.goal.revision).toBe(2);
    // 原已完成任务仍存在且为 done
    const doneTask = json.data!.goal.tasks.find((t) => t.id === goal.tasks[0].id);
    expect(doneTask?.status).toBe("done");
    // 出现了重写后的新任务
    expect(json.data!.goal.tasks.filter((t) => t.id !== goal.tasks[0].id).length).toBeGreaterThan(0);
  });

  it("目标不存在返回 404", async () => {
    const res = await replan(jsonReq("/api/goals/nope/replan", "POST"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("所有任务已完成时返回 400 而不是让 AI 发明新任务", async () => {
    const goal = await createTestGoal("集成测试：全完成replan");
    for (const t of goal.tasks) {
      await patchTask(jsonReq(`/api/tasks/${t.id}`, "PATCH", { status: "done" }), {
        params: Promise.resolve({ id: t.id }),
      });
    }
    const res = await replan(jsonReq(`/api/goals/${goal.id}/replan`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toContain("无需");
  });
});

describe("DELETE /api/goals/:id", () => {
  it("删除目标并级联删除任务", async () => {
    const goal = await createTestGoal("集成测试：删除");
    const res = await deleteGoal(jsonReq(`/api/goals/${goal.id}`, "DELETE"), {
      params: Promise.resolve({ id: goal.id }),
    });
    expect(res.status).toBe(200);
    const count = await prisma.task.count({ where: { goalId: goal.id } });
    expect(count).toBe(0);
  });
});
