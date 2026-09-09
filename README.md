# LifeOS

AI 目标拆解与看板管理系统：把一个目标拆成可执行的计划，接入真实工具观察进度，
在现实变化中持续重排——但**写操作永远需要人确认**。

```
用户目标 → LLM 拆解 → 确定性约束收敛 → 看板
                ↓
     GitHub（只读进度） + Google Calendar（只读容量）
                ↓
     偏差判断 → 新计划（diff） → 日历草稿 → 用户确认 → 幂等写入 → Verify
```

## 核心设计原则

- **Agent 不直接写**：任何写日历的操作都走 Draft → 用户确认 → Execute → Verify，
  "Agent 自己决定后直接写入"被架构性禁止（Phase 7 起多阶段验证）
- **幂等 CREATE**：DB 唯一键 + provider 私有属性 pre-check + 超时回查三层防重，
  真实故障注入（超时实际成功/重复确认/进程重启）下零重复写入（Phase 9 验证）
- **用户事件优先**：排期避开既有事件；确认前 stale check（Instant 比较），
  时段被占即拒写，绝不覆盖
- **三层事实语义**：用户声明 > 工具观察（GitHub/Calendar）> Agent 推断；
  冲突显式标注并降低置信度，不静默覆盖
- **确定性收敛**：LLM 提议、代码强制——依赖清洗/容量硬顶/任务数守卫在
  Python Finalize 与 TS 守卫双侧共享测试向量（`docs/constraints-vectors.json`），
  双语言漂移零容忍
- **Instant 全链路**：内部时间只有 UTC Instant + IANA 时区，墙钟换算单点收口，
  DST ambiguous/nonexistent 不静默猜测（Phase 7.5）
- **Token 红线**：access/refresh/secret 永不进入 prompt、日志、trace 或错误响应；
  生产 token 存储 OS 凭据管理器，明文存储拒绝启动（Phase 8.5）

## 技术栈

| 层 | 技术 |
|---|---|
| Web / API / 持久化 | Next.js 16 (App Router) · TypeScript · Tailwind 4 · shadcn/ui · Prisma 6 · SQLite（PG 兼容设计） |
| Agent Core | Python 3.12 · FastAPI · LangGraph · Pydantic（无数据库、无状态） |
| 工具 | GitHub 只读（issues/PRs/CI/commits + 匹配置信度）· Google Calendar（OAuth + PKCE + state，仅 CREATE） |
| 观测 | 双侧结构化 trace（JSONL，runId 跨服务贯穿，secret 脱敏）+ 一键可靠性 audit |

## 快速开始

```bash
npm install
npm run db:push          # 初始化 SQLite 开发库
npm run agent            # 终端 1：FastAPI Agent Core（:8000，无 Key 自动 MockLLM）
npm run dev              # 终端 2：Next.js（:3000）
```

启动顺序不强制：默认 `AGENT_MODE=auto`——Python 优先，不可达/超时/5xx/契约不匹配自动
降级 TS 本地路径；Python 恢复后无需重启 Next.js。

```
AGENT_MODE=auto    # 默认：Python 优先 + TS local 兜底
AGENT_MODE=local   # 只走 TS 本地（src/lib/llm/，含 mock），排障用
AGENT_MODE=python  # 只走 Python，失败直接报错（评测用）
```

### 可选接入

- **真实 LLM**：`agent/.env` 设 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`（任意 OpenAI 兼容端点）
- **真实 Google Calendar**：Google Cloud Console 建 Desktop OAuth 客户端 →
  `agent/google-credentials.json` → `CALENDAR_PROVIDER=google` → 首次运行
  `agent/smoke_google.py` 完成授权（state + PKCE 一次性会话）。默认本地 ICS
  （`CAL_ICS_PATH`）零配置可用
- **GitHub 进度**：目标描述含 `repo:owner/name` 即触发只读工具；匿名可用（低配额），
  `GITHUB_TOKEN` 提升配额

## 测试与验证

```bash
npm run test                                     # vitest 87
cd agent && .venv/Scripts/python -m pytest       # pytest 170
agent/.venv/Scripts/python ../scripts/reliability-audit.py   # DB↔Google 对账 + 五指标判定
```

每个阶段都有真实环境评测报告（`docs/eval/`），包括真实 Google 账号的
授权/写入/幂等/断开/重连全链路、22 类故障注入矩阵、以及多轮真实长跑
（v1→v2→v3 生命周期 + 进程重启 + token 失效恢复）的可靠性审计。

## 文档索引

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 总体架构
- `docs/PHASE*-DESIGN.md` — 各阶段设计（Phase 1 核心闭环 → Phase 9.5 可观测性）
- `docs/eval/EVAL-*.md` — 各阶段评测报告

## 迁移到 Supabase/PostgreSQL

Schema 未使用 SQLite 专有特性：改 `prisma/schema.prisma` 的 `datasource.provider`
为 `"postgresql"`、设置 `DATABASE_URL`，执行 `prisma db push` 即可。

## License

MIT
