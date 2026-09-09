/** Phase 9：TS trace 脱敏与格式测试（红线：token/code/敏感内容不落盘）。 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceEvent } from "@/lib/trace";

function withTmpPath<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "trace-test-"));
  const prev = process.env.LIFEOS_TRACE_PATH;
  process.env.LIFEOS_TRACE_PATH = join(dir, "trace.jsonl");
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.LIFEOS_TRACE_PATH;
    else process.env.LIFEOS_TRACE_PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("traceEvent", () => {
  it("写 JSONL 且字段完整", () => {
    withTmpPath(() => {
      traceEvent("replan", { goalId: "g1", ok: true, tasksOut: 5, latencyMs: 120 });
      const row = JSON.parse(readFileSync(process.env.LIFEOS_TRACE_PATH!, "utf8"));
      expect(row.event).toBe("replan");
      expect(row.goalId).toBe("g1");
      expect(row.ok).toBe(true);
      expect(typeof row.ts).toBe("string");
    });
  });

  it("secret 模式全部 REDACT", () => {
    withTmpPath(() => {
      traceEvent("leak", { token: "ya29.a0ARr5M", secret: "GOCSPX-abc", refresh: "refresh-xyz", code: "4/0ATsMZq", header: "Bearer abc" });
      const line = readFileSync(process.env.LIFEOS_TRACE_PATH!, "utf8");
      expect(line).not.toContain("ya29");
      expect(line).not.toContain("GOCSPX");
      expect(line).not.toContain("4/0AT");
      expect(line).not.toContain("refresh-xyz");
      expect((line.match(/\[REDACTED\]/g) ?? []).length).toBe(5);
    });
  });

  it("长字符串截断（用户内容不留全量）", () => {
    withTmpPath(() => {
      traceEvent("big", { note: "x".repeat(300) });
      const row = JSON.parse(readFileSync(process.env.LIFEOS_TRACE_PATH!, "utf8"));
      expect(row.note.length).toBeLessThanOrEqual(81);
      expect(row.note.endsWith("…")).toBe(true);
    });
  });

  it("嵌套结构与未知类型", () => {
    withTmpPath(() => {
      traceEvent("n", { summary: { success: 1, failed: 0 }, codes: ["timeout"], fn: () => 1 });
      const row = JSON.parse(readFileSync(process.env.LIFEOS_TRACE_PATH!, "utf8"));
      expect(row.summary).toEqual({ success: 1, failed: 0 });
      expect(row.codes).toEqual(["timeout"]);
      expect(row.fn).toBe("<function>");
    });
  });
});
