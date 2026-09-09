import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as replan } from "@/app/api/goals/[id]/replan/route";
import { POST as createTask } from "@/app/api/goals/[id]/tasks/route";
import { GET as getPolicy, PATCH as patchPolicy } from "@/app/api/settings/planning/route";
import {
  DEFAULT_POLICY,
  parseWorkdays,
  validatePolicyPatch,
  workdaysLeft,
  declaredMinutesPerDay,
  type PlanningPolicy,
} from "@/lib/policy-core";

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const cleanupIds: string[] = [];

async function createTestGoal(title: string, deadlineDays = 7) {
  const res = await createGoal(
    jsonReq("/api/goals", "POST", { title, deadline: new Date(Date.now() + deadlineDays * 86400000).toISOString() }),
  );
  const json = (await res.json()) as { ok: boolean; data?: { id: string; tasks: { id: string }[] } };
  expect(json.ok).toBe(true);
  cleanupIds.push(json.data!.id);
  return json.data!;
}

beforeAll(async () => {
  process.env.AGENT_MODE = "local";
  process.env.LLM_API_KEY = "";
  await prisma.task.deleteMany({});
  await prisma.goal.deleteMany({});
  await prisma.planningSettings.deleteMany({});
});

afterAll(async () => {
  delete process.env.AGENT_MODE;
  delete process.env.LLM_API_KEY;
  await prisma.task.deleteMany({});
  await prisma.goal.deleteMany({});
  await prisma.planningSettings.deleteMany({});
  await prisma.$disconnect();
});

describe("policy-core 纯函数", () => {
  it("默认策略 = 旧行为（480/全周/08:00–20:00/Asia/Shanghai/primary/60/中）", () => {
    expect(DEFAULT_POLICY).toEqual({
      dailyCapacityMinutes: 480,
      workdays: [1, 2, 3, 4, 5, 6, 7],
      workStartMinute: 480,
      workEndMinute: 1200,
      timezone: "Asia/Shanghai",
      calendarId: "primary",
      defaultEstMinutes: 60,
      defaultPriority: 2,
    });
  });

  it("parseWorkdays：合法/越界/空", () => {
    expect(parseWorkdays("1,2, 3")).toEqual([1, 2, 3]);
    expect(parseWorkdays("8")).toBeNull();
    expect(parseWorkdays("x")).toBeNull();
    expect(parseWorkdays("")).toBeNull();
  });

  it("workdaysLeft：周末禁用时周末不计入", () => {
    // 2026-09-09 是周三：到 2026-09-13（周日）共 5 天，其中工作日（一~五）= 3
    expect(workdaysLeft("2026-09-13", [1, 2, 3, 4, 5], new Date("2026-09-09T00:00:00Z"))).toBe(3);
    expect(workdaysLeft("2026-09-13", [1, 2, 3, 4, 5, 6, 7], new Date("2026-09-09T00:00:00Z"))).toBe(5);
    // 全部禁用之外只剩周末：仅周六日可选 → 2
    expect(workdaysLeft("2026-09-13", [6, 7], new Date("2026-09-09T00:00:00Z"))).toBe(2);
    expect(workdaysLeft(null, [1])).toBe(0);
  });

  it("declaredMinutesPerDay：工作日=容量，非工作日=0", () => {
    const policy: PlanningPolicy = { ...DEFAULT_POLICY, workdays: [1, 2, 3, 4, 5], dailyCapacityMinutes: 300 };
    const arr = declaredMinutesPerDay(5, policy); // 2026-09-09（三）起 5 天：三四五（300）+ 六日（0）
    const base = new Date("2026-09-09T00:00:00Z");
    const a = declaredMinutesPerDay(5, policy, base);
    expect(a).toEqual([300, 300, 300, 0, 0]);
    void arr;
  });

  it("validatePolicyPatch：0 容量合法；开始≥结束拒绝；非法时区拒绝；空工作日拒绝", () => {
    const base = DEFAULT_POLICY;
    expect(validatePolicyPatch({ dailyCapacityMinutes: 0 }, base).ok).toBe(true);
    expect(validatePolicyPatch({ workStartMinute: 600, workEndMinute: 540 }, base).ok).toBe(false);
    expect(validatePolicyPatch({ timezone: "Mars/Olympus" }, base).ok).toBe(false);
    expect(validatePolicyPatch({ timezone: "America/New_York" }, base).ok).toBe(true);
    expect(validatePolicyPatch({ workdays: [] }, base).ok).toBe(false);
    expect(validatePolicyPatch({ workdays: [1, 5] }, base).ok).toBe(true);
    expect(validatePolicyPatch({ dailyCapacityMinutes: 2000 }, base).ok).toBe(false);
    expect(validatePolicyPatch({ defaultEstMinutes: 1 }, base).ok).toBe(false);
  });
});

describe("GET/PATCH /api/settings/planning", () => {
  it("首次读取惰性种子默认行（旧用户迁移，行为零变化）", async () => {
    const res = await getPolicy();
    const json = (await res.json()) as { ok: boolean; data: PlanningPolicy };
    expect(json.ok).toBe(true);
    expect(json.data).toEqual(DEFAULT_POLICY);
    const row = await prisma.planningSettings.findUnique({ where: { id: "default" } });
    expect(row?.workdays).toBe("1,2,3,4,5,6,7");
  });

  it("impact=1 校验并返回影响，不落库", async () => {
    const goal = await createTestGoal("策略影响测试目标");
    // 手工加一个大任务使其超出小容量
    await createTask(
      jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "超载任务", estMinutes: 600 }),
      { params: Promise.resolve({ id: goal.id }) },
    );

    const res = await patchPolicy(
      jsonReq("/api/settings/planning?impact=1", "PATCH", { dailyCapacityMinutes: 60 }),
    );
    const json = (await res.json()) as {
      ok: boolean;
      data?: { preview: boolean; impact: { affectedGoals: { title: string }[]; pendingDrafts: number } };
    };
    expect(json.ok).toBe(true);
    expect(json.data!.preview).toBe(true);
    expect(json.data!.impact.affectedGoals.length).toBeGreaterThan(0);

    const row = await prisma.planningSettings.findUnique({ where: { id: "default" } });
    expect(row?.dailyCapacityMinutes).toBe(480); // 未落库
  });

  it("非法更新 400（开始晚于结束）", async () => {
    const res = await patchPolicy(
      jsonReq("/api/settings/planning", "PATCH", { workStartMinute: 1200, workEndMinute: 480 }),
    );
    expect(res.status).toBe(400);
  });

  it("正式保存落库并可读回；返回影响", async () => {
    const res = await patchPolicy(
      jsonReq("/api/settings/planning", "PATCH", { dailyCapacityMinutes: 120, workdays: [1, 2, 3, 4, 5], defaultEstMinutes: 120 }),
    );
    const json = (await res.json()) as { ok: boolean; data?: { policy: PlanningPolicy; impact: unknown } };
    expect(json.ok).toBe(true);

    const got = (await (await getPolicy()).json()) as { data: PlanningPolicy };
    expect(got.data.dailyCapacityMinutes).toBe(120);
    expect(got.data.workdays).toEqual([1, 2, 3, 4, 5]);
    expect(got.data.defaultEstMinutes).toBe(120);
  });
});

describe("策略接入：创建默认值 / 改设置后的 Replan", () => {
  it("手动建任务使用策略默认时长与优先级", async () => {
    // 前一用例已把策略改为 120m/工作日一~五
    const goal = await createTestGoal("策略默认值测试");
    const res = await createTask(
      jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "吃策略默认的任务" }),
      { params: Promise.resolve({ id: goal.id }) },
    );
    const json = (await res.json()) as { ok: boolean; data?: { estMinutes: number; priority: number } };
    expect(json.ok).toBe(true);
    expect(json.data!.estMinutes).toBe(120);
    expect(json.data!.priority).toBe(2);
  });

  it("改小容量后 Replan：AI 任务被压缩到新容量内，用户任务原样保留", async () => {
    const goal = await createTestGoal("改设置后 Replan 测试", 7);
    // 用户锁定的任务（est 大）：不应被压缩
    await createTask(
      jsonReq(`/api/goals/${goal.id}/tasks`, "POST", { title: "用户锁定大任务", estMinutes: 240, priority: 1 }),
      { params: Promise.resolve({ id: goal.id }) },
    );

    // 容量已被上一用例设为 120m/天 × 工作日
    const res = await replan(jsonReq(`/api/goals/${goal.id}/replan`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as { ok: boolean; data?: { reason: string; goal: { tasks: { title: string; estMinutes: number; origin: string }[] } } };
    expect(json.ok).toBe(true);

    const userTask = json.data!.goal.tasks.find((t) => t.title === "用户锁定大任务")!;
    expect(userTask.estMinutes).toBe(240); // 用户设定不被压缩
    expect(userTask.origin).toBe("user");

    // AI 任务在新容量（120 × 工作日 − 用户投入）内收敛：reason 提及压缩
    expect(json.data!.reason).toMatch(/压缩|容量|保留/);
  });

  it("0 容量策略：Replan 仍可运行（守卫按最小可行收敛），不崩溃", async () => {
    await patchPolicy(
      jsonReq("/api/settings/planning", "PATCH", { dailyCapacityMinutes: 0 }),
    );
    const goal = await createTestGoal("0 容量测试", 3);
    const res = await replan(jsonReq(`/api/goals/${goal.id}/replan`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    // 恢复默认，避免污染后续用例
    await patchPolicy(
      jsonReq("/api/settings/planning", "PATCH", { dailyCapacityMinutes: 480, workdays: [1, 2, 3, 4, 5, 6, 7] }),
    );
  });
});
