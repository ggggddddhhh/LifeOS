"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { GoalHeader } from "@/components/goal-detail/goal-header";
import { Kanban } from "@/components/goal-detail/kanban";
import { PlanHistory } from "@/components/goal-detail/plan-history";
import { CalendarDraftPanel } from "@/components/goal-detail/calendar-draft-panel";
import { ReplanAction } from "@/components/goal-detail/replan-action";
import { TaskFormDialog } from "@/components/goal-detail/task-form-dialog";
import { useGoals, type GoalView, type TaskView } from "@/lib/ui-data";
import type { TaskStatus } from "@/lib/types";

export default function GoalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { goals, policy, loading, error, refresh, setError } = useGoals();
  const [goal, setGoal] = useState<GoalView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [capacityMinutes, setCapacityMinutes] = useState<number | null>(null);
  // 依赖未完成仍要开始时的二次确认（Asana/Plane 模式：警告 + 显式确认，而非硬禁止）
  const [depConfirm, setDepConfirm] = useState<{ taskId: string; blocking: string[] } | null>(null);
  // 任务编辑 / 新建 / 删除（Phase 11 用户控制权）
  const [editingTask, setEditingTask] = useState<TaskView | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [deletingTask, setDeletingTask] = useState<TaskView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setGoal(goals.find((g) => g.id === id) ?? null);
  }, [goals, id]);

  const onStatusChange = useCallback(
    async (taskId: string, status: TaskStatus) => {
      const snapshot = goal;
      if (!snapshot) return;
      if (status === "in_progress") {
        // 开始一项还有未完成依赖的任务 → 先弹确认（列出被等的事项）
        const task = snapshot.tasks.find((t) => t.id === taskId);
        const byTitle = new Map(snapshot.tasks.map((t) => [t.title, t]));
        const blocking = (task?.dependsOn ?? [])
          .filter((d) => (byTitle.get(d.title)?.status ?? "todo") !== "done")
          .map((d) => d.title);
        if (blocking.length > 0) {
          setDepConfirm({ taskId, blocking });
          return;
        }
      }
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

  async function confirmStartDespiteDeps() {
    if (!depConfirm || !goal) return;
    const { taskId } = depConfirm;
    const snapshot = goal;
    setDepConfirm(null);
    setGoal({ ...snapshot, tasks: snapshot.tasks.map((t) => (t.id === taskId ? { ...t, status: "in_progress" } : t)) });
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setGoal(snapshot);
      setError("更新任务失败");
    }
  }

  async function handleDeleteTask() {
    if (!deletingTask) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/tasks/${deletingTask.id}`, { method: "DELETE" });
      const json = (await res.json()) as { ok: boolean; error?: string; data?: { calendarHint?: boolean } };
      if (!json.ok) {
        setError(json.error ?? "删除失败");
        return;
      }
      setNotice(
        json.data?.calendarHint
          ? `已删除「${deletingTask.title}」。它此前已写入日历——日历上的事件不会被移除。`
          : `已删除「${deletingTask.title}」`,
      );
      setDeletingTask(null);
      refresh();
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setDeleteBusy(false);
    }
  }

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
        <span className="truncate">{goal.title.length > 18 ? `${goal.title.slice(0, 18)}…` : goal.title}</span>
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
        <GoalHeader goal={goal} capacityMinutes={capacityMinutes} policy={policy} />
        <ReplanAction goalId={goal.id} disabledReason={openCount === 0 ? "所有任务已完成" : null} onDone={() => refresh()} />
      </header>

      {notice && (
        <p className="animate-rise rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs leading-relaxed text-foreground">
          {notice}
        </p>
      )}

      <section aria-label="任务看板" className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">任务看板</h2>
          <Button size="sm" variant="outline" onClick={() => setCreatingTask(true)}>
            <Plus className="mr-1.5 size-3.5" aria-hidden />
            添加任务
          </Button>
        </div>
        <Kanban
          tasks={goal.tasks}
          onStatusChange={onStatusChange}
          onEdit={(t) => setEditingTask(t)}
          onDelete={(t) => setDeletingTask(t)}
        />
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

      {depConfirm && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setDepConfirm(null)}
          title="这项任务依赖的事项还没完成"
          description="通常建议先完成以下事项。如果你确定要提前开始，可以继续："
          confirmLabel="仍然开始"
          onConfirm={confirmStartDespiteDeps}
        >
          <ul className="max-h-40 space-y-1 overflow-auto rounded-md bg-muted/40 p-2.5 text-xs">
            {depConfirm.blocking.map((t) => (
              <li key={t} className="flex items-center gap-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}

      {editingTask && (
        <TaskFormDialog
          key={`edit-${editingTask.id}-${editingTask.updatedAt ?? ""}`}
          mode="edit"
          goal={goal}
          task={editingTask}
          open
          onOpenChange={(v) => !v && setEditingTask(null)}
          onSaved={(n) => {
            setNotice(n);
            refresh();
          }}
        />
      )}
      {creatingTask && (
        <TaskFormDialog
          key="create"
          mode="create"
          goal={goal}
          open
          onOpenChange={(v) => !v && setCreatingTask(false)}
          onSaved={(n) => {
            setNotice(n);
            refresh();
          }}
        />
      )}
      {deletingTask && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setDeletingTask(null)}
          title={`删除任务「${deletingTask.title.length > 20 ? `${deletingTask.title.slice(0, 20)}…` : deletingTask.title}」？`}
          description="这项任务会从看板和计划中移除（计划历史会留痕，可撤销）。如果它已写入日历，日历上的事件不会被移除。"
          confirmLabel="删除"
          destructive
          busy={deleteBusy}
          onConfirm={handleDeleteTask}
        />
      )}
    </div>
  );
}
