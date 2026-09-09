import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as replan } from "@/app/api/goals/[id]/replan/route";
import { POST as replanApply } from "@/app/api/goals/[id]/replan/apply/route";
import { POST as replanUndo } from "@/app/api/goals/[id]/replan/undo/route";
import { POST as cancelDrafts } from "@/app/api/goals/[id]/calendar/cancel/route";
import { POST as makeDrafts } from "@/app/api/goals/[id]/calendar/drafts/route";
import { PATCH as patchTask } from "@/app/api/tasks/[id]/route";

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const cleanupIds: string[] = [];

async function createTestGoal(title: string) {
  const res = await createGoal(jsonReq("/api/goals", "POST", { title, deadline: new Date(Date.now() + 7 * 86400000).toISOString() }));
  const json = (await res.json()) as { ok: boolean; data?: { id: string; tasks: { id: string; title: string; estMinutes: number }[] } };
  expect(json.ok).toBe(true);
  cleanupIds.push(json.data!.id);
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

describe("Replan 确认制（Phase 10）", () => {
  it("?preview=1 只计算不落库：任务与 revision 不变", async () => {
    const goal = await createTestGoal("预览测试：整理资料");
    const before = await prisma.goal.findUnique({ where: { id: goal.id }, include: { tasks: true, versions: true } });

    const res = await replan(jsonReq(`/api/goals/${goal.id}/replan?preview=1`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as { ok: boolean; data?: { preview: boolean; tasks: unknown[]; diff: unknown } };
    expect(json.ok).toBe(true);
    expect(json.data!.preview).toBe(true);
    expect(Array.isArray(json.data!.tasks)).toBe(true);

    const after = await prisma.goal.findUnique({ where: { id: goal.id }, include: { tasks: true, versions: true } });
    expect(after!.tasks.length).toBe(before!.tasks.length);
    expect(after!.revision).toBe(before!.revision);
    expect(after!.versions.length).toBe(before!.versions.length); // preview 不新增版本
  });

  it("preview → apply 落库（revision+1、带快照），undo 恢复任务列表", async () => {
    const goal = await createTestGoal("应用与撤销测试");
    // 完成第一个任务，让 replan 有保留语义
    await patchTask(jsonReq(`/api/tasks/${goal.tasks[0].id}`, "PATCH", { status: "done" }), {
      params: Promise.resolve({ id: goal.tasks[0].id }),
    });
    const before = await prisma.goal.findUnique({ where: { id: goal.id }, include: { tasks: true } });
    const beforeTitles = before!.tasks.filter((t) => t.status !== "done").map((t) => t.title).sort();

    const previewRes = await replan(jsonReq(`/api/goals/${goal.id}/replan?preview=1`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const preview = ((await previewRes.json()) as { ok: boolean; data?: { reason: string; tasks: { title: string; estMinutes: number; priority: number }[]; capacityMinutes?: number | null } }).data!;

    const applyRes = await replanApply(
      jsonReq(`/api/goals/${goal.id}/replan/apply`, "POST", {
        reasonBase: preview.reason,
        tasks: preview.tasks,
        capacityMinutes: preview.capacityMinutes ?? null,
      }),
      { params: Promise.resolve({ id: goal.id }) },
    );
    const applied = (await applyRes.json()) as { ok: boolean; data?: { revision: number } };
    expect(applied.ok).toBe(true);
    expect(applied.data!.revision).toBe(2);

    // 应用后快照存在
    const v2 = await prisma.planVersion.findUnique({ where: { goalId_revision: { goalId: goal.id, revision: 2 } } });
    expect(v2!.snapshotJson).toBeTruthy();

    // 撤销 → 未完成任务列表恢复（标题集合一致，状态恢复 todo）
    const undoRes = await replanUndo(jsonReq(`/api/goals/${goal.id}/replan/undo`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const undo = (await undoRes.json()) as { ok: boolean; error?: string };
    expect(undo.ok).toBe(true);

    const after = await prisma.goal.findUnique({ where: { id: goal.id }, include: { tasks: true } });
    const afterTitles = after!.tasks.filter((t) => t.status !== "done").map((t) => t.title).sort();
    expect(afterTitles).toEqual(beforeTitles);
    expect(after!.revision).toBe(3); // 撤销也是一次版本前进（留痕）
  });

  it("apply 拒绝空任务列表", async () => {
    const goal = await createTestGoal("空计划测试");
    const res = await replanApply(
      jsonReq(`/api/goals/${goal.id}/replan/apply`, "POST", { tasks: [] }),
      { params: Promise.resolve({ id: goal.id }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("草稿单条取消", () => {
  it("draftIds 只取消指定草稿，其余保持待确认", async () => {
    const goal = await createTestGoal("单条取消测试");
    // local 模式下 drafts 路由会尝试 Python，不可达时 502——直接手工造草稿验证 cancel 语义
    const t = goal.tasks[0];
    await prisma.calendarDraft.createMany({
      data: [1, 2].map((i) => ({
        goalId: goal.id,
        planVersion: 1,
        taskId: i === 1 ? t.id : `fake-${i}`,
        taskTitle: `${t.title} #${i}`,
        proposedStart: new Date(Date.now() + i * 86400000),
        proposedEnd: new Date(Date.now() + i * 86400000 + 3600000),
        timezone: "Asia/Shanghai",
        idempotencyKey: `${goal.id}:1:${t.id}:${i}`,
        status: "pending_confirmation",
      })),
    });
    const drafts = await prisma.calendarDraft.findMany({ where: { goalId: goal.id } });
    expect(drafts.length).toBe(2);

    const res = await cancelDrafts(
      jsonReq(`/api/goals/${goal.id}/calendar/cancel`, "POST", { draftIds: [drafts[0].id] }),
      { params: Promise.resolve({ id: goal.id }) },
    );
    const json = (await res.json()) as { ok: boolean; data?: { cancelled: number } };
    expect(json.ok).toBe(true);
    expect(json.data!.cancelled).toBe(1);

    const after = await prisma.calendarDraft.findMany({ where: { goalId: goal.id } });
    expect(after.filter((d) => d.status === "cancelled").length).toBe(1);
    expect(after.filter((d) => d.status === "pending_confirmation").length).toBe(1);
  });
});

describe("GET/POST drafts 冒烟（local mock 不触发日历写）", () => {
  it.skip("makeDrafts 在 Python 不可达时结构化失败，草稿不落库", async () => {
    // 注：本用例依赖「8000 端口无 agent」的环境假设；开发机上常驻真实 agent 时会实际
    // 调用排期（>5s 超时）。drafts 的零写语义已由 calendar-write.test.ts 覆盖，此处跳过。
    const goal = await createTestGoal("草稿冒烟测试");
    const res = await makeDrafts(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    if (res.status === 502) {
      const count = await prisma.calendarDraft.count({ where: { goalId: goal.id } });
      expect(count).toBe(0);
    } else {
      expect(res.status).toBe(200);
    }
  });
});
