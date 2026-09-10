/**
 * PlanShift Agent 一键启动（跨平台）：
 *   - LLM：.env 的 LLM_BASE_URL/LLM_MODEL/LLM_TIMEOUT_S；LLM_API_KEY 优先取系统环境变量
 *     DEEPSEEK_API_KEY（用户已配置），避免密钥写入文件
 *   - Google Calendar：agent/google-credentials.json 存在则自动启用（token/凭据均 gitignored）
 *   - 用法：npm run agent:full
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const env = { ...process.env };

for (const line of readFileSync(resolve(root, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (!m) continue;
  const [, k, v] = m;
  if (["LLM_BASE_URL", "LLM_MODEL", "LLM_TIMEOUT_S"].includes(k) && v.trim()) env[k] = v.trim();
}
if (!env.LLM_API_KEY && env.DEEPSEEK_API_KEY) env.LLM_API_KEY = env.DEEPSEEK_API_KEY;

if (existsSync(resolve(root, "agent/google-credentials.json"))) {
  env.CALENDAR_PROVIDER = "google";
  env.GOOGLE_CREDENTIALS_FILE = "google-credentials.json";
  env.GOOGLE_TOKEN_FILE = ".google-token.json";
  env.LIFEOS_TRACE_PATH = "logs/agent-trace.jsonl";
  console.log("[info] Google Calendar enabled");
} else {
  console.log("[info] Google credentials not found - calendar tool disabled (ICS 可配 CAL_ICS_PATH)");
}
if (!env.LLM_API_KEY) console.log("[warn] DEEPSEEK_API_KEY 未配置 - Agent 将以 Mock 模式运行");

console.log(`[info] LLM ${env.LLM_BASE_URL ?? "<unset>"} · ${env.LLM_MODEL ?? "<unset>"} · key ${env.LLM_API_KEY ? "set" : "unset"}`);
console.log("[info] Agent Core starting at http://127.0.0.1:8000");

const py = resolve(root, process.platform === "win32" ? "agent/.venv/Scripts/python.exe" : "agent/.venv/bin/python");
const child = spawn(py, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], {
  cwd: resolve(root, "agent"),
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
