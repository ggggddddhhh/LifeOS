"use client";

import { useCallback } from "react";
import Link from "next/link";
import { CalendarCheck2, ListTodo, Sparkles, Sun } from "lucide-react";
import { GoalCreateDialog } from "@/components/goals/goal-create-dialog";
import { FocusGoal, RiskSignals } from "@/components/today/focus-goal";
import { TaskRow } from "@/components/today/task-row";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useGoals, type GoalView, type TaskView } from "@/lib/ui-data";
import type { TaskStatus } from "@/lib/types";

function todayStr(): string {
  return new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
}

function isToday(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** Today Dashboard：日期与进度 → 风险信号 → 当前 Goal 焦点 → 今日/进行中任务。 */
export default function TodayPage() {
  const { goals, policy, loading, error, refresh, setError } = useGoals();

  const onStatusChange = useCallback(
    async (taskId: string, status: TaskStatus) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error();
        refresh();
      } catch {
        setError("更新任务失败");
      }
    },
    [refresh, setError],
  );

  const active = goals.filter((g) => g.tasks.some((t) => t.status !== "done"));
  const focus = active[0];

  const dueToday: { task: TaskView; goal: GoalView }[] = [];
  const doing: { task: TaskView; goal: GoalView }[] = [];
  for (const g of goals) {
    for (const t of g.tasks) {
      if (t.status === "done") continue;
      if (t.dueDate && isToday(t.dueDate)) dueToday.push({ task: t, goal: g });
      if (t.status === "in_progress") doing.push({ task: t, goal: g });
    }
  }
  const doneToday = goals.flatMap((g) => g.tasks).filter((t) => t.status === "done").length;
  const allTotal = goals.flatMap((g) => g.tasks).length;
  const abbr = (g: GoalView) => (g.title.length > 10 ? `${g.title.slice(0, 10)}…` : g.title);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Sun className="size-3.5" aria-hidden />
            {todayStr()}
          </div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Today</h1>
          {!loading && !error && allTotal > 0 && (
            <p className="tabular mt-1 text-xs text-muted-foreground">
              累计完成 {doneToday}/{allTotal} · {active.length} 个进行中的目标
            </p>
          )}
        </div>
        <GoalCreateDialog onCreated={() => refresh()} />
      </header>

      {error && <ErrorState message={error} onRetry={refresh} />}
      {loading ? (
        <ListSkeleton rows={5} />
      ) : goals.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="从一个目标开始"
          hint="描述你想完成的事，LifeOS 会拆解成带估时与排期的计划，并观察 GitHub 与日历的真实进展。"
        />
      ) : (
        <>
          {focus ? (
            <section aria-label="当前目标">
              <FocusGoal goal={focus} policy={policy} />
            </section>
          ) : (
            <EmptyState icon={CalendarCheck2} title="所有目标都已完成" hint="创建下一个目标，继续保持节奏。" />
          )}

          {active.length > 1 && (
            <section aria-label="其他进行中目标" className="space-y-1.5">
              {active.slice(1, 3).map((g) => (
                <FocusGoal key={g.id} goal={g} policy={policy} />
              ))}
              <Link
                href="/goals"
                className="block px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                查看全部 {active.length} 个进行中的目标 →
              </Link>
            </section>
          )}

          <RiskSignals goals={goals} policy={policy} />

          <section aria-label="今天到期">
            <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <CalendarCheck2 className="size-3.5" aria-hidden />
              今天到期（{dueToday.length}）
            </h2>
            {dueToday.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">今天没有截止的任务。</p>
            ) : (
              <div className="-mx-2">
                {dueToday.map(({ task, goal }) => (
                  <TaskRow key={task.id} task={task} goalAbbr={abbr(goal)} onStatusChange={onStatusChange} />
                ))}
              </div>
            )}
          </section>

          <section aria-label="进行中">
            <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ListTodo className="size-3.5" aria-hidden />
              进行中（{doing.length}）
            </h2>
            {doing.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                没有正在进行的任务。从上面的目标或「今天到期」里，点任务左侧的圆圈开始一项。
              </p>
            ) : (
              <div className="-mx-2">
                {doing.map(({ task, goal }) => (
                  <TaskRow key={task.id} task={task} goalAbbr={abbr(goal)} onStatusChange={onStatusChange} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
