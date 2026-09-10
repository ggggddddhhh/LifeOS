"use client";

import { useState } from "react";
import { Loader2, RefreshCw, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShiftChanges, ShiftDetails, ShiftReason } from "./shift-preview";
import type { PlanDiff, PlannedTask } from "@/lib/types";
import type { Envelope } from "@/lib/ui-data";

interface PreviewData {
  preview: true;
  reason: string;
  diff: PlanDiff;
  tasks: PlannedTask[];
  capacityMinutes?: number | null;
  finalize?: { finalizeAdjusted?: boolean; reason?: string } | null;
}

export interface ReplanResultInfo {
  capacityMinutes?: number | null;
}

/**
 * Replan（确认制，产品核心 Action）：
 * 分析（预览，不落库）→ Shift Preview 审阅（结构化 Before→After + 原因）→ 应用 → 可撤销。
 * 与日历写入同一原则：AI 只提案，改计划必须人确认。
 */
export function ReplanAction({
  goalId,
  disabledReason,
  onDone,
}: {
  goalId: string;
  disabledReason?: string | null;
  onDone?: (info?: ReplanResultInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [undoable, setUndoable] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  async function runPreview() {
    setBusy(true);
    setError(null);
    setPreview(null);
    setAppliedNote(null);
    setUndoable(false);
    try {
      const res = await fetch(`/api/goals/${goalId}/replan?preview=1`, { method: "POST" });
      const json = (await res.json()) as Envelope<PreviewData>;
      if (!json.ok || !json.data) {
        setError(json.error ?? "分析失败");
        return;
      }
      setPreview(json.data);
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/replan/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reasonBase: preview.reason,
          tasks: preview.tasks,
          capacityMinutes: preview.capacityMinutes ?? null,
        }),
      });
      const json = (await res.json()) as Envelope<{ revision: number }>;
      if (!json.ok) {
        setError(json.error ?? "应用失败");
        return;
      }
      setAppliedNote(`已按新计划（第 ${json.data?.revision} 版）调整任务。接下来可以生成新的日历排期草稿。`);
      setUndoable(true);
      setPreview(null);
      onDone?.({ capacityMinutes: preview.capacityMinutes ?? null });
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setUndoBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/replan/undo`, { method: "POST" });
      const json = (await res.json()) as Envelope<unknown>;
      if (!json.ok) {
        setError(json.error ?? "撤销失败");
        return;
      }
      setAppliedNote("已撤销这次调整，恢复为之前的任务列表。");
      setUndoable(false);
      onDone?.();
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setUndoBusy(false);
    }
  }

  const changeCount = preview ? preview.diff.added.length + preview.diff.removed.length + preview.diff.changed.length : 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={runPreview} disabled={busy || !!disabledReason} title={disabledReason ?? undefined}>
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 size-3.5" aria-hidden />}
          {busy ? "正在分析进度与容量…" : "重新规划"}
        </Button>
        {undoable && (
          <Button variant="outline" onClick={undo} disabled={undoBusy}>
            {undoBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : <RotateCcw className="mr-1.5 size-3.5" aria-hidden />}
            {undoBusy ? "撤销中…" : "撤销这次调整"}
          </Button>
        )}
        {disabledReason && <span className="text-[11px] text-muted-foreground">{disabledReason}</span>}
      </div>
      <p className="text-[11px] text-muted-foreground">
        根据真实进度、截止时间与日历容量重新提案——先预览调整内容，确认后才生效。
      </p>
      {error && <p className="text-xs text-danger">{error}</p>}
      {appliedNote && (
        <p className="animate-rise rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs leading-relaxed text-foreground">{appliedNote}</p>
      )}

      {preview && (
        <Dialog open onOpenChange={(v) => !v && !busy && setPreview(null)}>
          <DialogContent className="max-h-[85dvh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
            <DialogHeader className="border-b px-5 py-4">
              <DialogTitle className="flex items-center gap-2">
                重新规划
                {changeCount > 0 && (
                  <span className="tabular rounded border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {changeCount} 项调整
                  </span>
                )}
              </DialogTitle>
              <DialogDescription>
                根据当前进度、截止时间与日历容量，PlanShift 建议调整未完成的任务。
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[55dvh] space-y-4 overflow-auto px-5 py-4">
              {changeCount > 0 ? (
                <ShiftChanges diff={preview.diff} />
              ) : (
                <p className="rounded-lg border border-dashed px-3.5 py-3 text-xs text-muted-foreground">
                  新计划与当前未完成的任务一致，不需要调整。
                </p>
              )}
              <ShiftDetails diff={preview.diff} />
              <section aria-label="调整原因" className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">原因</h3>
                <ShiftReason reason={preview.reason} finalize={preview.finalize} />
              </section>
            </div>

            <DialogFooter className="items-start gap-1 px-5">
              <p className="flex w-full items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground sm:order-first sm:w-auto sm:max-w-xs">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                确认只更新 PlanShift 的任务计划，不会改动你的 Google Calendar——写入日历需要单独确认。
              </p>
              <div className="flex gap-2">
                <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
                  不采用
                </Button>
                <Button onClick={apply} disabled={busy}>
                  {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
                  {busy ? "应用中…" : changeCount > 0 ? `确认 ${changeCount} 项调整` : "确认"}
                </Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
