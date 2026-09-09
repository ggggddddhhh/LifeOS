"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatInZone } from "@/lib/time";
import type { Envelope } from "@/lib/types";

interface DraftRow {
  id: string;
  taskTitle: string;
  proposedStart: string;
  proposedEnd: string;
  timezone?: string | null;
  status: string;
  reason?: string | null;
}

interface WriteRow {
  taskId: string;
  status: string;
  error?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending_confirmation: "待确认",
  confirmed: "已确认，执行中",
  executed: "✅ 已排期",
  failed: "⚠️ 失败",
  stale_conflict: "⛔ 时间冲突",
  duplicate_skipped: "🔁 重复跳过",
  cancelled: "已取消",
};

/** 按草稿自身时区显示（无时区标记的存量按默认），Instant 不做任何墙钟转换 */
function fmt(dt: string, tz?: string | null): string {
  return formatInZone(dt, tz || "Asia/Shanghai");
}

function durationMin(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

export function CalendarPanel({ goalId }: { goalId: string }) {
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [writes, setWrites] = useState<WriteRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/goals/${goalId}/calendar/drafts`);
    const json = (await res.json()) as Envelope<{ drafts: DraftRow[]; writes: WriteRow[] }>;
    if (json.ok) {
      setDrafts(json.data.drafts);
      setWrites(json.data.writes);
    } else setError(json.error);
  }, [goalId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const pending = drafts.filter((d) => d.status === "pending_confirmation");
  const hasTerminal = drafts.some((d) => ["executed", "failed", "stale_conflict", "duplicate_skipped"].includes(d.status));

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/calendar/drafts`, { method: "POST" });
      const json = (await res.json()) as Envelope<{ drafts: DraftRow[] }>;
      if (!json.ok) setError(json.error);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function confirmAll() {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/calendar/confirm`, { method: "POST" });
      const json = (await res.json()) as Envelope<{
        summary: { success: number; failed: number; stale_conflict: number; duplicate_skipped: number };
      }>;
      if (!json.ok) {
        setError(`${json.error}（草稿保留，可重试）`);
      } else {
        const s = json.data.summary;
        setSummary(
          `写入完成：成功 ${s.success} · 失败 ${s.failed} · 冲突 ${s.stale_conflict} · 重复跳过 ${s.duplicate_skipped}`,
        );
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function cancelAll() {
    setBusy(true);
    await fetch(`/api/goals/${goalId}/calendar/cancel`, { method: "POST" });
    await refresh();
    setBusy(false);
  }

  if (drafts.length === 0 && !busy) {
    return (
      <div className="mt-3 border-t pt-3">
        <Button size="sm" variant="outline" onClick={generate} disabled={busy}>
          📆 生成日历草稿
        </Button>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {pending.length > 0
            ? `LifeOS 准备向日历创建以下 ${pending.length} 个事件`
            : hasTerminal
              ? "日历排期状态"
              : "日历草稿"}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={generate} disabled={busy || pending.length > 0}>
            重新生成
          </Button>
          {pending.length > 0 && (
            <>
              <Button size="sm" onClick={confirmAll} disabled={busy}>
                {busy ? "写入中…" : "Confirm all"}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancelAll} disabled={busy}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>
      {pending.length > 0 && (
        <ul className="mt-2 space-y-1">
          {pending.map((d) => (
            <li key={d.id} className="flex items-center justify-between rounded-md border px-2 py-1 text-xs">
              <span className="font-medium">{d.taskTitle}</span>
              <span className="text-muted-foreground">
                {fmt(d.proposedStart, d.timezone)} – {fmt(d.proposedEnd, d.timezone)} · {durationMin(d.proposedStart, d.proposedEnd)} 分钟
              </span>
            </li>
          ))}
        </ul>
      )}
      {hasTerminal && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {drafts
            .filter((d) => d.status !== "pending_confirmation" && d.status !== "cancelled")
            .map((d) => (
              <li key={d.id} className="flex items-center justify-between text-muted-foreground">
                <span>
                  {STATUS_LABEL[d.status] ?? d.status} · {d.taskTitle}（{fmt(d.proposedStart, d.timezone)}）
                </span>
                <span className="text-[11px]">{d.status === "stale_conflict" ? "需重新生成草稿" : ""}</span>
              </li>
            ))}
        </ul>
      )}
      {summary && <p className="mt-2 text-xs font-medium">{summary}</p>}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {writes.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          历史写入 {writes.length} 条（provider 已记录 externalEventId）
        </p>
      )}
    </div>
  );
}
