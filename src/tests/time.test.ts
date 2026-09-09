/**
 * Phase 7.5：共享时间向量（TS 侧）—— Instant→墙钟显示与 Python canonical 转换互逆。
 * TS 不做 wall→Instant（唯一实现在 Python）；本套件断言显示方向与存储往返。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { instantRoundtrip, wallInZone } from "@/lib/time";

const vectors = JSON.parse(
  readFileSync(path.resolve(process.cwd(), "docs/timezone-vectors.json"), "utf8"),
) as {
  specVersion: string;
  cases: {
    name: string;
    tz: string;
    expectInstant: string;
    expectRoundtripWall: string;
  }[];
};

describe("共享时间向量（TS 显示/存储互逆）", () => {
  it("specVersion 固定", () => {
    expect(vectors.specVersion).toBe("1");
  });

  for (const c of vectors.cases) {
    it(c.name, () => {
      const instant = c.expectInstant.replace("+00:00", "Z");
      // Instant → 墙钟（显示方向）与 Python 的 canonical 期望一致
      expect(wallInZone(instant, c.tz), c.name).toBe(c.expectRoundtripWall);
      // Instant 存储/传输往返不漂移（毫秒精度归一后比较）
      expect(instantRoundtrip(instant).replace(".000Z", "Z"), c.name).toBe(instant);
    });
  }
});
