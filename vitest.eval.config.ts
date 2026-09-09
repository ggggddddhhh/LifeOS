import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Phase 1.5 真实 LLM 质量评测配置。
 * 仅在显式 `npm run test:eval` 时运行，不复用单元测试配置，
 * 避免真实 API 调用进入默认测试门禁。
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/tests/eval/**/*.eval.ts"],
    env: {
      DATABASE_URL: "file:./test.db",
      LLM_BASE_URL: process.env.LLM_EVAL_BASE_URL ?? "https://api.deepseek.com",
      LLM_API_KEY: process.env.LLM_EVAL_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
      LLM_MODEL: process.env.LLM_EVAL_MODEL ?? "deepseek-chat",
    },
    testTimeout: 240000,
    hookTimeout: 240000,
  },
});
