"use client";

import { useState } from "react";
import { ArrowRightLeft, ChevronDown, Minus, Plus, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanDiff, PlanDiffItem } from "@/lib/types";

function fmtShort(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** reason 长句分条：LLM 输出的一句话拆成可扫读的要点（诚实呈现，不改写内容）。 */
function reasonLines(reason: string): string[] {
  return reason
    .split(/[。！？；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function ChangeTag({ kind }: { kind: "move" | "adjust" | "add" | "remove" }) {
  const conf = {
    move: { icon: ArrowRightLeft, label: "移动", cls: "border bg-muted text-foreground" },
    adjust: { icon: SlidersHorizontal, label: "调整", cls: "border bg-muted text-foreground" },
    add: { icon: Plus, label: "新增", cls: "border-success/25 bg-success/10 text-success" },
    remove: { icon: Minus, label: "移除", cls: "border-danger/25 bg-danger/10 text-danger" },
  }[kind];
  const Icon = conf.icon;
  return (
    <span className={cn("inline-flex w-14 shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none", conf.cls)}>
      <Icon className="size-3" aria-hidden />
      {conf.label}
    </span>
  );
}

function MoveRow({ item }: { item: PlanDiffItem }) {
  const dateMoved = item.dueFrom != null && item.dueTo != null && item.dueFrom !== item.dueTo;
  const estChanged = item.estMinutesFrom !== undefined && item.estMinutesTo !== undefined && item.estMinutesFrom !== item.estMinutesTo;
  const kind = dateMoved ? "move" : "adjust";
  return (
    <li className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
      <ChangeTag kind={kind} />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      <span className="tabular shrink-0 text-xs text-muted-foreground">
        {dateMoved ? (
          <>
            <span className="text-muted-foreground/70">{fmtShort(item.dueFrom)}</span>
            <span className="mx-1 text-foreground/60" aria-label="移动到">
              →
            </span>
            <span className="font-medium text-foreground">{fmtShort(item.dueTo)}</span>
            {item.moved && item.moved !== "不变" && <span className="ml-1.5">{item.moved}</span>}
          </>
        ) : estChanged ? (
          <>
            <span className="text-muted-foreground/70">{item.estMinutesFrom}m</span>
            <span className="mx-1 text-foreground/60">→</span>
            <span className="font-medium text-foreground">{item.estMinutesTo}m</span>
          </>
        ) : (
          <span>{item.estMinutes != null ? `${item.estMinutes}m` : ""}</span>
        )}
      </span>
    </li>
  );
}

/**
 * Shift Preview：Reality 变化后 PlanShift 的重规划提案（产品核心差异化 UI）。
 * 结构 = 建议摘要 → Move/Add/Remove 结构化行（Before → After）→ 原因分条 →
 * 完整明细（progressive disclosure）。只呈现，不执行。
 */
export function ShiftChanges({ diff }: { diff: PlanDiff }) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  return (
    <ul className="divide-y rounded-lg border" aria-label={`共 ${total} 项调整`}>
      {diff.added.map((a) => (
        <li key={`a-${a.title}`} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
          <ChangeTag kind="add" />
          <span className="min-w-0 flex-1 truncate">{a.title}</span>
          <span className="tabular shrink-0 text-xs text-muted-foreground">
            {a.dueTo ? fmtShort(a.dueTo) : ""}
            {a.estMinutes != null && <span className="ml-1.5">· {a.estMinutes}m</span>}
          </span>
        </li>
      ))}
      {diff.removed.map((r) => (
        <li key={`r-${r.title}`} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
          <ChangeTag kind="remove" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground line-through">{r.title}</span>
        </li>
      ))}
      {diff.changed.map((c) => (
        <MoveRow key={`c-${c.title}`} item={c} />
      ))}
    </ul>
  );
}

/** Reason 分条 + finalize 说明（shift-preview 内嵌使用）。 */
export function ShiftReason({ reason, finalize }: { reason: string; finalize?: { finalizeAdjusted?: boolean; reason?: string } | null }) {
  const lines = reasonLines(reason);
  return (
    <div className="space-y-1.5 text-xs leading-relaxed">
      {lines.length <= 1 ? (
        <p className="text-muted-foreground">{reason}</p>
      ) : (
        <ul className="space-y-1">
          {lines.map((l, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
              <span className="min-w-0 flex-1 text-muted-foreground">{l}</span>
            </li>
          ))}
        </ul>
      )}
      {finalize?.finalizeAdjusted && finalize.reason && (
        <p className="border-l-2 border-border pl-2 text-[11px] text-muted-foreground">最终调整：{finalize.reason}</p>
      )}
    </div>
  );
}

/** 完整明细折叠区（PlanDiff 摘要 + 全量行）——默认收起。 */
export function ShiftDetails({ diff }: { diff: PlanDiff }) {
  const [open, setOpen] = useState(false);
  const estDelta = diff.summary.estDelta;
  return (
    <div className="rounded-lg border">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3.5 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <span className="tabular">
          完整明细：新增 {diff.summary.added} · 删除 {diff.summary.removed} · 保留 {diff.summary.kept} · 估时{" "}
          <span className={cn(estDelta > 0 ? "text-warning" : estDelta < 0 ? "text-success" : "")}>
            {estDelta >= 0 ? "+" : ""}
            {estDelta}m
          </span>
        </span>
        <ChevronDown className={cn("size-3.5 transition-transform duration-150", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="animate-fade border-t px-3.5 py-2.5">
          <ShiftChanges diff={diff} />
        </div>
      )}
    </div>
  );
}
