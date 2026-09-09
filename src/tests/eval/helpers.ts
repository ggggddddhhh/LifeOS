import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PlannerRecord {
  goal: string;
  deadline: string;
  daysLeft: number;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  tasks?: { title: string; priority: number; estMinutes: number; notes?: string }[];
  taskCount?: number;
  duplicateTitles?: string[];
  priorityRangeOk?: boolean;
  hasHighPriority?: boolean;
  estRangeOk?: boolean;
  /** 总估时 / 剩余天数 = 日均强度（分钟/天）。>480 分钟/天视为过载 */
  minutesPerDay?: number;
  overload?: boolean;
}

export interface ReplanRecord {
  goal: string;
  scenario: string;
  daysLeft: number;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  reason?: string;
  reasonMeaningful?: boolean;
  tasks?: { title: string; priority: number; estMinutes: number }[];
  taskCount?: number;
  prevOpenCount?: number;
  duplicateTitles?: string[];
  minutesPerDay?: number;
  overload?: boolean;
  /** 新计划总估时 / 原未完成总估时，<1 表示压缩 */
  compression?: number;
  doneTitlesLeaked?: string[];
  priorityRangeOk?: boolean;
}

const outDir = path.resolve(process.cwd(), "docs/eval");

export function writeReport(name: string, data: unknown) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2), "utf-8");
}

/** 精确 + 归一化（去空白/标点/大小写）双重判重 */
export function findDuplicates(titles: string[]): string[] {
  const seen = new Map<string, string>();
  const dups = new Set<string>();
  for (const t of titles) {
    const norm = t.toLowerCase().replace(/[\s，。、,.:：;；!！?？·\-—_/\\()（）\[\]【】"'"']+/g, "");
    if (seen.has(norm)) dups.add(t);
    seen.set(norm, t);
  }
  return [...dups];
}

export function daysUntil(iso?: string): number {
  if (!iso) return 14;
  return Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 86400000));
}
