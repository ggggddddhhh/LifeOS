"use client";

import Link from "next/link";
import { CalendarClock, CalendarPlus, CircleAlert, TriangleAlert } from "lucide-react";
import { StatusBadge } from "@/components/shared/status-badge";
import { budgetOf, capacityMinutesOf, daysLeftOf, fmtDate, type GoalView } from "@/lib/ui-data";
import { DEFAULT_POLICY, type PlanningPolicy } from "@/lib/policy-core";
import { cn } from "@/lib/utils";

/** 焦点目标排序：截止越近越靠前（无截止最后），其次未完成任务多者。 */
export function focusScore(goal: GoalView): number {
  const daysLeft = daysLeftOf(goal.deadline);
  const open = goal.tasks.filter((t) => t.status !== "done").length;
  return (daysLeft === null ? 10000 : daysLeft * 100) - open;
}

/** Today 焦点目标卡：进度 · 截止倒计时 · 剩余工作量 vs 容量 · 今日容量（策略口径）。 */
export function FocusGoal({ goal, policy = DEFAULT_POLICY }: { goal: GoalView; policy?: PlanningPolicy }) {
  const done = goal.tasks.filter((t) => t.status === "done").length;
  const total = goal.tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const daysLeft = daysLeftOf(goal.deadline);
  const openMin = goal.tasks.filter((t) => t.status !== "done").reduce((s, t) => s + budgetOf(t), 0);
  const urgent = daysLeft !== null && daysLeft <= 2 && done < total;
  const risk = urgent
    ? { tone: "danger" as const, label: `剩 ${daysLeft} 天` }
    : daysLeft !== null && openMin > capacityMinutesOf(goal.deadline, policy)
      ? { tone: "warning" as const, label: "工作量超出容量" }
      : null;

  return (
    <Link
      href={`/goals/${goal.id}`}
      className="block rounded-lg border p-4 transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-[15px] font-semibold leading-snug tracking-tight">{goal.title}</h2>
        <span className="tabular shrink-0 text-xs text-muted-foreground">第 {goal.revision} 版计划</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="tabular">
          {done}/{total} 完成 · {pct}%
        </span>
        {goal.deadline && (
          <span className={cn("tabular", urgent && "font-medium text-danger")}>{fmtDate(goal.deadline)} 截止</span>
        )}
        <span className="tabular">剩余投入 {Math.round(openMin / 60)}h</span>
        <span className="tabular rounded border bg-muted/50 px-1.5 py-0.5" title="按规划策略：每日可投入 × 剩余工作日">
          今日容量 {Math.round(policy.dailyCapacityMinutes / 60)}h
        </span>
        {risk && (
          <StatusBadge tone={risk.tone} dot>
            {risk.label}
          </StatusBadge>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={`${goal.title} 进度`}
        aria-valuenow={pct}
        className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${pct}%` }} />
      </div>
    </Link>
  );
}

/**
 * Plan Health（contextual，只在有情况时出现，不常驻占位）：
 * 截止临近 / 容量超载（建议 Replan）/ 日历排期待确认。
 */
export function PlanHealth({
  goals,
  policy = DEFAULT_POLICY,
}: {
  goals: GoalView[];
  policy?: PlanningPolicy;
}) {
  const signals: { tone: "warning" | "danger" | "info"; text: string; href: string }[] = [];
  const pendingDrafts = goals.flatMap((g) =>
    (g.calDrafts ?? [])
      .filter((d) => d.status === "pending_confirmation")
      .map((d) => ({ goal: g, draft: d })),
  );

  for (const g of goals) {
    const daysLeft = daysLeftOf(g.deadline);
    const open = g.tasks.filter((t) => t.status !== "done");
    if (daysLeft !== null && daysLeft <= 2 && open.length > 0) {
      signals.push({ tone: "danger", text: `「${g.title.slice(0, 16)}」还剩 ${daysLeft} 天，${open.length} 项未完成`, href: `/goals/${g.id}` });
    }
    const openMin = open.reduce((s, t) => s + budgetOf(t), 0);
    if (g.deadline && openMin > capacityMinutesOf(g.deadline, policy)) {
      signals.push({ tone: "warning", text: `「${g.title.slice(0, 16)}」剩余工作量超出剩余天数容量，建议重新规划`, href: `/goals/${g.id}` });
    }
  }
  if (pendingDrafts.length > 0) {
    const g = pendingDrafts[0].goal;
    signals.push({
      tone: "info",
      text: `有 ${pendingDrafts.length} 条日历排期等待确认——确认后才会写入你的日历`,
      href: `/goals/${g.id}`,
    });
  }
  if (signals.length === 0) return null;
  return (
    <section aria-label="计划健康信号" className="space-y-1.5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Plan Health</h2>
      {signals.slice(0, 3).map((s, i) => (
        <Link
          key={i}
          href={s.href}
          className={cn(
            "flex items-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors duration-150",
            s.tone === "info"
              ? "border-info/20 bg-info/5 hover:bg-info/10"
              : "border-warning/20 bg-warning/5 hover:bg-warning/10",
          )}
        >
          {s.tone === "danger" ? (
            <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden />
          ) : s.tone === "info" ? (
            <CalendarPlus className="size-3.5 shrink-0 text-info" aria-hidden />
          ) : (
            <TriangleAlert className="size-3.5 shrink-0 text-warning" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate">{s.text}</span>
        </Link>
      ))}
    </section>
  );
}

/** 其他进行中目标的紧凑行（点击进 Detail）。 */
export function OtherGoalRow({ goal }: { goal: GoalView }) {
  const done = goal.tasks.filter((t) => t.status === "done").length;
  const total = goal.tasks.length;
  const pct = total > 0 ? (done / total) * 100 : 0;
  const daysLeft = daysLeftOf(goal.deadline);
  return (
    <Link
      href={`/goals/${goal.id}`}
      className="group flex items-center gap-3 rounded-md border bg-card px-3 py-2 transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="h-0.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="min-w-0 flex-1 truncate text-[13px]">{goal.title}</span>
      {daysLeft !== null && (
        <span className="tabular shrink-0 text-[11px] text-muted-foreground">
          <CalendarClock className="mr-1 inline size-3 align-[-1px]" aria-hidden />
          剩 {daysLeft} 天
        </span>
      )}
    </Link>
  );
}
