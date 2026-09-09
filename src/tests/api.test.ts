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
  // 环境隔离（Phase 9）：强制 local mock——否则 AGENT_MODE=auto 在 8000 端口
  // 恰有真实 agent 运行时会把测试请求发给真实 LLM，5s 超时且产生真实副作用
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

describe("POST /api/goals（Phase 2：日期/周期/依赖/版本）", () => {
  it("创建后任务带调度字段、依赖连通、落 PlanVersion v1", async () => {
    const res = await createGoal(jsonReq("/api/goals", "POST", {
      title: "集成测试：Phase2 调度",
      deadline: new Date(Date.now() + 14 * 86400000).toISOString(),
    }));
    const json = (await res.json()) as {
      ok: boolean;
      data?: {
        id: string;
        tasks: { id: string; title: string; startDate?: string | null; dueDate?: string | null; durationDays?: number | null; dependsOn: { title: string }[] }[];
      };
    };
    expect(json.ok).toBe(true);
    cleanupIds.push(json.data!.id);
    const goal = json.data!;

    // mock planner 至少产生一个带日期的任务与一个周期型任务
    expect(goal.tasks.some((t) => t.dueDate)).toBe(true);
    expect(goal.tasks.some((t) => t.durationDays && t.durationDays >= 1)).toBe(true);
    // 依赖已连接到真实任务标题
    const depTask = goal.tasks.find((t) => t.dependsOn.length > 0);
    expect(depTask).toBeTruthy();
    const titles = new Set(goal.tasks.map((t) => t.title));
    expect(depTask!.dependsOn.every((d) => titles.has(d.title))).toBe(true);

    const version = await prisma.planVersion.findUnique({
      where: { goalId_revision: { goalId: goal.id, revision: 1 } },
    });
    expect(version).toBeTruthy();
    const diff = JSON.parse(version!.diffJson);
    expect(diff.summary.added).toBe(goal.tasks.length); // 初始计划 = 全部新增
  });
});

describe("POST /api/goals/:id/replan（Phase 2：diff + 版本）", () => {
  it("生成 diff（mock 保标题 → 无新增/删除，估时压缩进 changed）并落 PlanVersion v2", async () => {
    const goal = await createTestGoal("集成测试：Phase2 diff");
    // 完成第一个任务，剩余交给 replan
    await patchTask(jsonReq(`/api/tasks/${goal.tasks[0].id}`, "PATCH", { status: "done" }), {
      params: Promise.resolve({ id: goal.tasks[0].id }),
    });

    const res = await replan(jsonReq(`/api/goals/${goal.id}/replan`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as {
      ok: boolean;
      data?: {
        reason: string;
        diff: { added: unknown[]; removed: unknown[]; changed: { estMinutesFrom: number; estMinutesTo: number }[]; summary: { kept: number } };
        goal: { revision: number };
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data!.goal.revision).toBe(2);
    // mock replan 严格沿用标题：无新增无删除，全部保留
    expect(json.data!.diff.added).toEqual([]);
    expect(json.data!.diff.removed).toEqual([]);
    expect(json.data!.diff.summary.kept).toBe(goal.tasks.length - 1);
    // 估时被压缩 → changed 里 estMinutesTo < estMinutesFrom（至少一条）
    expect(json.data!.diff.changed.some((c) => c.estMinutesTo < c.estMinutesFrom)).toBe(true);

    const version = await prisma.planVersion.findUnique({
      where: { goalId_revision: { goalId: goal.id, revision: 2 } },
    });
    expect(version).toBeTruthy();
    expect(JSON.parse(version!.diffJson).summary.kept).toBe(goal.tasks.length - 1);
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

describe("GET /api/goals（UI Redesign：计划历史透出）", () => {
  it("包含 versions（revision 倒序），供 Activity/Detail 使用", async () => {
    const goal = await createTestGoal("带历史的目标");
    await replan(jsonReq(`/api/goals/${goal.id}/replan`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    const res = await listGoals();
    const json = (await res.json()) as { ok: boolean; data: { id: string; versions?: { revision: number; reason: string }[] }[] };
    expect(json.ok).toBe(true);
    const withVersions = json.data.find((g) => g.id === goal.id);
    expect(withVersions?.versions?.length).toBeGreaterThanOrEqual(2);
    expect(withVersions!.versions![0].revision).toBe(2);
    expect(typeof withVersions!.versions![0].reason).toBe("string");
  });
});

describe("GET /api/settings/calendar（agent 代理）", () => {
  it("agent 不可达时结构化 502，不暴露内部细节", async () => {
    process.env.AGENT_CORE_URL = "http://127.0.0.1:9";
    const { GET } = await import("@/app/api/settings/calendar/route");
    const res = await GET();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    delete process.env.AGENT_CORE_URL;
  });
});
