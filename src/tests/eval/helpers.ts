import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PlannerRecord {
  goal: string;
  deadline: string;
  daysLeft: number;
  ok: boolean;
  error?: string;
  latencyMs?: number;
  tasks?: { title: string; priority: number; estMinutes: number; notes?: string; startDate?: string; dueDate?: string; durationDays?: number; dependsOn?: string[] }[];
  taskCount?: number;
  duplicateTitles?: string[];
  priorityRangeOk?: boolean;
  hasHighPriority?: boolean;
  estRangeOk?: boolean;
  /** 总估时 / 剩余天数 = 日均强度（分钟/天）。>480 分钟/天视为过载 */
  minutesPerDay?: number;
  overload?: boolean;
  // Phase 2 检查
  datesInRange?: boolean; // 清洗后（用户所见）所有日期 ∈ [今天, 截止日] 且 start ≤ due
  rawDatesInRange?: boolean; // LLM 裸输出日期合规率（信息指标，不作为门槛）
  datesCoverage?: number; // 带日期的任务占比 0-1
  depsValid?: boolean; // 依赖引用均存在、无自引用
  periodicCount?: number; // 周期型任务数
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
  // Phase 2：diff 指标
  addedCount?: number;
  removedCount?: number;
  keptCount?: number;
  estDelta?: number;
  rawTaskCount?: number; // LLM 裸输出任务数（guard 之前，信息指标）
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
