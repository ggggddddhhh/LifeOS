import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPlanningPolicy, computePolicyImpact } from "@/lib/policy";
import { validatePolicyPatch, type PlanningPolicy } from "@/lib/policy-core";
import { traceEvent } from "@/lib/trace";

/** GET /api/settings/planning —— 读取规划策略（首次访问惰性种子默认行，旧用户零迁移）。 */
export async function GET() {
  const policy = await getPlanningPolicy();
  return NextResponse.json({ ok: true, data: policy });
}

/**
 * PATCH /api/settings/planning —— 更新规划策略。
 * ?impact=1：只校验 + 返回影响预览，不保存（保存前先让用户看影响）。
 * 正式保存：校验 → 落库 → 返回新策略与影响摘要。本路由绝不触碰日历——
 * 已写入日历的事件不会被改动；待确认草稿需用户手动重新生成才会按新策略排期。
 */
export async function PATCH(req: NextRequest) {
  const impactOnly = req.nextUrl.searchParams.get("impact") === "1";
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const current = await getPlanningPolicy();
    const validated = validatePolicyPatch(body, current);
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
    }
    const next: PlanningPolicy = validated.policy;
    const impact = await computePolicyImpact(next);
    if (impactOnly) {
      return NextResponse.json({ ok: true, data: { preview: true, policy: next, impact } });
    }

    await prisma.planningSettings.update({
      where: { id: "default" },
      data: {
        dailyCapacityMinutes: next.dailyCapacityMinutes,
        workdays: next.workdays.join(","),
        workStartMinute: next.workStartMinute,
        workEndMinute: next.workEndMinute,
        timezone: next.timezone,
        calendarId: next.calendarId,
        defaultEstMinutes: next.defaultEstMinutes,
        defaultPriority: next.defaultPriority,
      },
    });
    traceEvent("planning_settings", { ok: true, dailyCapacityMinutes: next.dailyCapacityMinutes, workdays: next.workdays, timezone: next.timezone, calendarId: next.calendarId });
    return NextResponse.json({ ok: true, data: { policy: next, impact } });
  } catch (e) {
    traceEvent("planning_settings", { ok: false, error: e instanceof Error ? e.message : "settings failed" });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "保存设置失败" },
      { status: 500 },
    );
  }
}
