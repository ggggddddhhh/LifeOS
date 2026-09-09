/**
 * Phase 6：共享黄金向量（docs/constraints-vectors.json）—— 与 pytest 消费同一文件。
 * TS plan.ts 是 defense-in-depth 实现；对这些向量必须产出与 Python finalize 一致的期望。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { enforceTaskBudget, enforceTimeBudget, sanitizeDependencies, sanitizeSchedule } from "@/lib/plan";
import type { PlannedTask } from "@/lib/types";

const vectors = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "docs/constraints-vectors.json"), "utf8"),
) as {
  specVersion: string;
  cases: {
    name: string;
    tasks: Partial<PlannedTask>[];
    oldOpenTitles?: string[];
    today?: string;
    deadline?: string;
    daysLeft: number;
    capacityOverride: number | null;
    expect: {
      titles?: string[];
      notContains?: string[];
      total?: number;
      totalAtMost?: number;
      minPerTask?: number;
      dueDateOf?: Record<string, string>;
      adjustmentTypes?: string[];
    };
  }[];
};

describe("共享约束向量（TS 侧 defense-in-depth 一致性）", () => {
  it("specVersion 固定", () => {
    expect(vectors.specVersion).toBe("1");
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      const tasks: PlannedTask[] = c.tasks.map((t) => ({
        title: t.title!,
        priority: t.priority ?? 2,
        estMinutes: t.estMinutes ?? 60,
        ...(t.dependsOn ? { dependsOn: t.dependsOn } : {}),
        ...(t.startDate ? { startDate: t.startDate } : {}),
        ...(t.dueDate ? { dueDate: t.dueDate } : {}),
        ...(t.durationDays ? { durationDays: t.durationDays } : {}),
      }));
      const { deps } = sanitizeDependencies(tasks);
      sanitizeSchedule(tasks, deps, { today: c.today ?? new Date().toISOString().slice(0, 10), deadline: c.deadline ?? null });

      let out = tasks;
      if (c.oldOpenTitles) out = enforceTaskBudget(out, new Set(c.oldOpenTitles));
      out = enforceTimeBudget(out, c.daysLeft, 480, c.capacityOverride).tasks;

      const titles = out.map((t) => t.title);
      for (const want of c.expect.titles ?? []) expect(titles, c.name).toContain(want);
      for (const banned of c.expect.notContains ?? []) expect(titles, c.name).not.toContain(banned);
      if (c.expect.total !== undefined) {
        expect(out.reduce((s, t) => s + t.estMinutes, 0), c.name).toBe(c.expect.total);
      }
      if (c.expect.totalAtMost !== undefined) {
        const total = out.reduce((s, t) => s + t.estMinutes, 0);
        expect(total, c.name).toBeLessThanOrEqual(c.expect.totalAtMost + 15 * out.length);
      }
      if (c.expect.minPerTask !== undefined) {
        for (const t of out) expect(t.estMinutes, c.name).toBeGreaterThanOrEqual(c.expect.minPerTask!);
      }
      for (const [d, want] of Object.entries(c.expect.dueDateOf ?? {})) {
        expect(out.find((t) => t.title === d)?.dueDate, c.name).toBe(want);
      }
    });
  }
});
