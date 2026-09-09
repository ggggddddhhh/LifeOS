import { describe, expect, it } from "vitest";
import { extractJson, normalizePlannedTasks } from "@/lib/llm/parse";

describe("extractJson", () => {
  it("解析纯 JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("解析 ```json 包裹的输出", () => {
    expect(extractJson('前置说明\n```json\n[1,2]\n```\n后置')).toEqual([1, 2]);
  });
  it("解析带前后噪音的 JSON", () => {
    expect(extractJson('好的，这是结果：{"tasks":[]} 希望有帮助')).toEqual({ tasks: [] });
  });
  it("无 JSON 时抛错", () => {
    expect(() => extractJson("没有任何结构化内容")).toThrow();
  });
});

describe("normalizePlannedTasks", () => {
  it("规范化并裁剪非法字段", () => {
    const out = normalizePlannedTasks([
      { title: "  任务一 ", notes: "说明", priority: 0, estMinutes: 99999 },
      { title: "", estMinutes: 30 },
      "garbage",
      { title: "任务二", priority: 2, estMinutes: "45" },
    ]);
    expect(out).toEqual([
      { title: "任务一", notes: "说明", priority: 2, estMinutes: 600 },
      { title: "任务二", priority: 2, estMinutes: 60 },
    ]);
  });
  it("非数组输入返回空", () => {
    expect(normalizePlannedTasks(null)).toEqual([]);
    expect(normalizePlannedTasks({})).toEqual([]);
  });
  it("重复标题（归一化后）只保留首条", () => {
    const out = normalizePlannedTasks([
      { title: "写测试", priority: 1, estMinutes: 60 },
      { title: "写测试", priority: 2, estMinutes: 90 },
      { title: "写 测试。", priority: 3, estMinutes: 30 },
      { title: "另一个任务", priority: 2, estMinutes: 30 },
    ]);
    expect(out).toEqual([
      { title: "写测试", priority: 1, estMinutes: 60 },
      { title: "另一个任务", priority: 2, estMinutes: 30 },
    ]);
  });
});
