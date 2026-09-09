"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { StatusBadge, writeStatusBadge } from "@/components/shared/status-badge";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { formatInZone } from "@/lib/time";
import type { Envelope } from "@/lib/ui-data";

interface DraftRow {
  id: string;
  taskId: string;
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

/**
 * 日历写入区（Phase 7 确认制重呈现）：
 * 草稿清单 → 「写入我的日历」明确 external-write 确认 → 逐条结果徽章。
 * 业务语义（确认/幂等/stale/verify）全部走既有 API，零变更。
 */
export function CalendarDraftPanel({ goalId }: { goalId: string }) {
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [writes, setWrites] = useState<WriteRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [summary, setSummary] = useState<{ success: number; failed: number; stale_conflict: number; duplicate_skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/calendar/drafts`);
      const json = (await res.json()) as Envelope<{ drafts: DraftRow[]; writes: WriteRow[] }>;
      if (json.ok && json.data) {
        setDrafts(json.data.drafts);
        setWrites(json.data.writes);
      } else setError(json.error ?? "读取失败");
    } catch {
      setError("网络不可达");
    }
  }, [goalId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function generate() {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/calendar/drafts`, { method: "POST" });
      const json = (await res.json()) as Envelope<{ drafts: DraftRow[] }>;
      if (!json.ok) setError(json.error ?? "生成失败");
      await refresh();
    } catch {
      setError("网络不可达");
    } finally {
      setBusy(false);
    }
  }

  async function confirmAll() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/calendar/confirm`, { method: "POST" });
      const json = (await res.json()) as Envelope<{ summary: typeof summary }>;
      if (!json.ok || !json.data) setError(`${json.error ?? "写入失败"}（草稿保留，可重试确认）`);
      else setSummary(json.data.summary);
      await refresh();
    } catch {
      setError("网络不可达（草稿保留，可重试）");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  async function cancelAll() {
    setBusy(true);
    await fetch(`/api/goals/${goalId}/calendar/cancel`, { method: "POST"}).catch(() => {});
    await refresh();
    setBusy(false);
  }

  if (drafts === null) return <ListSkeleton rows={3} />;
  if (error && drafts.length === 0) return <ErrorState message={error} onRetry={refresh} />;

  const pending = drafts.filter((d) => d.status === "pending_confirmation" || d.status === "confirmed");
  const history = drafts.filter((d) => !pending.includes(d));

  return (
    <div className="space-y-4">
      {error && <ErrorState message={error} onRetry={refresh} />}

      {drafts.length === 0 && !error && (
        <EmptyState
          icon={CalendarPlus}
          title="尚未生成日历排期"
          hint="LifeOS 会读取你的日历空闲时段，生成待确认的排期草稿——不会直接写入"
          action={{ label: busy ? "生成中…" : "生成草稿", onClick: () => !busy && generate() }}
        />
      )}

      {pending.length > 0 && (
        <section aria-label="待确认草稿" className="rounded-lg border">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3.5 py-2.5">
            <div>
              <p className="text-[13px] font-medium">向你的日历创建 {pending.length} 个事件</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">确认后才会写入；时段如已被占用将自动跳过并标记</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={generate} disabled={busy || pending.some((d) => d.status === "confirmed")}>
                <RefreshCw className="mr-1.5 size-3.5" aria-hidden />
                重新生成
              </Button>
              {pending.some((d) => d.status === "pending_confirmation") && (
                <>
                  <Button size="sm" variant="ghost" onClick={cancelAll} disabled={busy}>
                    全部取消
                  </Button>
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" disabled={busy}>
                        {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : null}
                        写入我的日历
                      </Button>
                    }
                    title={`确认向日历写入 ${pending.length} 个事件？`}
                    description="LifeOS 将在以下时段创建事件（不会修改你已有的任何事件）。重复确认是安全的——已写入的会被幂等跳过。"
                    confirmLabel="确认写入"
                    busy={busy}
                    onConfirm={confirmAll}
                  >
                    <ul className="max-h-48 space-y-1 overflow-auto rounded-md bg-muted/40 p-2.5 text-xs">
                      {pending.map((d) => (
                        <li key={d.id} className="flex items-center justify-between gap-2">
                          <span className="truncate">{d.taskTitle}</span>
                          <span className="tabular shrink-0 text-muted-foreground">
                            {formatInZone(d.proposedStart, d.timezone || "Asia/Shanghai")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </ConfirmDialog>
                </>
              )}
            </div>
          </header>
          <ul className="divide-y">
            {pending.map((d) => {
              const b = writeStatusBadge(d.status);
              return (
                <li key={d.id} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">{d.taskTitle}</span>
                  <span className="tabular shrink-0 text-xs text-muted-foreground">
                    {formatInZone(d.proposedStart, d.timezone || "Asia/Shanghai")}
                  </span>
                  <StatusBadge tone={b.tone} dot>
                    {b.label}
                  </StatusBadge>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {summary && (
        <div className="animate-rise flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs">
          <span className="font-medium">写入结果</span>
          <StatusBadge tone="success">成功 {summary.success}</StatusBadge>
          {summary.duplicate_skipped > 0 && <StatusBadge>幂等跳过 {summary.duplicate_skipped}</StatusBadge>}
          {summary.stale_conflict > 0 && <StatusBadge tone="warning">时段冲突 {summary.stale_conflict}</StatusBadge>}
          {summary.failed > 0 && <StatusBadge tone="danger">失败 {summary.failed}</StatusBadge>}
        </div>
      )}

      {history.length > 0 && (
        <section aria-label="写入历史">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">写入记录</h4>
          <ul className="space-y-1">
            {history.map((d) => {
              const b = writeStatusBadge(d.status);
              return (
                <li key={d.id} className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{d.taskTitle}</span>
                  <span className="tabular shrink-0">
                    {formatInZone(d.proposedStart, d.timezone || "Asia/Shanghai")}
                  </span>
                  <StatusBadge tone={b.tone}>{b.label}</StatusBadge>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
