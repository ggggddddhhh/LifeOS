import { describe, expect, it } from "vitest";
import { planGoal, replanGoal } from "@/lib/llm";
import { extractJson, normalizePlannedTasks } from "@/lib/llm/parse";
import type { ReplanInput } from "@/lib/types";
import { findDuplicates, writeReport } from "./helpers";

const day = 86400000;

describe("边界：异常目标输入", () => {
  it("琐碎目标（买菜）不过度拆解或正常处理", async () => {
    const tasks = await planGoal({ title: "买菜" });
    console.log(`  琐碎目标 → ${tasks.length} 个任务: ${tasks.map((t) => t.title).join(" / ")}`);
    // 结构底线：仍是合法任务
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(findDuplicates(tasks.map((t) => t.title))).toEqual([]);
  });

  it("模糊长目标（无截止时间）可拆解", async () => {
    const tasks = await planGoal({ title: "变得更好", description: "希望自己能持续成长" });
    console.log(`  模糊目标 → ${tasks.length} 个任务`);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
  });

  it("超长标题不被截断破坏结构", async () => {
    const long = "提升".repeat(300);
    const tasks = await planGoal({ title: long, deadline: new Date(Date.now() + 14 * day).toISOString() });
    expect(tasks.length).toBeGreaterThanOrEqual(3);
  });
});

describe("边界：deadline 已过 / 仅剩今天", () => {
  it("daysLeft=1 时不崩溃且给出可执行计划", async () => {
    const input: ReplanInput = {
      goalTitle: "上线博客",
      daysLeft: 1,
      deadline: new Date(Date.now() + 6 * 3600000).toISOString(),
      tasks: [
        { title: "写首页", status: "in_progress", estMinutes: 300, priority: 1 },
        { title: "部署", status: "todo", estMinutes: 120, priority: 2 },
        { title: "买域名", status: "done", estMinutes: 30, priority: 1 },
      ],
    };
    const r = await replanGoal(input);
    expect(r.tasks.length).toBeGreaterThanOrEqual(1);
    const total = r.tasks.reduce((s, t) => s + t.estMinutes, 0);
    console.log(`  仅剩 1 天 → ${r.tasks.length} 任务共 ${total} 分钟；理由: ${r.reason}`);
    // 一天内放不下 8 小时即过载（信息记录，不强制断言，观察行为）
    writeReport("edge-daysleft1.json", { reason: r.reason, tasks: r.tasks, totalMinutes: total });
  });

  it("全部任务已完成时 replan 空计划的响应", async () => {
    const input: ReplanInput = {
      goalTitle: "上线博客",
      daysLeft: 3,
      tasks: [{ title: "写首页", status: "done", estMinutes: 300, priority: 1 }],
    };
    try {
      const r = await replanGoal(input);
      console.log(`  全部完成 → ${r.tasks.length} 个任务; 理由: ${r.reason}`);
      writeReport("edge-alldone.json", r);
    } catch (e) {
      // 空输入属于产品边界：记录行为即可
      console.log(`  全部完成 → 抛错: ${e instanceof Error ? e.message : e}`);
      writeReport("edge-alldone.json", { error: e instanceof Error ? e.message : String(e) });
    }
  });
});

describe("边界：LLM 输出损坏（parse 层压力测试）", () => {
  const hostile: [string, string][] = [
    ["截断的 JSON", '{"tasks":[{"title":"a"'],
    ["多个代码块", '```json\n{"a":1}\n```\n说明\n```json\n{"tasks":[]}\n```'],
    ["前后噪音", '好的！这是计划：{"tasks":[{"title":"调研","priority":1,"estMinutes":60}]} 希望有帮助'],
    ["非 JSON 文本", "我认为应该分三步：第一……"],
    ["JSON 内带注释", '{"tasks": /* list */ [{"title":"a"}]}'],
    ["tasks 是对象而非数组", '{"tasks":{"0":{"title":"a"}}}'],
    ["null 顶层", "null"],
  ];
  for (const [name, text] of hostile) {
    it(`extractJson: ${name}`, () => {
      let threw = false;
      let parsed: unknown;
      try {
        parsed = extractJson(text);
      } catch {
        threw = true; // 抛错是合法行为：上层会返回 500 给用户
      }
      if (!threw) {
        // 若未抛错，解析结果必须是对象/数组（不能是半成品字符串）
        expect(typeof parsed === "object" && parsed !== null).toBe(true);
      }
    });
  }

  it("normalizePlannedTasks: LLM 返回重复任务不会被去重（现状记录）", () => {
    const out = normalizePlannedTasks([
      { title: "写测试", priority: 1, estMinutes: 60 },
      { title: "写测试", priority: 2, estMinutes: 90 },
      { title: "写 测试", priority: 3, estMinutes: 30 },
    ]);
    console.log(`  重复输入 ${out.length} 条 → ${out.map((t) => t.title).join(" / ")}`);
    writeReport("edge-duplicates.json", { input: 3, output: out });
  });

  it("normalizePlannedTasks: 字段类型混乱时安全回退", () => {
    const out = normalizePlannedTasks([
      { title: 123, estMinutes: "60" },
      { title: "ok", priority: "高", estMinutes: null, notes: 42 },
      { title: "ok2", priority: 1.7, estMinutes: 45.6 },
    ]);
    expect(out).toEqual([
      { title: "ok", priority: 2, estMinutes: 60 }, // 非法字段安全回退为默认值，任务保留
      { title: "ok2", priority: 2, estMinutes: 46 },
    ]);
  });
});
