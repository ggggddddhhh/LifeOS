import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { POST as replan } from "@/app/api/goals/[id]/replan/route";
import { POST as replanApply } from "@/app/api/goals/[id]/replan/apply/route";
import { POST as replanUndo } from "@/app/api/goals/[id]/replan/undo/route";
import { toStableConflictError } from "@/lib/conflict";

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(async () => {
  process.env.AGENT_MODE = "local";
  process.env.LLM_API_KEY = "";
});

afterAll(async () => {
  delete process.env.AGENT_MODE;
  delete process.env.LLM_API_KEY;
  await prisma.$disconnect();
});

describe("并发删除冲突 → 稳定错误（稳定性验证发现 #3）", () => {
  it("replan/apply/undo：目标不存在 → 404 友好文案，不含 Prisma 内部信息", async () => {
    const ghost = "cmtu-does-not-exist-0000000000";
    const r1 = await replan(jsonReq(`/api/goals/${ghost}/replan`, "POST"), {
      params: Promise.resolve({ id: ghost }),
    });
    expect(r1.status).toBe(404);
    expect((await r1.json()).error).toBe("目标不存在");

    const r2 = await replanApply(
      jsonReq(`/api/goals/${ghost}/replan/apply`, "POST", { tasks: [{ title: "x", priority: 2, estMinutes: 30 }], reasonBase: "r" }),
      { params: Promise.resolve({ id: ghost }) },
    );
    expect(r2.status).toBe(404);
    expect((await r2.json()).error).toBe("目标不存在");

    const r3 = await replanUndo(jsonReq(`/api/goals/${ghost}/replan/undo`, "POST"), {
      params: Promise.resolve({ id: ghost }),
    });
    expect(r3.status).toBe(404);
  });

  it("事务中途目标被删（P2003/P2025 形状）→ 409/404 稳定错误，不泄露内部信息", async () => {
    const fk = Object.assign(new Error("Invalid `tx.task.create()` invocation:\nForeign key constraint failed on the foreign key: `goalId`"), { code: "P2003" });
    const stable = toStableConflictError(fk);
    expect(stable).not.toBeNull();
    expect(stable!.status).toBe(409);
    expect(stable!.message).not.toContain("Invalid");
    expect(stable!.message).not.toContain("prisma");

    const notFound = Object.assign(new Error("An operation failed because it depends on one or more records that were required but not found"), { code: "P2025" });
    const stable2 = toStableConflictError(notFound);
    expect(stable2!.status).toBe(404);

    // 消息含外键特征但丢失 code（包装事务错误防御路径）
    const wrapped = new Error("Foreign key constraint failed on the foreign key: `Task_goalId_fkey`");
    const stable3 = toStableConflictError(wrapped);
    expect(stable3!.status).toBe(409);

    // 普通错误不受影响
    expect(toStableConflictError(new Error("LLM error"))).toBeNull();
  });
});
