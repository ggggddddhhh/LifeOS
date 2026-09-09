/**
 * Calendar 写入闭环 TS 客户端（Phase 7）。
 * 铁律：写路径没有 fallback——Python 不可达就报错，绝不本地代写、绝不绕过确认。
 */
import type { CalendarDraftItem } from "@/lib/types";

export interface DraftBuildResult {
  drafts: CalendarDraftItem[];
  unplacedTaskIds: string[];
}

export interface ExecuteResultItem {
  idempotencyKey: string;
  status: "success" | "duplicate_skipped" | "stale_conflict" | "failed";
  externalEventId?: string | null;
  verify?: { found: boolean; startOk: boolean; endOk: boolean; unique: boolean } | null;
  error?: string | null;
}

function baseUrl(): string {
  return (process.env.AGENT_CORE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const timeoutMs = Number(process.env.AGENT_TIMEOUT_MS ?? 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Agent Calendar ${res.status}: ${errBody.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new Error(
      aborted ? `Agent Calendar 请求超时（${timeoutMs}ms）` : `Agent Calendar 不可用: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Draft Builder：只读排期，永不写。 */
export async function buildCalendarDrafts(req: {
  goalId: string;
  planVersion: number;
  daysLeft: number;
  tasks: { taskId: string; title: string; estMinutes: number; priority: number; status?: string; durationDays?: number | null }[];
}): Promise<DraftBuildResult> {
  return post<DraftBuildResult>("/v1/calendar/drafts", req);
}

/** 执行已确认草稿（仅由 confirm 路由调用）。 */
export async function executeCalendarDrafts(req: {
  goalId: string;
  planVersion: number;
  drafts: CalendarDraftItem[];
  tasks: { taskId: string; estMinutes: number }[];
}): Promise<{ results: ExecuteResultItem[]; provider: string }> {
  return post("/v1/calendar/execute", req);
}
