import { NextResponse } from "next/server";

/**
 * UI Redesign V2：Calendar 页的外部现实层（Google/ICS 只读事件）代理。
 * 纯转发 agent GET /v1/calendar/facts（只读观察面，含 source=user|lifeos 区分），
 * 不触碰 OAuth / 写路径。agent 不可达或未配置时返回 ok:false，由前端静默降级。
 */

const AGENT_BASE = () => (process.env.AGENT_CORE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(62, Number(url.searchParams.get("days") ?? 45)));
  const tz = url.searchParams.get("tz") ?? "Asia/Shanghai";
  try {
    const res = await fetch(`${AGENT_BASE()}/v1/calendar/facts?days=${days}&timezone=${encodeURIComponent(tz)}`, {
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Agent 返回 ${res.status}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, data: await res.json() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Agent 不可达" },
      { status: 502 },
    );
  }
}
