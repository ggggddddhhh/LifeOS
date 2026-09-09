"use client";

import { useState } from "react";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { PlanDiffView } from "./plan-diff";
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

/**
 * 重新规划（克制的 AI Action，Phase 10 确认制）：
 * 分析（预览，不落库）→ 用户在确认框审阅变更 → 应用 → 短期内可撤销。
 * 与日历写入同一原则：AI 只提案，改计划必须人确认。
 */
export function ReplanAction({
  goalId,
  disabledReason,
  onDone,
}: {
  goalId: string;
  disabledReason?: string | null;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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
    try {
      const res = await fetch(`/api/goals/${goalId}/replan?preview=1`, { method: "POST" });
      const json = (await res.json()) as Envelope<PreviewData>;
      if (!json.ok || !json.data) {
        setError(json.error ?? "分析失败");
        return;
      }
      setPreview(json.data);
      setConfirmOpen(true);
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
      setAppliedNote(`已按新计划（第 ${json.data?.revision} 版）调整任务，接下来可以生成新的日历排期`);
      setUndoable(true);
      setPreview(null);
      onDone();
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
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
      setAppliedNote("已撤销这次调整，恢复为之前的任务列表");
      setUndoable(false);
      onDone();
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setUndoBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={runPreview} disabled={busy || !!disabledReason} title={disabledReason ?? undefined}>
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : <Sparkles className="mr-1.5 size-3.5" aria-hidden />}
          {busy ? "分析中…" : "重新规划"}
        </Button>
        {undoable && (
          <Button size="sm" variant="outline" onClick={undo} disabled={undoBusy}>
            {undoBusy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : <RotateCcw className="mr-1.5 size-3.5" aria-hidden />}
            {undoBusy ? "撤销中…" : "撤销这次调整"}
          </Button>
        )}
        {disabledReason && <span className="text-[11px] text-muted-foreground">{disabledReason}</span>}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {appliedNote && (
        <p className="animate-rise rounded-lg border bg-muted/30 px-3.5 py-2.5 text-xs leading-relaxed text-foreground">{appliedNote}</p>
      )}

      {preview && (
        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={(v) => {
            setConfirmOpen(v);
            if (!v) setPreview(null);
          }}
          title="按这个新计划调整任务？"
          description="以下是调整内容，确认后才会替换当前未完成的任务。"
          confirmLabel="确认调整"
          busy={busy}
          onConfirm={apply}
        >
          <div className="max-h-72 space-y-2 overflow-auto">
            <p className="text-xs leading-relaxed text-foreground">{preview.reason}</p>
            {preview.finalize?.finalizeAdjusted && preview.finalize.reason && (
              <p className="border-l-2 border-border pl-2 text-[11px] leading-relaxed text-muted-foreground">
                最终调整：{preview.finalize.reason}
              </p>
            )}
            <div className="border-t pt-2">
              <PlanDiffView diff={preview.diff} />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              已写入日历的旧排期不会自动改动，可在应用后重新生成排期草稿。
            </p>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
