# PlanShift — Phase 1 MVP 架构设计

## 1. 目标与范围

Phase 1 只做一个真正可运行的核心闭环：

```
用户输入目标 → AI 拆解任务 → 写入数据库 → 看板展示 → 用户更新任务状态 → AI 根据剩余时间与完成情况 Replan
```

明确不做（留给 Phase 2-4）：日历、任务依赖图、时间预算、计划版本树、Python/FastAPI/LangGraph、RAG、多 Agent、复杂 Memory。

## 2. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | Next.js 15 (App Router) + TypeScript + Tailwind + shadcn/ui | 单体仓库，前后端同仓 |
| API | Next.js Route Handlers (`app/api/*`) | 薄控制器，只做参数校验 + 调 service |
| 数据 | Prisma ORM + SQLite（开发）/ PostgreSQL·Supabase（生产） | Schema 按 PG 兼容设计：枚举用 String + 应用层校验，id 用 cuid |
| LLM | OpenAI 兼容 Chat Completions（`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`） | 无 Key 时自动降级为确定性 mock，保证闭环可跑 |

### 为什么 SQLite 起步
本机无 Docker/PostgreSQL。Prisma Schema 中不使用 PG 专有特性（enum/数组/json 仅用 String/JSON 字符串），切换 Supabase 只需改 `DATABASE_URL` 和 provider。

## 3. 目录结构（模块化，为 Agent Core 预留）

```
planshift/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── page.tsx            # 主页：目标输入 + 看板
│   │   └── api/
│   │       ├── goals/route.ts            # POST 创建目标(触发AI拆解) / GET 列表
│   │       ├── goals/[id]/route.ts       # GET 目标详情 / DELETE
│   │       ├── tasks/[id]/route.ts       # PATCH 更新任务状态
│   │       └── goals/[id]/replan/route.ts# POST 触发 Replan
│   ├── components/             # UI 组件（看板列、任务卡、目标表单）
│   ├── lib/
│   │   ├── db.ts               # Prisma 单例
│   │   ├── llm/
│   │   │   ├── client.ts       # LLM 客户端封装（OpenAI 兼容）
│   │   │   ├── planner.ts      # 拆解目标 → 任务列表（结构化 JSON 输出）
│   │   │   ├── replanner.ts    # 依据剩余时间/完成度生成新计划
│   │   │   └── mock.ts         # 确定性 mock 实现（无 Key 降级）
│   │   └── types.ts            # 领域类型（TaskStatus 等）
│   └── tests/                  # 单元测试(vitest)
├── prisma/schema.prisma
└── docs/ARCHITECTURE.md
```

### 为 Phase 3 预留的接缝
- **所有 AI 能力收敛在 `src/lib/llm/`**，接口签名：
  - `planGoal(input: PlanGoalInput): Promise<PlannedTask[]>`
  - `replanGoal(input: ReplanInput): Promise<ReplanResult>`
- 前端和 API 路由只依赖这两个函数，不感知是本地 LLM 调用还是远程 Agent Core。Phase 3 时把实现替换为 FastAPI 的 HTTP 调用即可，路由与 UI 不动。
- API 返回统一 JSON envelope：`{ ok: true, data } | { ok: false, error }`。

## 4. 数据库 Schema

两个表，够 MVP 用；`Plan.revision` 为 Phase 2 计划版本预留（先只递增，不做树）。

```prisma
model Goal {
  id          String   @id @default(cuid())
  title       String
  description String?
  deadline    DateTime?
  status      String   @default("active")   // active | achieved | archived
  revision    Int      @default(1)          // replan 次数
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  tasks       Task[]
}

model Task {
  id          String   @id @default(cuid())
  goalId      String
  goal        Goal     @relation(fields: [goalId], references: [id], onDelete: Cascade)
  title       String
  notes       String?
  status      String   @default("todo")     // todo | in_progress | done
  priority    Int      @default(2)          // 1 高 2 中 3 低
  estMinutes  Int      @default(60)
  order       Int      @default(0)          // 看板内排序
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

Replan 策略（MVP）：保留 `done` 任务不动，未完成任务交给 LLM 重新拆解/排序/调整估时（考虑 deadline 剩余天数），删除旧的未完成任务、写入新任务，`Goal.revision += 1`。

## 5. 核心流程

1. **创建目标**：`POST /api/goals {title, description?, deadline?}` → 调 `planGoal` → 事务写入 Goal + Tasks → 返回完整目标。
2. **看板**：`GET /api/goals` → 按 todo / in_progress / done 三列展示，任务卡可点击切换状态（`PATCH /api/tasks/:id`）。
3. **Replan**：`POST /api/goals/:id/replan` → 读取目标 + 任务完成情况 + 剩余天数 → 调 `replanGoal` → 事务更新任务 → 返回新计划；前端弹层展示「计划已更新（v2）」。

## 6. 测试策略

- vitest 单测：llm/mock（确定性输出）、replan 数据逻辑。
- API 集成测试：直接调用 route handler（Prisma 指向测试用 SQLite 文件）。
- 交付前 `npm run build` + 全部测试通过。
