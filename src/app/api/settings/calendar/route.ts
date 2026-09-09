import { NextResponse } from "next/server";

/**
 * UI Redesign：Settings 页的 Calendar Provider 状态代理。
 * 纯转发 agent `/v1/calendar/status|disconnect`（Phase 8.5 运维面），
 * 不触碰 OAuth/token 逻辑；agent 返回体本身不含任何 token 值。
 */

const AGENT_BASE = () => (process.env.AGENT_CORE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

export async function GET() {
  try {
    const res = await fetch(`${AGENT_BASE()}/v1/calendar/status`, { signal: AbortSignal.timeout(10_000) });
    return NextResponse.json({ ok: true, data: await res.json() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Agent 不可达" },
      { status: 502 },
    );
  }
}

export async function POST() {
  try {
    const res = await fetch(`${AGENT_BASE()}/v1/calendar/disconnect`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Agent 返回 ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, data: await res.json() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Agent 不可达" },
      { status: 502 },
    );
  }
}
