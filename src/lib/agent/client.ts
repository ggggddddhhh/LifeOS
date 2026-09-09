/**
 * 统一 Agent Client（Phase 3 M2）。
 * API 路由只通过本模块获取 plan/replan，不感知 Python/local。
 *
 * 模式（AGENT_MODE，默认 local，行为与 M1 前完全一致）：
 * - local : 只走 TS 本地路径（src/lib/llm/，含 mock fallback）
 * - python: 只走 Python Agent Core，失败直接抛错（供评测暴露真实质量）
 * - auto  : 优先 Python，失败降级 local
 *
 * 降级安全网：Python 不可达 / 超时 / 非 2xx / 非法 JSON / schema 不匹配 /
 * prompt 版本不一致 → auto 模式降级 local 并记录原因（服务端日志+遥测，
 * 不向用户暴露内部错误）。
 */

import { planGoal as localPlanGoal, replanGoal as localReplanGoal } from "@/lib/llm";
import { normalizePlannedTasks } from "@/lib/llm/parse";
import type { FinalizeInfo, PlanGoalInput, PlannedTask, ReplanInput, ReplanResult } from "@/lib/types";

type AgentMode = "local" | "python" | "auto";

/** 必须与 agent/app/schemas.py 的 PROMPT_VERSION 一致 */
const EXPECTED_PROMPT_VERSION = "2";

export type FallbackReason =
  | "network"
  | "timeout"
  | `http_${number}`
  | "bad_json"
  | "schema_mismatch"
  | "version_mismatch"
  | "empty_reason"
  | "empty_tasks";

export interface AgentCallMeta {
  op: "plan" | "replan";
  provider: "python" | "local";
  fallbackReason?: FallbackReason;
  latencyMs: number;
  at: string; // ISO
  promptVersion?: string; // python 路径成功时的 x-prompt-version（观测用）
}

// 最近的调用遥测（环形，仅供测试观测与排障，不进用户响应）
const calls: AgentCallMeta[] = [];
export function recentAgentCalls(): readonly AgentCallMeta[] {
  return calls;
}

function getConfig() {
  const mode = (process.env.AGENT_MODE as AgentMode) || "local";
  const baseUrl = (process.env.AGENT_CORE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
  const timeoutMs = Number(process.env.AGENT_TIMEOUT_MS ?? 30_000);
  return { mode, baseUrl, timeoutMs };
}

function record(meta: AgentCallMeta) {
  calls.push(meta);
  if (calls.length > 100) calls.shift();
}

function logFallback(op: string, reason: FallbackReason, detail: string) {
  // 明确记录降级原因到服务端日志；detail 是内部信息，不进用户响应
  console.warn(`[agent] ${op} fallback(${reason}): ${detail}`);
}

class RemoteAgentError extends Error {
  constructor(public reason: FallbackReason, message: string) {
    super(message);
  }
}

/** 调 Python /v1/*：带超时与版本头校验，任何失败抛 RemoteAgentError */
async function callPython(
  op: "plan" | "replan",
  path: string,
  body: unknown,
): Promise<{ data: unknown; promptVersion: string }> {
  const { baseUrl, timeoutMs } = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new RemoteAgentError(
      aborted ? "timeout" : "network",
      aborted ? `Agent 请求超时（${timeoutMs}ms）` : `Agent 不可达: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Python 结构化错误体只用于日志，不透传给用户
    const errBody = await res.text().catch(() => "");
    throw new RemoteAgentError(`http_${res.status}` as FallbackReason, `Agent 返回 ${res.status}: ${errBody.slice(0, 200)}`);
  }

  const promptVersion = res.headers.get("x-prompt-version") ?? "";
  if (promptVersion !== EXPECTED_PROMPT_VERSION) {
    throw new RemoteAgentError("version_mismatch", `prompt 版本不一致：期望 ${EXPECTED_PROMPT_VERSION}，实际 ${promptVersion || "无"}`);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new RemoteAgentError("bad_json", "Agent 响应不是合法 JSON");
  }
  return { data, promptVersion };
}

/** 契约复验（要求 #1）：对 Python 响应再跑 TS 规范化，不通过视为 schema 不匹配 */
function validatePlanResponse(data: unknown): PlannedTask[] {
  if (typeof data !== "object" || data === null || !Array.isArray((data as { tasks?: unknown }).tasks)) {
    throw new RemoteAgentError("schema_mismatch", "Agent 响应缺少 tasks 数组");
  }
  const tasks = normalizePlannedTasks((data as { tasks: unknown[] }).tasks);
  if (tasks.length === 0) {
    throw new RemoteAgentError("empty_tasks", "Agent 返回任务为空");
  }
  return tasks;
}

function validateReplanResponse(data: unknown): ReplanResult {
  if (typeof data !== "object" || data === null) {
    throw new RemoteAgentError("schema_mismatch", "Agent 响应不是对象");
  }
  const r = data as { reason?: unknown; tasks?: unknown; capacityMinutes?: unknown; finalize?: unknown };
  if (typeof r.reason !== "string" || !r.reason.trim()) {
    throw new RemoteAgentError("empty_reason", "Agent 响应缺少 reason");
  }
  if (!Array.isArray(r.tasks)) {
    throw new RemoteAgentError("schema_mismatch", "Agent 响应缺少 tasks 数组");
  }
  const tasks = normalizePlannedTasks(r.tasks);
  if (tasks.length === 0) {
    throw new RemoteAgentError("empty_tasks", "Agent 返回任务为空");
  }
  let finalize: FinalizeInfo | null = null;
  if (r.finalize && typeof r.finalize === "object") {
    const f = r.finalize as Record<string, unknown>;
    if (typeof f.llmProposedMinutes === "number" && typeof f.finalizedMinutes === "number" && typeof f.finalizeAdjusted === "boolean") {
      finalize = {
        llmProposedMinutes: f.llmProposedMinutes,
        finalizedMinutes: f.finalizedMinutes,
        capacityMinutes: typeof f.capacityMinutes === "number" ? f.capacityMinutes : null,
        finalizeAdjusted: f.finalizeAdjusted,
        adjustments: Array.isArray(f.adjustments)
          ? f.adjustments
              .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
              .map((a) => ({ type: String(a.type ?? ""), detail: String(a.detail ?? "") }))
          : [],
      };
    }
  }
  return {
    reason: r.reason.trim(),
    tasks,
    // 0 是合法值（零容量 → 最小可行计划）；仅负数/缺失视为无覆写
    capacityMinutes: typeof r.capacityMinutes === "number" && r.capacityMinutes >= 0 ? r.capacityMinutes : null,
    finalize,
  };
}

async function withFallback<T>(
  op: "plan" | "replan",
  remote: () => Promise<{ value: T; promptVersion: string }>,
  local: () => Promise<T>,
): Promise<T> {
  const { mode } = getConfig();
  if (mode === "local") {
    const start = Date.now();
    const out = await local();
    record({ op, provider: "local", latencyMs: Date.now() - start, at: new Date().toISOString() });
    return out;
  }

  const start = Date.now();
  if (mode === "python") {
    try {
      const { value, promptVersion } = await remote();
      record({ op, provider: "python", latencyMs: Date.now() - start, at: new Date().toISOString(), promptVersion });
      return value;
    } catch (e) {
      record({
        op,
        provider: "python",
        fallbackReason: e instanceof RemoteAgentError ? e.reason : "network",
        latencyMs: Date.now() - start,
        at: new Date().toISOString(),
      });
      // python 模式不降级：让路由返回明确错误（供评测暴露真实质量）
      throw e instanceof RemoteAgentError ? new Error(`Agent 服务不可用（${e.reason}）`) : e;
    }
  }

  // auto：Python 优先，失败降级 local
  try {
    const { value, promptVersion } = await remote();
    record({ op, provider: "python", latencyMs: Date.now() - start, at: new Date().toISOString(), promptVersion });
    return value;
  } catch (e) {
    const reason = e instanceof RemoteAgentError ? e.reason : "network";
    logFallback(op, reason, e instanceof Error ? e.message : String(e));
    const localStart = Date.now();
    const out = await local();
    record({
      op,
      provider: "local",
      fallbackReason: reason,
      latencyMs: Date.now() - localStart,
      at: new Date().toISOString(),
    });
    return out;
  }
}

export async function agentPlanGoal(input: PlanGoalInput): Promise<PlannedTask[]> {
  return withFallback(
    "plan",
    async () => {
      const { data, promptVersion } = await callPython("plan", "/v1/plan", input);
      return { value: validatePlanResponse(data), promptVersion };
    },
    () => localPlanGoal(input),
  );
}

export async function agentReplanGoal(input: ReplanInput): Promise<ReplanResult> {
  return withFallback(
    "replan",
    async () => {
      const { data, promptVersion } = await callPython("replan", "/v1/replan", input);
      return { value: validateReplanResponse(data), promptVersion };
    },
    () => localReplanGoal(input),
  );
}
