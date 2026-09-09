import { prisma } from "@/lib/db";
import {
  DEFAULT_POLICY,
  parseWorkdays,
  workdaysLeft,
  type PlanningPolicy,
} from "@/lib/policy-core";

/**
 * Planning Policy 服务端读取（Phase 12）：单例行 + 惰性种子。
 * 旧用户迁移 = 首次读取时以 DEFAULT_POLICY 建行（与旧行为逐字节一致，无数据改写）。
 * Replan / capacity / Calendar Draft / 任务创建默认值全部经由此函数——唯一入口。
 */
export async function getPlanningPolicy(): Promise<PlanningPolicy> {
  let row = await prisma.planningSettings.findUnique({ where: { id: "default" } });
  if (!row) {
    row = await prisma.planningSettings.create({
      data: {
        id: "default",
        dailyCapacityMinutes: DEFAULT_POLICY.dailyCapacityMinutes,
        workdays: DEFAULT_POLICY.workdays.join(","),
        workStartMinute: DEFAULT_POLICY.workStartMinute,
        workEndMinute: DEFAULT_POLICY.workEndMinute,
        timezone: DEFAULT_POLICY.timezone,
        calendarId: DEFAULT_POLICY.calendarId,
        defaultEstMinutes: DEFAULT_POLICY.defaultEstMinutes,
        defaultPriority: DEFAULT_POLICY.defaultPriority,
      },
    });
  }
  const workdays = parseWorkdays(row.workdays) ?? DEFAULT_POLICY.workdays;
  return {
    dailyCapacityMinutes: row.dailyCapacityMinutes,
    workdays,
    workStartMinute: row.workStartMinute,
    workEndMinute: row.workEndMinute,
    timezone: row.timezone,
    calendarId: row.calendarId,
    defaultEstMinutes: row.defaultEstMinutes,
    defaultPriority: row.defaultPriority,
  };
}

export interface PolicyImpact {
  /** 剩余工作量超出「新策略下估算容量」的进行中目标 */
  affectedGoals: { id: string; title: string; openMinutes: number; capacityMinutes: number }[];
  /** 当前待确认的日历草稿数（保存后需重新生成才会按新策略排期） */
  pendingDrafts: number;
}

/** 保存前的用户影响预览：只读计算，绝不触碰日历。 */
export async function computePolicyImpact(policy: PlanningPolicy): Promise<PolicyImpact> {
  const goals = await prisma.goal.findMany({
    where: { status: "active" },
    include: { tasks: { where: { status: { not: "done" } } } },
  });
  const affectedGoals: PolicyImpact["affectedGoals"] = [];
  for (const g of goals) {
    if (g.tasks.length === 0) continue;
    const openMinutes = g.tasks.reduce(
      (s, t) => s + (t.durationDays && t.durationDays >= 1 ? t.estMinutes * t.durationDays : t.estMinutes),
      0,
    );
    const days = g.deadline ? Math.max(1, workdaysLeft(g.deadline.toISOString(), policy.workdays)) : 14;
    const capacityMinutes = days * policy.dailyCapacityMinutes;
    if (openMinutes > capacityMinutes) {
      affectedGoals.push({ id: g.id, title: g.title, openMinutes, capacityMinutes });
    }
  }
  const pendingDrafts = await prisma.calendarDraft.count({ where: { status: "pending_confirmation" } });
  return { affectedGoals, pendingDrafts };
}
