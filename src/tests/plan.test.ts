import { describe, expect, it } from "vitest";
import {
  budgetMinutes,
  computePlanDiff,
  enforceTaskBudget,
  sanitizeDependencies,
  sanitizeSchedule,
} from "@/lib/plan";
import type { PlannedTask } from "@/lib/types";

function task(p: Partial<PlannedTask> & { title: string }): PlannedTask {
  return { priority: 2, estMinutes: 60, ...p };
}

describe("sanitizeDependencies", () => {
  it("去自引用与未知引用", () => {
    const { deps, droppedEdges } = sanitizeDependencies([
      task({ title: "A", dependsOn: ["A", "不存在的任务"] }),
      task({ title: "B", dependsOn: ["A"] }),
    ]);
    expect(deps["a"]).toEqual([]);
    expect(deps["b"]).toEqual(["a"]);
    expect(droppedEdges).toBe(2);
  });

  it("去环：A→B→C→A 的环边被丢弃", () => {
    const { deps } = sanitizeDependencies([
      task({ title: "A", dependsOn: ["C"] }),
      task({ title: "B", dependsOn: ["A"] }),
      task({ title: "C", dependsOn: ["B"] }),
    ]);
    const edges = Object.values(deps).flat();
    // 去环后剩余边数 < 3（至少丢弃一条）
    expect(edges.length).toBeLessThan(3);
    // 重新做拓扑排序应无环残留
    const again = sanitizeDependencies(
      ["A", "B", "C"].map((t) => task({ title: t, dependsOn: deps[t.toLowerCase()]?.map((d) => d.toUpperCase()) ?? [] })),
    );
    expect(again.droppedEdges).toBe(0);
  });
});

describe("sanitizeSchedule", () => {
  const today = "2026-09-09";
  const deadline = "2026-09-30";

  it("钳制到 [今天, 截止日] 且 startDate ≤ dueDate", () => {
    const tasks = [
      task({ title: "A", startDate: "2026-08-01", dueDate: "2026-12-31" }), // 越界
      task({ title: "B", startDate: "2026-09-15", dueDate: "2026-09-10" }), // 反了
    ];
    const { deps } = sanitizeDependencies(tasks);
    sanitizeSchedule(tasks, deps, { today, deadline });
    expect(tasks[0].startDate).toBe(today);
    expect(tasks[0].dueDate).toBe(deadline);
    expect(tasks[1].startDate).toBe("2026-09-10");
    expect(tasks[1].dueDate).toBe("2026-09-15");
  });

  it("周期型任务 dueDate = startDate + durationDays - 1", () => {
    const tasks = [task({ title: "每日跑步", estMinutes: 30, durationDays: 7, startDate: "2026-09-10" })];
    const { deps } = sanitizeDependencies(tasks);
    sanitizeSchedule(tasks, deps, { today, deadline });
    expect(tasks[0].dueDate).toBe("2026-09-16");
  });

  it("依赖顺序：B 的 dueDate 不早于 A", () => {
    const tasks = [
      task({ title: "A", dueDate: "2026-09-20" }),
      task({ title: "B", dueDate: "2026-09-12", dependsOn: ["A"] }),
    ];
    const { deps } = sanitizeDependencies(tasks);
    sanitizeSchedule(tasks, deps, { today, deadline });
    expect(tasks[1].dueDate).toBe("2026-09-20");
  });

  it("依赖链传播：C ≥ B ≥ A", () => {
    const tasks = [
      task({ title: "A", dueDate: "2026-09-25" }),
      task({ title: "B", dueDate: "2026-09-13", dependsOn: ["A"] }),
      task({ title: "C", dueDate: "2026-09-11", dependsOn: ["B"] }),
    ];
    const { deps } = sanitizeDependencies(tasks);
    sanitizeSchedule(tasks, deps, { today, deadline });
    expect(tasks[1].dueDate).toBe("2026-09-25");
    expect(tasks[2].dueDate).toBe("2026-09-25");
  });
});

describe("enforceTaskBudget", () => {
  it("超上限优先移除新增的低优先级任务", () => {
    const oldTitles = new Set(["保留一", "保留二"]);
    const tasks = [
      task({ title: "保留一" }),
      task({ title: "保留二" }),
      task({ title: "新增A", priority: 3 }),
      task({ title: "新增B", priority: 1 }),
    ];
    const out = enforceTaskBudget(tasks, oldTitles);
    expect(out.length).toBe(3); // cap = 2 + 1
    expect(out.map((t) => t.title)).toContain("保留一");
    expect(out.map((t) => t.title)).toContain("保留二");
    expect(out.map((t) => t.title)).not.toContain("新增A"); // 低优先级新增被移除
  });

  it("被依赖的任务不会被移除", () => {
    const oldTitles = new Set(["A"]);
    const tasks = [
      task({ title: "A", priority: 1 }),
      task({ title: "B", priority: 3, dependsOn: ["新增C"] }),
      task({ title: "新增C", priority: 3 }),
    ];
    const out = enforceTaskBudget(tasks, oldTitles);
    expect(out.map((t) => t.title)).toContain("新增C"); // B 依赖它
    expect(out.length).toBe(2);
  });

  it("未超上限原样返回", () => {
    const oldTitles = new Set(["A", "B"]);
    const tasks = [task({ title: "A" }), task({ title: "B" }), task({ title: "C" })];
    expect(enforceTaskBudget(tasks, oldTitles).length).toBe(3);
  });
});

describe("computePlanDiff", () => {
  const oldOpen = [
    { title: "写首页", estMinutes: 300, dueDate: "2026-09-12" },
    { title: "部署", estMinutes: 120, dueDate: "2026-09-14" },
    { title: "SEO 优化", estMinutes: 90, dueDate: "2026-09-13" },
  ];

  it("分类新增/删除/变化", () => {
    const diff = computePlanDiff(oldOpen, [
      task({ title: "写首页", estMinutes: 180, dueDate: "2026-09-12" }), // 估时变化
      task({ title: "部署", estMinutes: 120, dueDate: "2026-09-16" }), // 延后
      task({ title: "域名备案", estMinutes: 60, dueDate: "2026-09-10" }), // 新增
    ]);
    expect(diff.added.map((a) => a.title)).toEqual(["域名备案"]);
    expect(diff.removed.map((r) => r.title)).toEqual(["SEO 优化"]);
    expect(diff.summary).toEqual({ added: 1, removed: 1, kept: 2, estDelta: 180 + 120 + 60 - 510 });
    const 写首页 = diff.changed.find((c) => c.title === "写首页")!;
    expect(写首页.estMinutesFrom).toBe(300);
    expect(写首页.estMinutesTo).toBe(180);
    expect(写首页.moved).toBe("不变");
    const 部署 = diff.changed.find((c) => c.title === "部署")!;
    expect(部署.moved).toBe("延后");
  });

  it("提前检测", () => {
    const diff = computePlanDiff(
      [{ title: "部署", estMinutes: 120, dueDate: "2026-09-20" }],
      [task({ title: "部署", estMinutes: 120, dueDate: "2026-09-11" })],
    );
    expect(diff.changed[0].moved).toBe("提前");
  });

  it("标题归一化匹配（空白/标点差异视为同一任务）", () => {
    const diff = computePlanDiff(
      [{ title: "写 首页", estMinutes: 300 }],
      [task({ title: "写首页。", estMinutes: 300 })],
    );
    expect(diff.summary.kept).toBe(1);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]); // 无变化则不进 changed
  });
});

describe("budgetMinutes", () => {
  it("单次型 = estMinutes，周期型 = estMinutes × durationDays", () => {
    expect(budgetMinutes({ estMinutes: 120 })).toBe(120);
    expect(budgetMinutes({ estMinutes: 30, durationDays: 20 })).toBe(600);
    expect(budgetMinutes({ estMinutes: 30, durationDays: null })).toBe(30);
  });
});
