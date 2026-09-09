"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlanDiff, TaskStatus } from "@/lib/types";

/** 前端视图类型（对齐 GET /api/goals 响应，含 planVersions） */
export interface TaskView {
  id: string;
  title: string;
  notes?: string | null;
  status: string;
  priority: number;
  estMinutes: number;
  startDate?: string | null;
  dueDate?: string | null;
  durationDays?: number | null;
  dependsOn?: { id: string; title: string }[];
}

export interface PlanVersionView {
  id: string;
  revision: number;
  reason: string;
  diffJson: string;
  createdAt: string;
}

export interface GoalView {
  id: string;
  title: string;
  description?: string | null;
  deadline?: string | null;
  revision: number;
  createdAt: string;
  tasks: TaskView[];
  versions?: PlanVersionView[];
}

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function budgetOf(t: TaskView): number {
  return t.durationDays && t.durationDays >= 1 ? t.estMinutes * t.durationDays : t.estMinutes;
}

export function daysLeftOf(deadline?: string | null): number | null {
  if (!deadline) return null;
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000));
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function fmtRange(start?: string | null, end?: string | null): string {
  const s = fmtDate(start);
  const e = fmtDate(end);
  if (s && e && s !== e) return `${s}–${e}`;
  return e || s;
}

export function parseDiff(json: string): PlanDiff | null {
  try {
    return JSON.parse(json) as PlanDiff;
  } catch {
    return null;
  }
}

/** 全量 goals 数据 hook（Today/Goals/Calendar/Activity 共用）。 */
export function useGoals() {
  const [goals, setGoals] = useState<GoalView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/goals");
      const json = (await res.json()) as Envelope<GoalView[]>;
      if (json.ok && json.data) setGoals(json.data);
      else setError(json.error ?? "加载失败");
    } catch {
      setError("网络不可达，请检查服务是否在运行");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { goals, loading, error, refresh, setError };
}

/** 乐观更新任务状态；失败回滚并返回错误。 */
export async function patchTaskStatus(
  setGoals: React.Dispatch<React.SetStateAction<GoalView[]>>,
  taskId: string,
  status: TaskStatus,
): Promise<string | null> {
  let snapshot: GoalView[] | null = null;
  setGoals((prev) => {
    snapshot = prev;
    return prev.map((g) => ({ ...g, tasks: g.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) }));
  });
  try {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) throw new Error();
    return null;
  } catch {
    if (snapshot) setGoals(snapshot);
    return "更新任务失败";
  }
}
