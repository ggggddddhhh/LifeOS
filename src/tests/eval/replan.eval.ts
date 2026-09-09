import { describe, expect, it } from "vitest";
import { planGoal, replanGoal } from "@/lib/llm";
import { computePlanDiff, enforceTaskBudget, enforceTimeBudget, sanitizeDependencies, sanitizeSchedule } from "@/lib/plan";
import type { ReplanInput, TaskSnapshot } from "@/lib/types";
import { findDuplicates, writeReport, type ReplanRecord } from "./helpers";

const day = 86400000;
function isoIn(days: number) {
  return new Date(Date.now() + days * day).toISOString();
}

// 三个代表性目标：项目交付 / 长期备考 / 生活事务
const SCENARIO_GOALS: { title: string; description?: string; totalDays: number }[] = [
  { title: "两周内上线个人博客网站", description: "已有域名，希望用 Next.js + Vercel 部署", totalDays: 14 },
  { title: "100 天内雅思总分考到 6.5", description: "上次模考 5.5，口语和写作较弱", totalDays: 100 },
  { title: "两周内完成跨城搬家并安顿好新家", totalDays: 14 },
];

// 三种进度情况
type ScenarioDef = { name: string; doneRatio: number; daysLeft: number; expectCompression: boolean };
const SCENARIOS: ScenarioDef[] = [
  { name: "正常进度", doneRatio: 0.4, daysLeft: 8, expectCompression: false },
  { name: "延期", doneRatio: 0.2, daysLeft: 2, expectCompression: true },
  { name: "部分完成", doneRatio: 0.7, daysLeft: 5, expectCompression: false },
];

const records: ReplanRecord[] = [];

async function runScenario(
  goal: { title: string; description?: string },
  initialTasks: { title: string; estMinutes: number; priority: number; dueDate?: string }[],
  sc: ScenarioDef,
) {
  const doneCount = Math.round(initialTasks.length * sc.doneRatio);
  const snapshots: TaskSnapshot[] = initialTasks.map((t, i) => ({
    title: t.title,
    status: i < doneCount ? "done" : i === doneCount ? "in_progress" : "todo",
    estMinutes: t.estMinutes,
    priority: t.priority,
    dueDate: t.dueDate ?? null,
  }));
  const doneTitles = snapshots.filter((t) => t.status === "done").map((t) => t.title);
  const openSnapshots = snapshots.filter((t) => t.status !== "done");
  const prevOpenMinutes = openSnapshots.reduce((s, t) => s + t.estMinutes, 0);

  const input: ReplanInput = {
    goalTitle: goal.title,
    goalDescription: goal.description,
    deadline: isoIn(sc.daysLeft),
    daysLeft: sc.daysLeft,
    tasks: snapshots,
  };

  const start = Date.now();
  let result: Awaited<ReturnType<typeof replanGoal>> | null = null;
  let error: string | undefined;
  try {
    result = await replanGoal(input);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const latencyMs = Date.now() - start;

  const rec: ReplanRecord = {
    goal: goal.title,
    scenario: sc.name,
    daysLeft: sc.daysLeft,
    ok: !!result,
    error,
    latencyMs,
    prevOpenCount: openSnapshots.length,
  };

  if (result) {
    // 与生产 replan 路由相同的管线：清洗 → 反扩散 guard → diff（用户所见）
    const { deps } = sanitizeDependencies(result.tasks);
    const today = new Date().toISOString().slice(0, 10);
    sanitizeSchedule(result.tasks, deps, { today, deadline: isoIn(sc.daysLeft).slice(0, 10) });
    const rawCount = result.tasks.length;
    const afterCountGuard = enforceTaskBudget(result.tasks, new Set(openSnapshots.map((t) => t.title)));
    const afterTimeGuard = enforceTimeBudget(afterCountGuard, sc.daysLeft);
    result = { reason: afterTimeGuard.note ? `${result.reason}（${afterTimeGuard.note}）` : result.reason, tasks: afterTimeGuard.tasks };

    const titles = result.tasks.map((t) => t.title);
    rec.reason = result.reason;
    rec.reasonMeaningful = result.reason.trim().length >= 10;
    rec.tasks = result.tasks;
    rec.taskCount = result.tasks.length;
    rec.duplicateTitles = findDuplicates(titles);
    rec.doneTitlesLeaked = titles.filter((t) =>
      doneTitles.some((d) => d.toLowerCase().replace(/\s+/g, "") === t.toLowerCase().replace(/\s+/g, "")),
    );
    rec.priorityRangeOk = result.tasks.every((t) => t.priority >= 1 && t.priority <= 3);
    const totalMin = result.tasks.reduce((s, t) => s + t.estMinutes, 0);
    rec.minutesPerDay = Math.round(totalMin / sc.daysLeft);
    rec.overload = rec.minutesPerDay > 480;
    rec.compression = prevOpenMinutes > 0 ? +(totalMin / prevOpenMinutes).toFixed(2) : undefined;

    // Phase 2：diff 指标（与生产同源算法，作用于 guard 之后的最终计划）
    const diff = computePlanDiff(
      openSnapshots.map((t) => ({ title: t.title, estMinutes: t.estMinutes, dueDate: t.dueDate })),
      result.tasks,
    );
    rec.addedCount = diff.summary.added;
    rec.removedCount = diff.summary.removed;
    rec.keptCount = diff.summary.kept;
    rec.estDelta = diff.summary.estDelta;
    rec.rawTaskCount = rawCount;
    records.push(rec);

    // 结构化断言（作用于用户实际拿到的最终计划）
    expect(rec.taskCount, "新计划任务数 >= 1").toBeGreaterThanOrEqual(1);
    expect(rec.duplicateTitles, "新计划内不应重复").toEqual([]);
    expect(rec.reasonMeaningful, "调整理由应具体").toBe(true);
    expect(rec.priorityRangeOk).toBe(true);
    expect(rec.overload, `延期场景下新计划仍过载（日均 ${rec.minutesPerDay} 分钟）`).toBe(false);
    // 反扩散硬保证（产品层 guard）：任务数不超过原未完成数 + 1
    expect(rec.taskCount, `任务数超限（${rec.taskCount} > ${openSnapshots.length}+1），范围蔓延`).toBeLessThanOrEqual(
      openSnapshots.length + 1,
    );
    if (sc.expectCompression && prevOpenMinutes > 480 * sc.daysLeft) {
      // 原计划在剩余时间内明显放不下 → 新计划必须压缩
      expect(rec.compression, `应压缩原计划（当前压缩比 ${rec.compression}）`).toBeLessThan(1);
    }
  } else {
    records.push(rec);
    expect.fail(`Replanner 失败: ${error}`);
  }
}

describe("真实 LLM：Replanner 三情景（3 目标 × 正常/延期/部分完成）", () => {
  for (const g of SCENARIO_GOALS) {
    let initialTasks: Awaited<ReturnType<typeof planGoal>> = [];

    it(`初始拆解「${g.title}」`, async () => {
      initialTasks = await planGoal({ title: g.title, description: g.description, deadline: isoIn(g.totalDays) });
      expect(initialTasks.length).toBeGreaterThanOrEqual(3);
    });

    for (const sc of SCENARIOS) {
      it(`Replan「${g.title}」— ${sc.name}`, async () => {
        await runScenario(g, initialTasks, sc);
      });
    }
  }

  it("汇总报告落盘", () => {
    writeReport("replan-results.json", {
      model: process.env.LLM_MODEL,
      ranAt: new Date().toISOString(),
      records,
    });
    for (const r of records) {
      console.log(
        `  [${r.ok ? "OK" : "FAIL"}] ${r.scenario} · ${r.goal} → ${r.taskCount} 任务(原 ${r.prevOpenCount}, 裸 ${r.rawTaskCount}), ` +
          `日均 ${r.minutesPerDay}min, 压缩比 ${r.compression}, diff(增${r.addedCount}/删${r.removedCount}/留${r.keptCount})` +
          `${r.overload ? " ⚠️过载" : ""}${r.doneTitlesLeaked?.length ? " ⚠️已完成任务泄漏" : ""}`,
      );
    }
  });
});
