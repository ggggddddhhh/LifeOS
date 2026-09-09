"use client";

import { CalendarDays, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { budgetOf, capacityMinutesOf, daysLeftOf, fmtDate, type GoalView } from "@/lib/ui-data";
import { DEFAULT_POLICY, type PlanningPolicy } from "@/lib/policy-core";

/**
 * 容量表达：默认按策略（每日可投入 × 剩余工作日）估算并标注「估算」；replan 后若 Agent
 * 返回了真实 Calendar 容量（capacityMinutes），由页面传入 override 覆盖并标注「日历实测」
 * ——语义与后端一致，不再冒充。
 */
export function CapacityBar({
  goal,
  capacityMinutesOverride,
  policy = DEFAULT_POLICY,
}: {
  goal: GoalView;
  capacityMinutesOverride?: number | null;
  policy?: PlanningPolicy;
}) {
  const open = goal.tasks.filter((t) => t.status !== "done");
  const totalMin = open.reduce((s, t) => s + budgetOf(t), 0);
  const isReal = typeof capacityMinutesOverride === "number" && capacityMinutesOverride >= 0;
  const capacity = isReal ? (capacityMinutesOverride as number) : capacityMinutesOf(goal.deadline, policy);
  const ratio = capacity > 0 ? totalMin / capacity : 1.5;
  const level = ratio > 1 ? "over" : ratio > 0.75 ? "tight" : "ok";

  return (
    <div className="flex min-w-[180px] flex-1 flex-col gap-1">
      <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span className="tabular">
          剩余投入 {Math.round(totalMin / 60)}h /{" "}
          {isReal ? `日历容量 ${Math.round(capacity / 60)}h` : `估算容量 ${Math.round(capacity / 60)}h`}
        </span>
        <span
          className={cn(
            "font-medium",
            level === "over" && "text-danger",
            level === "tight" && "text-warning",
            level === "ok" && "text-success",
          )}
        >
          {level === "over" ? "超载" : level === "tight" ? "偏紧" : "充裕"}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="剩余工作量与容量比"
        aria-valuenow={Math.min(100, Math.round(ratio * 100))}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            level === "over" ? "bg-danger" : level === "tight" ? "bg-warning" : "bg-success",
          )}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** Goal Detail 顶部信息行：进度 · 截止 · 容量 · 计划版本。 */
export function GoalHeader({
  goal,
  capacityMinutes,
  policy,
}: {
  goal: GoalView;
  capacityMinutes?: number | null;
  policy?: PlanningPolicy;
}) {
  const done = goal.tasks.filter((t) => t.status === "done").length;
  const total = goal.tasks.length;
  const daysLeft = daysLeftOf(goal.deadline);
  const urgent = daysLeft !== null && daysLeft <= 2;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="flex items-baseline gap-1.5">
        <span className="tabular text-lg font-semibold">{done}</span>
        <span className="tabular text-sm text-muted-foreground">/ {total} 完成</span>
      </div>
      {goal.deadline && (
        <span
          className={cn(
            "tabular inline-flex items-center gap-1.5 text-xs",
            urgent ? "font-medium text-danger" : "text-muted-foreground",
          )}
        >
          <CalendarDays className="size-3.5" aria-hidden />
          {fmtDate(goal.deadline)} 截止
          <span className={urgent ? "" : "text-muted-foreground/70"}>· 剩 {daysLeft} 天</span>
        </span>
      )}
      <span className="tabular inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Gauge className="size-3.5" aria-hidden />
        计划第 {goal.revision} 版
      </span>
      <CapacityBar goal={goal} capacityMinutesOverride={capacityMinutes} policy={policy} />
    </div>
  );
}
