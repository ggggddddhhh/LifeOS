import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    fileParallelism: false, // 多个文件共享测试数据库，必须串行
    env: {
      DATABASE_URL: "file:./test.db",
    },
  },
});
