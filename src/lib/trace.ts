/**
 * Phase 9：结构化运行 trace（JSONL）。
 *
 * 铁律：
 * - 只记录 id/计数/状态/错误码/延迟等运行事实；goal/任务标题等用户内容不进 trace
 * - 双保险脱敏：secret 模式替换 + 任意字符串截断（80 字符）
 * - 失败静默（trace 永不影响主流程）
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SECRET_MARKERS = ["ya29.", "GOCSPX-", "refresh-", "4/0A", "Bearer ", "client_secret"] as const;
const MAX_STR = 80;

type Scalar = string | number | boolean | null;

function redactStr(s: string): string {
  const low = s.toLowerCase();
  for (const marker of SECRET_MARKERS) {
    if (low.includes(marker.toLowerCase())) return "[REDACTED]";
  }
  return s.length <= MAX_STR ? s : s.slice(0, MAX_STR) + "…";
}

function sanitize(v: unknown): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return redactStr(v);
  if (Array.isArray(v)) return v.slice(0, 20).map(sanitize);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
      out[String(k).slice(0, 40)] = sanitize(val);
    }
    return out;
  }
  return `<${typeof v}>`;
}

export function traceEvent(event: string, fields: Record<string, unknown>): void {
  try {
    const path = resolve(process.env.LIFEOS_TRACE_PATH || "logs/web-trace.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const row: Record<string, unknown> = { ts: new Date().toISOString(), event: event.slice(0, 64) };
    for (const [k, v] of Object.entries(fields)) row[k] = sanitize(v);
    appendFileSync(path, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* trace 失败静默 */
  }
}
