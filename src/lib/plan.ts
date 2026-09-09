import { normalizeTitle } from "./llm/parse";
import type { PlannedTask, PlanDiff, PlanDiffItem } from "./types";

const DAY_MS = 86400000;

/** 任务依赖图（标题级，入库前使用） */
export interface DepGraph {
  [title: string]: string[]; // title -> 它依赖的标题列表
}

/**
 * 依赖清洗：去自引用、去指向不存在任务的引用、DFS 去环（关闭环的边丢弃）。
 * 返回清洗后的依赖图与被丢弃的边数。
 */
export function sanitizeDependencies(tasks: PlannedTask[]): { deps: DepGraph; droppedEdges: number } {
  const titles = new Set(tasks.map((t) => normalizeTitle(t.title)));
  const deps: DepGraph = {};
  let dropped = 0;

  // 邻接表：title -> 依赖它的任务（用于 DFS 找环）
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  const nodes = [...titles];
  nodes.forEach((n) => {
    adj.set(n, []);
    inDeg.set(n, 0);
  });

  for (const t of tasks) {
    const key = normalizeTitle(t.title);
    const list = (t.dependsOn ?? [])
      .map((d) => d.trim())
      .filter((d) => {
        if (normalizeTitle(d) === key) {
          dropped++; // 自引用
          return false;
        }
        if (!titles.has(normalizeTitle(d))) {
          dropped++; // 未知引用
          return false;
        }
        return true;
      });
    const unique = [...new Set(list.map(normalizeTitle))];
    dropped += list.length - unique.length;
    deps[key] = unique;
  }

  // Kahn 拓扑排序去环：入度为 0 的入队，最终未出队的节点参与的边即为环
  for (const [k, ds] of Object.entries(deps)) {
    inDeg.set(k, ds.length);
    for (const d of ds) adj.get(d)!.push(k);
  }
  const queue = nodes.filter((n) => inDeg.get(n) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const next of adj.get(n) ?? []) {
      inDeg.set(next, inDeg.get(next)! - 1);
      if (inDeg.get(next) === 0) queue.push(next);
    }
  }
  const inCycle = new Set(nodes.filter((n) => !order.includes(n)));
  if (inCycle.size > 0) {
    for (const [k, ds] of Object.entries(deps)) {
      const filtered = ds.filter((d) => {
        if (inCycle.has(d) && inCycle.has(k)) {
          dropped++;
          return false;
        }
        return true;
      });
      deps[k] = filtered;
    }
  }
  return { deps, droppedEdges: dropped };
}

function toTime(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getTime();
}
function toStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 调度清洗（LLM 提议，代码强制）：
 * - 日期钳制到 [today, deadline]，startDate ≤ dueDate；
 * - 周期型：dueDate = min(deadline, startDate + durationDays - 1)；
 * - 依赖顺序：B dependsOn A ⇒ dueDate(B) ≥ dueDate(A)（拓扑序传播）。
 * deps 为 sanitizeDependencies 的输出。原位修改并返回。
 */
export function sanitizeSchedule(
  tasks: PlannedTask[],
  deps: DepGraph,
  opts: { today: string; deadline?: string | null },
): PlannedTask[] {
  const todayMs = toTime(opts.today);
  const deadlineMs = opts.deadline ? toTime(opts.deadline) : todayMs + 14 * DAY_MS;

  const byKey = new Map(tasks.map((t) => [normalizeTitle(t.title), t]));
  for (const t of tasks) {
    if (t.startDate) t.startDate = toStr(clamp(toTime(t.startDate), todayMs, deadlineMs));
    if (t.dueDate) t.dueDate = toStr(clamp(toTime(t.dueDate), todayMs, deadlineMs));
    if (t.startDate && t.dueDate && toTime(t.startDate) > toTime(t.dueDate)) {
      const s = t.startDate;
      t.startDate = t.dueDate;
      t.dueDate = s;
    }
    if (t.durationDays && t.durationDays >= 1 && t.startDate) {
      t.dueDate = toStr(Math.min(deadlineMs, toTime(t.startDate) + (t.durationDays - 1) * DAY_MS));
    }
  }

  // 依赖顺序传播（Kahn）：处理完 A 后，把依赖 A 的任务 dueDate 不早于 A 的 dueDate
  const dependents = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const t of tasks) {
    const k = normalizeTitle(t.title);
    inDeg.set(k, (deps[k] ?? []).length);
    for (const d of deps[k] ?? []) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d)!.push(k);
    }
  }
  const queue = [...inDeg.entries()].filter(([, d]) => d === 0).map(([k]) => k);
  while (queue.length > 0) {
    const k = queue.shift()!;
    const t = byKey.get(k)!;
    const dueMs = t.dueDate ? toTime(t.dueDate) : null;
    if (dueMs !== null) {
      for (const next of dependents.get(k) ?? []) {
        const nt = byKey.get(next)!;
        if (nt.dueDate && toTime(nt.dueDate) < dueMs) {
          nt.dueDate = toStr(Math.min(deadlineMs, dueMs)); // 依赖的完成日不早于前置
        }
        inDeg.set(next, inDeg.get(next)! - 1);
        if (inDeg.get(next) === 0) queue.push(next);
      }
    } else {
      for (const next of dependents.get(k) ?? []) {
        inDeg.set(next, inDeg.get(next)! - 1);
        if (inDeg.get(next) === 0) queue.push(next);
      }
    }
  }
  return tasks;
}

function clamp(ms: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, ms));
}

/**
 * 反扩散 guard（要求 #5 代码侧）：任务数上限 = oldOpenCount + 1。
 * 超限时优先移除「新增」任务（低优先级优先，且无人依赖它）；仍超限再移除低优先级的保留任务。
 * 返回裁剪后的任务列表。
 */
export function enforceTaskBudget(tasks: PlannedTask[], oldTitles: Set<string>): PlannedTask[] {
  const cap = oldTitles.size + 1;
  const out = [...tasks];
  const isKept = (t: PlannedTask) => oldTitles.has(normalizeTitle(t.title));
  const dependedBy = new Set<string>();
  for (const t of out) for (const d of t.dependsOn ?? []) dependedBy.add(normalizeTitle(d));

  const pickVictim = (preferAdded: boolean): number => {
    let best = -1;
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      if (dependedBy.has(normalizeTitle(t.title))) continue; // 有人依赖，不能删
      const added = !isKept(t);
      if (preferAdded !== added) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const cur = out[best];
      if (t.priority > cur.priority) best = i; // 优先级数字大 = 低优先级
    }
    return best;
  };

  while (out.length > cap) {
    let idx = pickVictim(true);
    if (idx === -1) idx = pickVictim(false);
    if (idx === -1) break; // 全部被依赖，放过
    const [victim] = out.splice(idx, 1);
    dependedBy.delete(normalizeTitle(victim.title));
  }
  return out;
}

/** 计算计划版本 diff（要求 #3）：按归一化标题匹配 oldOpen ↔ new */
export function computePlanDiff(
  oldOpen: { title: string; estMinutes: number; dueDate?: string | null }[],
  newTasks: PlannedTask[],
): PlanDiff {
  const newByKey = new Map(newTasks.map((t) => [normalizeTitle(t.title), t]));
  const oldByKey = new Map(oldOpen.map((t) => [normalizeTitle(t.title), t]));

  const added: PlanDiffItem[] = [];
  const removed: PlanDiffItem[] = [];
  const changed: PlanDiffItem[] = [];
  let kept = 0;
  const oldTotal = oldOpen.reduce((s, t) => s + t.estMinutes, 0);
  const newTotal = newTasks.reduce((s, t) => s + t.estMinutes, 0);

  for (const t of newTasks) {
    const key = normalizeTitle(t.title);
    const old = oldByKey.get(key);
    if (!old) {
      added.push({ title: t.title, estMinutes: t.estMinutes });
      continue;
    }
    kept++;
    const dueFrom = old.dueDate ?? null;
    const dueTo = t.dueDate ?? null;
    const estChanged = old.estMinutes !== t.estMinutes;
    const dueChanged = dueFrom !== dueTo;
    if (estChanged || dueChanged) {
      changed.push({
        title: t.title,
        estMinutesFrom: old.estMinutes,
        estMinutesTo: t.estMinutes,
        dueFrom,
        dueTo,
        moved: !dueChanged ? "不变" : toTime(dueTo!) > toTime(dueFrom!) ? "延后" : "提前",
      });
    }
  }
  for (const o of oldOpen) {
    if (!newByKey.has(normalizeTitle(o.title))) {
      removed.push({ title: o.title, estMinutes: o.estMinutes });
    }
  }

  return {
    added,
    removed,
    changed,
    summary: { added: added.length, removed: removed.length, kept, estDelta: newTotal - oldTotal },
  };
}

/** 任务的预算投入（分钟）：周期型 = estMinutes × durationDays，单次型 = estMinutes */
export function budgetMinutes(t: { estMinutes: number; durationDays?: number | null }): number {
  return t.durationDays && t.durationDays >= 1 ? t.estMinutes * t.durationDays : t.estMinutes;
}

export const CAPACITY_MINUTES_PER_DAY = 480;
