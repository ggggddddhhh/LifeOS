import { execSync } from "node:child_process";

// Windows 兼容：为测试库 prisma/test.db 应用 schema
execSync('npx prisma db push --skip-generate', {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: "file:./test.db" },
});
