/**
 * Phase 7：Calendar 写入闭环集成测试（stub python /v1/calendar/*）。
 * 安全场景：不确认→0 写、重复确认→不重复、python 挂→无写、部分失败如实、local 不绕过。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createServer, type Server } from "node:http";
import { prisma } from "@/lib/db";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as draftRoute, GET as draftListRoute } from "@/app/api/goals/[id]/calendar/drafts/route";
import { POST as confirmRoute } from "@/app/api/goals/[id]/calendar/confirm/route";
import { POST as cancelRoute } from "@/app/api/goals/[id]/calendar/cancel/route";

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const PROMPT_VERSION = "2";

interface StubState {
  executeCalls: number;
  draftsCalls: number;
  results: { idempotencyKey: string; status: string; error?: string }[];
  writtenUids: string[];
}

let state: StubState;
let server: Server;
let url = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      const body = chunks ? JSON.parse(chunks) : {};
      const send = (code: number, json: unknown) =>
        res.writeHead(code, { "Content-Type": "application/json", "x-prompt-version": PROMPT_VERSION }).end(JSON.stringify(json));
      if (req.url?.includes("/v1/calendar/drafts")) {
        state.draftsCalls += 1;
        const drafts = (body.tasks ?? [])
          .filter((t: { status?: string }) => t.status !== "done")
          .map((t: { taskId: string; title: string; estMinutes: number }, i: number) => ({
            taskId: t.taskId,
            taskTitle: t.title,
            startUtc: `2027-03-1${i}T01:00:00Z`, // Instant（UTC Z）
            endUtc: `2027-03-1${i}T${String(1 + Math.floor(t.estMinutes / 60)).padStart(2, "0")}:${String(t.estMinutes % 60).padStart(2, "0")}:00Z`,
            timezone: body.timezone ?? "Asia/Shanghai",
            calendarId: "primary",
            actionType: "create",
            reason: "测试排期",
            idempotencyKey: `${body.goalId}:${body.planVersion}:${t.taskId}:1`,
          }));
        return send(200, { drafts, unplacedTaskIds: [] });
      }
      if (req.url?.includes("/v1/calendar/execute")) {
        state.executeCalls += 1;
        const results = (body.drafts ?? []).map((d: { idempotencyKey: string }) => {
          const scripted = state.results.find((r) => r.idempotencyKey === d.idempotencyKey);
          if (scripted) return scripted;
          const uid = `lifeos-${d.idempotencyKey.replace(/:/g, "-")}@lifeos`;
          if (state.writtenUids.includes(uid)) {
            return { idempotencyKey: d.idempotencyKey, status: "duplicate_skipped", externalEventId: uid };
          }
          state.writtenUids.push(uid);
          return { idempotencyKey: d.idempotencyKey, status: "success", externalEventId: uid };
        });
        return send(200, { results, provider: "stub" });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  state = { executeCalls: 0, draftsCalls: 0, results: [], writtenUids: [] };
  process.env.AGENT_MODE = "local";
  process.env.AGENT_CORE_URL = url;
  process.env.LLM_API_KEY = "";
  await prisma.calendarWrite.deleteMany({});
  await prisma.calendarDraft.deleteMany({});
  await prisma.task.deleteMany({});
  await prisma.goal.deleteMany({});
});

afterEach(() => {
  delete process.env.AGENT_MODE;
  delete process.env.AGENT_CORE_URL;
  delete process.env.LLM_API_KEY;
});

async function seedGoal() {
  const res = await createGoal(jsonReq("/api/goals", "POST", { title: "5 天后上线 MVP", deadline: "2026-09-16" }));
  const json = (await res.json()) as { ok: boolean; data: { id: string; revision: number; tasks: { id: string; title: string; estMinutes: number }[] } };
  expect(json.ok).toBe(true);
  return json.data;
}

describe("Phase 7：确认制写入闭环", () => {
  it("drafts 只生成 pending 草稿，绝不触发 execute（不确认 → 0 写）", async () => {
    const goal = await seedGoal();
    const res = await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as { ok: boolean; data: { drafts: { status: string; idempotencyKey: string }[] } };
    expect(json.ok).toBe(true);
    expect(json.data.drafts.length).toBeGreaterThan(0);
    expect(json.data.drafts.every((d) => d.status === "pending_confirmation")).toBe(true);
    expect(state.executeCalls).toBe(0); // 执行器从未被调用
    expect(await prisma.calendarWrite.count()).toBe(0); // 0 写入记录
  });

  it("确认 → 执行成功 → executed + write 记录 + verify", async () => {
    const goal = await seedGoal();
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    const res = await confirmRoute(jsonReq(`/api/goals/${goal.id}/calendar/confirm`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as {
      ok: boolean;
      data: { results: { status: string }[]; summary: { success: number } };
    };
    expect(json.ok).toBe(true);
    expect(json.data.summary.success).toBeGreaterThan(0);
    expect(state.executeCalls).toBe(1);
    expect(await prisma.calendarDraft.count({ where: { status: "executed" } })).toBeGreaterThan(0);
    const writes = await prisma.calendarWrite.findMany();
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.externalEventId?.startsWith("lifeos-"))).toBe(true);
  });

  it("重复确认 → 不重复执行（同 key 重置为 pending → DB 幂等门拦截，python 只收到一次）", async () => {
    const goal = await seedGoal();
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    await confirmRoute(jsonReq(`/api/goals/${goal.id}/calendar/confirm`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    expect(state.executeCalls).toBe(1);
    // 模拟双击/重试竞态：把已执行草稿重置回 pending（同 idempotencyKey）
    const executed = await prisma.calendarDraft.findFirstOrThrow({ where: { status: "executed" } });
    await prisma.calendarDraft.update({ where: { id: executed.id }, data: { status: "pending_confirmation" } });
    const again = await confirmRoute(jsonReq(`/api/goals/${goal.id}/calendar/confirm`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await again.json()) as { ok: boolean; data: { results: { status: string }[] } };
    expect(json.ok).toBe(true);
    expect(json.data.results.every((r) => r.status === "duplicate_skipped")).toBe(true);
    expect(state.executeCalls).toBe(1); // DB 门已拦截，未再触达 python
  });

  it("Python 不可达 → 502，草稿停留，无写入记录", async () => {
    const goal = await seedGoal();
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    process.env.AGENT_CORE_URL = "http://127.0.0.1:9"; // 模拟 python 挂掉
    const res = await confirmRoute(jsonReq(`/api/goals/${goal.id}/calendar/confirm`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    expect(res.status).toBe(502);
    expect(await prisma.calendarWrite.count()).toBe(0);
    // python 恢复后可重试（drafts 已 confirmed；重试路径 = 重新生成草稿）
    process.env.AGENT_CORE_URL = url;
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    const retry = await confirmRoute(jsonReq(`/api/goals/${goal.id}/calendar/confirm`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    expect(retry.status).toBe(200);
  });

  it("部分失败 → 逐条状态如实，不假装整体成功", async () => {
    const goal = await seedGoal();
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    const pending = await prisma.calendarDraft.findMany({ where: { status: "pending_confirmation" } });
    expect(pending.length).toBeGreaterThanOrEqual(2);
    state.results = [
      { idempotencyKey: pending[0].idempotencyKey, status: "success" },
      { idempotencyKey: pending[1].idempotencyKey, status: "failed", error: "CAL_SERVER: simulated" },
    ];
    const res = await confirmRoute(jsonReq(`/api/goals/${goal.id}/calendar/confirm`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as { ok: boolean; data: { summary: { success: number; failed: number } } };
    expect(json.ok).toBe(true);
    expect(json.data.summary.failed).toBe(1);
    expect(json.data.summary.success).toBe(pending.length - 1); // 其余按 stub 默认成功
    expect(await prisma.calendarDraft.count({ where: { status: "executed" } })).toBe(pending.length - 1);
    expect(await prisma.calendarDraft.count({ where: { status: "failed" } })).toBe(1);
  });

  it("stale_conflict → 草稿标记冲突，不写", async () => {
    const goal = await seedGoal();
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    const pending = await prisma.calendarDraft.findMany({ where: { status: "pending_confirmation" } });
    state.results = pending.map((d) => ({ idempotencyKey: d.idempotencyKey, status: "stale_conflict", error: "CAL_CONFLICT" }));
    const res = await confirmRoute(jsonReq(`/api/goals/${goal.id}/calendar/confirm`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.calendarDraft.count({ where: { status: "stale_conflict" } })).toBe(pending.length);
    expect(await prisma.calendarWrite.count({ where: { status: "success" } })).toBe(0);
  });

  it("cancel → 全部 cancelled，零写", async () => {
    const goal = await seedGoal();
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    const res = await cancelRoute(jsonReq(`/api/goals/${goal.id}/calendar/cancel`, "POST"), {
      params: Promise.resolve({ id: goal.id }),
    });
    expect(res.status).toBe(200);
    expect(state.executeCalls).toBe(0);
    expect(await prisma.calendarDraft.count({ where: { status: "cancelled" } })).toBeGreaterThan(0);
  });

  it("local fallback 的 replan/创建不产生任何草稿（写路径只经确认入口）", async () => {
    const goal = await seedGoal(); // AGENT_MODE=local
    expect(await prisma.calendarDraft.count()).toBe(0);
    expect(await prisma.calendarWrite.count()).toBe(0);
    expect(state.draftsCalls).toBe(0); // local 模式连 drafts 都没调
  });

  it("GET drafts 返回草稿与写入记录", async () => {
    const goal = await seedGoal();
    await draftRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "POST"), { params: Promise.resolve({ id: goal.id }) });
    const res = await draftListRoute(jsonReq(`/api/goals/${goal.id}/calendar/drafts`, "GET"), {
      params: Promise.resolve({ id: goal.id }),
    });
    const json = (await res.json()) as { ok: boolean; data: { drafts: unknown[]; writes: unknown[] } };
    expect(json.ok).toBe(true);
    expect(json.data.drafts.length).toBeGreaterThan(0);
  });
});
