# LifeOS

AI 目标拆解与看板管理系统。Phase 1 MVP。

## 快速开始

```bash
npm install
npm run db:push      # 初始化 SQLite 开发库

# 方式一（推荐，auto 模式）：先启动 Python Agent，再启动 Next.js
npm run agent         # 终端 1：FastAPI Agent Core（:8000，无 Key 自动 MockLLM）
npm run dev           # 终端 2：Next.js（:3000）

# 方式二（纯前端开发）：不启动 Python 也可以
npm run dev           # auto 模式会自动降级到 TS 本地路径（无 Key 为 mock）
```

接入真实 LLM：在 `agent/` 下配置 `agent/.env`（或在启动命令前加环境变量）

```
LLM_BASE_URL=https://api.deepseek.com   # 任意 OpenAI 兼容端点
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-chat
```

**启动顺序**：先 `npm run agent` 再 `npm run dev`（顺序不强制——auto 模式下 Python 未就绪会自动降级 local，Python 恢复后无需重启 Next.js）。

## 测试

```bash
npm run db:push:test   # 初始化测试库（首次）
npm run test           # vitest 单元/集成测试，21 个用例
npm run test:eval      # 真实 LLM 质量评测（需 DEEPSEEK_API_KEY，详见 docs/eval/）
npm run build          # 生产构建验证
```

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。核心闭环：目标输入 → AI 拆解（`src/lib/llm`）→ Prisma 入库 → 看板 → 状态更新 → AI Replan（保留已完成任务、按剩余天数重排）。AI 能力全部收敛在 `src/lib/llm/`，Phase 3 替换为 FastAPI Agent Core 调用时，路由与 UI 不变。

## Python Agent Core（Phase 3 · M4 起默认主路径）

LLM planning 能力已迁移至 FastAPI + LangGraph 服务（`agent/`）。Next.js 通过统一 Agent Client（`src/lib/agent/client.ts`）调用，**默认 `AGENT_MODE=auto`**：

```
AGENT_MODE=auto    # 默认：Python 优先；不可达/超时/5xx/非法JSON/schema不匹配/版本不一致 → 自动降级 TS local
AGENT_MODE=local   # 只走 TS 本地路径（src/lib/llm/，含 mock），排障用
AGENT_MODE=python  # 只走 Python Agent，失败直接报错（评测用）
AGENT_CORE_URL=http://127.0.0.1:8000
AGENT_TIMEOUT_MS=30000
```

降级原因记录在服务端日志（`[agent] <op> fallback(<reason>): <detail>`）与进程内遥测 `recentAgentCalls()`（provider / latency / fallbackReason / promptVersion）。Python 不访问数据库；持久化与硬校验（`plan.ts`）全部留在 Next.js。`src/lib/llm/` 保留为 fallback 路径，不删除。

## 迁移到 Supabase/PostgreSQL

Schema 未使用 SQLite 专有特性：改 `prisma/schema.prisma` 的 `datasource.provider` 为 `"postgresql"`、设置 `DATABASE_URL`，执行 `prisma db push` 即可。
