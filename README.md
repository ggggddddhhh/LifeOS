# LifeOS

AI 目标拆解与看板管理系统。Phase 1 MVP。

## 快速开始

```bash
npm install
npm run db:push      # 初始化 SQLite 开发库
npm run dev          # http://localhost:3000
```

无 `LLM_API_KEY` 时自动使用内置 mock（确定性拆解/重排），闭环完整可跑。接入真实 LLM：在 `.env` 配置

```
LLM_BASE_URL=https://api.openai.com/v1   # 任意 OpenAI 兼容端点
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

## 测试

```bash
npm run db:push:test   # 初始化测试库（首次）
npm run test           # vitest 单元/集成测试，21 个用例
npm run test:eval      # 真实 LLM 质量评测（需 DEEPSEEK_API_KEY，详见 docs/eval/）
npm run build          # 生产构建验证
```

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。核心闭环：目标输入 → AI 拆解（`src/lib/llm`）→ Prisma 入库 → 看板 → 状态更新 → AI Replan（保留已完成任务、按剩余天数重排）。AI 能力全部收敛在 `src/lib/llm/`，Phase 3 替换为 FastAPI Agent Core 调用时，路由与 UI 不变。

## Python Agent Core（Phase 3）

LLM planning 能力已渐进迁移至 FastAPI + LangGraph 服务（`agent/`，M1 起可用）。Next.js 通过统一 Agent Client（`src/lib/agent/client.ts`）调用：

```
AGENT_MODE=local   # 默认：只走 TS 本地路径（src/lib/llm/，含 mock），行为与迁移前一致
AGENT_MODE=python  # 只走 Python Agent，失败直接报错（评测用）
AGENT_MODE=auto    # Python 优先；不可达/超时/5xx/非法JSON/schema不匹配/版本不一致 → 降级 local
AGENT_CORE_URL=http://127.0.0.1:8000
AGENT_TIMEOUT_MS=30000
```

启动 Python Agent：`cd agent && .venv/Scripts/python -m uvicorn app.main:app --port 8000`（无 Key 自动 MockLLM）。Python 不访问数据库；持久化与硬校验（`plan.ts`）全部留在 Next.js。

## 迁移到 Supabase/PostgreSQL

Schema 未使用 SQLite 专有特性：改 `prisma/schema.prisma` 的 `datasource.provider` 为 `"postgresql"`、设置 `DATABASE_URL`，执行 `prisma db push` 即可。
