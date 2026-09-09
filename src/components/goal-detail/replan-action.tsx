"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PlanDiffView } from "./plan-diff";
import type { PlanDiff } from "@/lib/types";

/** Replan（克制的 AI Action）：按钮 + 进行中 + 结果（reason 摘要 + diff + finalize 说明）。 */
export function ReplanAction({
  goalId,
  disabledReason,
  onDone,
}: {
  goalId: string;
  disabledReason?: string | null;
  onDone: (result: { reason: string; diff: PlanDiff; finalize?: unknown }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ reason: string; diff: PlanDiff; finalizeNote?: string } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/replan`, { method: "POST" });
      const json = (await res.json()) as { ok: boolean; error?: string; data?: { reason: string; diff: PlanDiff; finalize?: { finalizeAdjusted?: boolean; reason?: string } | null } };
      if (!json.ok || !json.data) {
        setError(json.error ?? "Replan 失败");
        return;
      }
      const fin = json.data.finalize;
      setResult({
        reason: json.data.reason,
        diff: json.data.diff,
        finalizeNote: fin?.finalizeAdjusted ? fin.reason : undefined,
      });
      onDone(json.data);
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} disabled={busy || !!disabledReason} title={disabledReason ?? undefined}>
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : <Sparkles className="mr-1.5 size-3.5" aria-hidden />}
          {busy ? "分析中…" : "Replan"}
        </Button>
        {disabledReason && <span className="text-[11px] text-muted-foreground">{disabledReason}</span>}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {result && (
        <div className="animate-rise rounded-lg border bg-muted/30 px-3.5 py-3">
          <p className="text-xs leading-relaxed text-foreground">{result.reason}</p>
          {result.finalizeNote && (
            <p className="mt-1.5 border-l-2 border-border pl-2 text-[11px] leading-relaxed text-muted-foreground">
              最终调整：{result.finalizeNote}
            </p>
          )}
          <div className="mt-2.5 border-t pt-2.5">
            <PlanDiffView diff={result.diff} />
          </div>
        </div>
      )}
    </div>
  );
}
