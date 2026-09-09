"use client";

import { useCallback, useEffect, useState } from "react";
import { GoalForm } from "@/components/goal-form";
import { GoalBoard, type GoalView } from "@/components/goal-board";
import type { Envelope, TaskStatus } from "@/lib/types";

export default function Home() {
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [replanReason, setReplanReason] = useState<Record<string, string>>({});
  const [busyGoalId, setBusyGoalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/goals");
    const json = (await res.json()) as Envelope<GoalView[]>;
    if (json.ok) setGoals(json.data);
    else setError(json.error);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  async function createGoal(v: { title: string; description: string; deadline: string }) {
    setError(null);
    const res = await fetch("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(v),
    });
    const json = (await res.json()) as Envelope<GoalView>;
    if (!json.ok) {
      setError(json.error);
      return;
    }
    await refresh();
  }

  async function updateTask(taskId: string, status: TaskStatus) {
    setGoals((prev) =>
      prev.map((g) => ({
        ...g,
        tasks: g.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
      })),
    );
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      setError("更新任务失败");
      await refresh();
    }
  }

  async function replan(goalId: string) {
    setBusyGoalId(goalId);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/replan`, { method: "POST" });
      const json = (await res.json()) as Envelope<{ reason: string; goal: GoalView }>;
      if (!json.ok) {
        setError(json.error);
        return;
      }
      setReplanReason((prev) => ({ ...prev, [goalId]: json.data.reason }));
      await refresh();
    } finally {
      setBusyGoalId(null);
    }
  }

  async function deleteGoal(goalId: string) {
    await fetch(`/api/goals/${goalId}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-bold">LifeOS</h1>
      {error && (
        <p className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="lg:sticky lg:top-8 lg:self-start">
          <GoalForm onSubmit={createGoal} />
        </div>
        <div className="space-y-6">
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有目标。在左侧输入一个目标，让 AI 帮你拆解成任务。</p>
          ) : (
            goals.map((g) => (
              <GoalBoard
                key={g.id}
                goal={g}
                onStatusChange={updateTask}
                onReplan={replan}
                onDelete={deleteGoal}
                replanReason={replanReason[g.id]}
                busy={busyGoalId === g.id}
              />
            ))
          )}
        </div>
      </div>
    </main>
  );
}
