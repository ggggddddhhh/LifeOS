"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { GoalHeader } from "@/components/goal-detail/goal-header";
import { Kanban } from "@/components/goal-detail/kanban";
import { PlanHistory } from "@/components/goal-detail/plan-history";
import { CalendarDraftPanel } from "@/components/goal-detail/calendar-draft-panel";
import { ReplanAction } from "@/components/goal-detail/replan-action";
import { useGoals, type GoalView } from "@/lib/ui-data";
import type { TaskStatus } from "@/lib/types";

export default function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { goals, loading, error, refresh, setError } = useGoals();
  const [goal, setGoal] = useState<GoalView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [capacityMinutes, setCapacityMinutes] = useState<number | null>(null);

  useEffect(() => {
    setGoal(goals.find((g) => g.id === id) ?? null);
  }, [goals, id]);

  const onStatusChange = useCallback(
    async (taskId: string, status: TaskStatus) => {
      const snapshot = goal;
      if (!snapshot) return;
      setGoal({ ...snapshot, tasks: snapshot.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) });
      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error();
      } catch {
        setGoal(snapshot); // 失败回滚乐观更新
        setError("更新任务失败");
      }
    },
    [goal, setError],
  );

  if (loading) return <ListSkeleton rows={6} />;
  if (error && !goal) return <ErrorState message={error} onRetry={refresh} />;
  if (!goal) return <ErrorState message="目标不存在或已删除" />;

  const openCount = goal.tasks.filter((t) => t.status !== "done").length;

  async function handleDelete() {
    setDeleting(true);
    try {
      await fetch(`/api/goals/${goal!.id}`, { method: "DELETE" });
      router.push("/goals");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <nav className="flex items-center gap-2 text-xs text-muted-foreground" aria-label="面包屑">
        <Link href="/goals" className="inline-flex items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          Goals
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate">v{goal.revision}</span>
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">{goal.title}</h1>
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-danger">
                <Trash2 className="size-3.5" aria-hidden />
                <span className="sr-only">删除目标</span>
              </Button>
            }
            title="删除这个目标？"
            description="目标及其任务、计划历史、日历草稿记录都会被删除。已写入日历的事件不会被自动移除。"
            confirmLabel="删除"
            destructive
            busy={deleting}
            onConfirm={handleDelete}
          />
        </div>
        {goal.description && <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">{goal.description}</p>}
        <GoalHeader goal={goal} capacityMinutes={capacityMinutes} />
        <ReplanAction goalId={goal.id} disabledReason={openCount === 0 ? "所有任务已完成" : null} onDone={() => refresh()} />
      </header>

      <section aria-label="任务看板">
        <Kanban tasks={goal.tasks} onStatusChange={onStatusChange} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="计划历史" className="rounded-lg border p-4">
          <h2 className="mb-3 text-[13px] font-semibold">计划历史</h2>
          <PlanHistory versions={goal.versions ?? []} />
        </section>
        <section aria-label="日历写入" className="rounded-lg border p-4">
          <h2 className="mb-3 text-[13px] font-semibold">日历写入</h2>
          <CalendarDraftPanel goalId={goal.id} />
        </section>
      </div>
    </div>
  );
}
