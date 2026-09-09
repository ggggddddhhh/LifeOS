/**
 * Agent Client 契约与降级测试（M2）。
 * 用本地 stub HTTP 服务模拟 Python Agent，覆盖：
 * 请求/响应字段契约、版本头、timeout、5xx、malformed、schema 不匹配、auto fallback。
 * 全部离线运行（Python 不在线也能跑）；local 路径使用 TS MockLlmClient。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { agentPlanGoal, agentReplanGoal, recentAgentCalls } from "@/lib/agent/client";

const PROMPT_VERSION = "2";

let server: Server;
let url = "";
/** stub 行为：由各测试注入 */
let handler: (body: unknown, headers: Record<string, string | undefined>) => {
  status: number;
  headers?: Record<string, string>;
  raw?: string; // 非 JSON 原文
  json?: unknown;
  delayMs?: number;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      const body = chunks ? JSON.parse(chunks) : {};
      const out = handler(body, req.headers as Record<string, string | undefined>);
      if (out.delayMs) {
        setTimeout(respond, out.delayMs);
      } else {
        respond();
      }
      function respond() {
        const headers = { "Content-Type": "application/json", ...(out.headers ?? {}) };
        if (out.raw !== undefined) {
          res.writeHead(out.status, headers).end(out.raw);
        } else {
          res.writeHead(out.status, headers).end(JSON.stringify(out.json));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr && typeof addr === "object") url = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  delete process.env.AGENT_MODE;
  delete process.env.AGENT_CORE_URL;
  delete process.env.AGENT_TIMEOUT_MS;
  delete process.env.LLM_API_KEY; // local 路径强制走 TS mock
});

const okPlan = {
  status: 200,
  headers: { "x-prompt-version": PROMPT_VERSION },
  json: {
    tasks: [
      { title: "调研", priority: 1, estMinutes: 60, dueDate: "2026-09-12" },
      { title: "执行", priority: 1, estMinutes: 120 },
      { title: "收尾", priority: 2, estMinutes: 30 },
    ],
  },
};

describe("契约：TS → Python 请求字段", () => {
  it("plan 请求体只含契约字段", async () => {
    process.env.AGENT_MODE = "python";
    process.env.AGENT_CORE_URL = url;
    let captured: unknown;
    handler = (body) => {
      captured = body;
      return okPlan;
    };
    await agentPlanGoal({ title: "学 Go", deadline: "2026-09-23T00:00:00.000Z" });
    expect(captured).toEqual({
      title: "学 Go",
      description: undefined,
      deadline: "2026-09-23T00:00:00.000Z",
    });
  });

  it("replan 请求体只含契约字段", async () => {
    process.env.AGENT_MODE = "python";
    process.env.AGENT_CORE_URL = url;
    let captured: unknown;
    handler = (body) => {
      captured = body;
      return {
        status: 200,
        headers: { "x-prompt-version": PROMPT_VERSION },
        json: { reason: "压缩", tasks: [{ title: "a", priority: 1, estMinutes: 60 }] },
      };
    };
    await agentReplanGoal({
      goalTitle: "g",
      daysLeft: 2,
      tasks: [{ title: "a", status: "todo", estMinutes: 300, priority: 1 }],
    });
    // JSON.stringify 丢弃 undefined 键：goalDescription/deadline/dueDate 不出现在线上请求体
    expect(captured).toEqual({
      goalTitle: "g",
      daysLeft: 2,
      tasks: [{ title: "a", status: "todo", estMinutes: 300, priority: 1 }],
    });
  });
});

describe("契约：Python → TS 响应字段（复验生效）", () => {
  it("合法响应通过并被规范化", async () => {
    process.env.AGENT_MODE = "python";
    process.env.AGENT_CORE_URL = url;
    handler = () => ({
      status: 200,
      headers: { "x-prompt-version": PROMPT_VERSION },
      json: {
        tasks: [
          { title: "  t1 ", priority: 9, estMinutes: 9999, junk: "多余字段被剥掉" },
          { title: "t2", priority: 1, estMinutes: 60 },
        ],
      },
    });
    const tasks = await agentPlanGoal({ title: "x" });
    expect(tasks).toEqual([
      { title: "t1", priority: 2, estMinutes: 600 },
      { title: "t2", priority: 1, estMinutes: 60 },
    ]);
  });

  it("tasks 非数组 → schema_mismatch（auto 下降级 local）", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = url;
    handler = () => ({
      status: 200,
      headers: { "x-prompt-version": PROMPT_VERSION },
      json: { tasks: "nope" },
    });
    const tasks = await agentPlanGoal({ title: "x" });
    // 降级到 local（TS mock）：5 个任务
    expect(tasks.length).toBe(5);
    const last = recentAgentCalls().at(-1)!;
    expect(last.provider).toBe("local");
    expect(last.fallbackReason).toBe("schema_mismatch");
  });

  it("malformed JSON（非 JSON 原文）→ bad_json 降级", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = url;
    handler = () => ({
      status: 200,
      headers: { "x-prompt-version": PROMPT_VERSION },
      raw: "<html>not json</html>",
    });
    const tasks = await agentPlanGoal({ title: "x" });
    expect(tasks.length).toBe(5);
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBe("bad_json");
  });

  it("replan 缺 reason → empty_reason 降级", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = url;
    handler = () => ({
      status: 200,
      headers: { "x-prompt-version": PROMPT_VERSION },
      json: { tasks: [{ title: "a", priority: 1, estMinutes: 60 }] },
    });
    const r = await agentReplanGoal({
      goalTitle: "g",
      daysLeft: 2,
      tasks: [{ title: "a", status: "todo", estMinutes: 300, priority: 1 }],
    });
    expect(r.reason).toBeTruthy();
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBe("empty_reason");
  });
});

describe("版本不一致", () => {
  it("x-prompt-version 不匹配 → version_mismatch 降级", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = url;
    handler = () => ({
      status: 200,
      headers: { "x-prompt-version": "1" },
      json: { tasks: [{ title: "a", priority: 1, estMinutes: 60 }] },
    });
    const tasks = await agentPlanGoal({ title: "x" });
    expect(tasks.length).toBe(5); // local mock
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBe("version_mismatch");
  });

  it("缺失版本头同样降级", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = url;
    handler = () => ({ status: 200, json: { tasks: [{ title: "a", priority: 1, estMinutes: 60 }] } });
    await agentPlanGoal({ title: "x" });
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBe("version_mismatch");
  });
});

describe("timeout / 5xx / 不可达", () => {
  it("超时 → timeout 降级 local", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = url;
    process.env.AGENT_TIMEOUT_MS = "80";
    handler = () => ({ ...okPlan, delayMs: 1000 });
    const start = Date.now();
    const tasks = await agentPlanGoal({ title: "x" });
    expect(Date.now() - start).toBeLessThan(800);
    expect(tasks.length).toBe(5);
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBe("timeout");
  });

  it("502 → http_502 降级", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = url;
    handler = () => ({
      status: 502,
      headers: { "x-prompt-version": PROMPT_VERSION },
      json: { error: { code: "AGENT_PARSE_ERROR", message: "两次无法解析", retryable: true } },
    });
    const tasks = await agentPlanGoal({ title: "x" });
    expect(tasks.length).toBe(5);
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBe("http_502");
  });

  it("连接拒绝（服务不在）→ network 降级，用户无感", async () => {
    process.env.AGENT_MODE = "auto";
    process.env.AGENT_CORE_URL = "http://127.0.0.1:9"; // 不可达端口
    const tasks = await agentPlanGoal({ title: "x" });
    expect(tasks.length).toBe(5);
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBe("network");
  });

  it("python 模式下同样故障不降级，直接抛错", async () => {
    process.env.AGENT_MODE = "python";
    process.env.AGENT_CORE_URL = "http://127.0.0.1:9";
    await expect(agentPlanGoal({ title: "x" })).rejects.toThrow(/Agent 服务不可用/);
    expect(recentAgentCalls().at(-1)!.provider).toBe("python");
  });
});

describe("local 模式（默认）完全不触网", () => {
  it("AGENT_MODE=local 直接走本地 mock", async () => {
    process.env.AGENT_MODE = "local";
    process.env.AGENT_CORE_URL = "http://127.0.0.1:9"; // 即使配置了坏地址也不影响
    handler = () => {
      throw new Error("stub 不应被调用");
    };
    const tasks = await agentPlanGoal({ title: "x" });
    expect(tasks.length).toBe(5);
    expect(recentAgentCalls().at(-1)!.provider).toBe("local");
    expect(recentAgentCalls().at(-1)!.fallbackReason).toBeUndefined();
  });
});
