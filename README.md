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
npm run test           # vitest，19 个用例
npm run build          # 生产构建验证
```

## 架构

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。核心闭环：目标输入 → AI 拆解（`src/lib/llm`）→ Prisma 入库 → 看板 → 状态更新 → AI Replan（保留已完成任务、按剩余天数重排）。AI 能力全部收敛在 `src/lib/llm/`，Phase 3 替换为 FastAPI Agent Core 调用时，路由与 UI 不变。

## 迁移到 Supabase/PostgreSQL

Schema 未使用 SQLite 专有特性：改 `prisma/schema.prisma` 的 `datasource.provider` 为 `"postgresql"`、设置 `DATABASE_URL`，执行 `prisma db push` 即可。
