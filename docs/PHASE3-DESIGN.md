# Phase 3 设计 — Python Agent Core 拆分（迁移边界 + 目录架构）

状态：设计定稿，未实施。实施按 M1→M4 渐进推进（见 §6）。

## 1. 迁移边界审计

### 1.1 现有逻辑盘点

| 模块 | 内容 | 性质 | 判定 |
|---|---|---|---|
| `llm/index.ts` OpenAiCompatClient | OpenAI 兼容 HTTP 调用 | LLM 接入 | **迁 Python** |
| `llm/index.ts` PLANNER/REPLANNER prompt | 提示词工程 | LLM 编排 | **迁 Python**（迁移期 TS 留副本作回滚） |
| `llm/index.ts` planGoal/replanGoal | 编排入口（选客户端→调用→解析） | LLM 编排 | **迁 Python**（graph 节点化） |
| `llm/parse.ts` extractJson | LLM 文本输出的 JSON 提取 | LLM I/O 解析 | **迁 Python**（Validate 节点内） |
| `llm/parse.ts` normalizePlannedTasks | 结构校验/去重/字段规范化 | LLM I/O 解析 | **双写**：Python Validate 节点做一份；TS 对远端响应**再跑一遍**（契约防线，不信任外部服务） |
| `llm/index.ts` MockLlmClient | 无 Key 确定性降级 | LLM 接入 | **双写**：Python 侧 MockLLM 镜像实现；TS 侧保留（见 §5 降级链） |
| `plan.ts` sanitizeDependencies | 去自引用/未知引用/环 | 确定性产品校验 | **留 TS**（唯一权威） |
| `plan.ts` sanitizeSchedule | 日期钳制/依赖顺序 | 确定性产品校验 | **留 TS** |
| `plan.ts` enforceTaskBudget / enforceTimeBudget | 反扩散/容量硬保证 | 确定性产品校验 | **留 TS** |
| `plan.ts` computePlanDiff / budgetMinutes | 版本 diff/预算 | 确定性业务逻辑 | **留 TS** |
| API 路由 + Prisma | 持久化、事务、版本落库 | 业务层 | **留 TS**（Python 不碰数据库，要求 #6） |

### 1.2 边界原则

1. **LLM 相关的"软"逻辑**（prompt、解析、重试编排）→ Python：这正是未来 Phase 4 Agent（工具调用、主动感知）要生长的地方。
2. **产品不变量的"硬"逻辑**（sanitize/guard/diff）→ 留 TS：已有 40 个单测锁定行为；数据库写入前的最后防线必须在持久化层同进程；Python Validate 只做 LLM 自检（结构合法、可重试），不做产品语义裁决。
3. **持久化只在 Next.js**：Python 是无状态纯函数服务（请求进 → 计划出），随时可重启/水平扩展/整体摘除。

## 2. 目标架构

```
┌─────────────────────────────────────────────────────────┐
│ Next.js（现有，保留）                                     │
│  UI → app/api/* → 持久化(Prisma) + plan.ts 硬校验        │
│              │                                          │
│              ▼                                          │
│  src/lib/agent/client.ts   ← 新增：Agent Client（薄）     │
│    AGENT_MODE=local │ auto │ python                     │
│      local:  src/lib/llm/（现路径，回滚保障）              │
│      auto:   Python 优先，失败/超时 → local 降级          │
└──────────────┬──────────────────────────────────────────┘
               │ HTTP（无 DB 访问）
               ▼
┌─────────────────────────────────────────────────────────┐
│ FastAPI Agent Core（新增，agent/ 目录）                   │
│  POST /plan  POST /replan  GET /health                  │
│  LangGraph: Analyze → Plan/Replan → Validate → Finalize │
│               └─ 失败重试 1 次（带错误反馈）→ 仍败则 502   │
└──────────────┬──────────────────────────────────────────┘
               ▼
          LLM API（DeepSeek/OpenAI 兼容；无 Key → MockLLM）
```

## 3. 目录架构

```
LifeOS/
├── src/                            # TypeScript（现有 + 微调）
│   └── lib/
│       ├── agent/
│       │   └── client.ts           # 新增：agentPlanGoal / agentReplanGoal（模式开关+超时+降级+契约复验）
│       ├── llm/                    # 保留：local 路径（prompt+client+mock），回滚与最终兜底
│       └── plan.ts                 # 保留不动：sanitize/guard/diff（唯一权威）
└── agent/                          # 新增：Python Agent Core
    ├── pyproject.toml              # fastapi / uvicorn / langgraph / pydantic / httpx / pytest
    ├── .env.example                # LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / PORT
    ├── app/
    │   ├── main.py                 # FastAPI 装配 + 路由 + 全局异常 → 502 {detail}
    │   ├── schemas.py              # pydantic 契约（与 TS PlannedTask 字段一一对应，camelCase）
    │   ├── graph.py                # LangGraph StateGraph 装配（analyze→plan|replan→validate→finalize）
    │   ├── nodes.py                # 节点实现（纯函数，依赖注入 LLM）
    │   ├── llm.py                  # OpenAI 兼容客户端 + MockLLM（确定性，镜像 TS mock 行为）
    │   └── prompts.py              # 从 TS 逐字移植的 prompt（标注 PROMPT_VERSION 保持两侧同步）
    └── tests/
        ├── test_nodes.py           # 单测：analyze 统计、validate 各失败分支、finalize 组装
        ├── test_api.py             # 契约：TestClient 打 /plan /replan /health，断言 schema 与 camelCase
        ├── test_mock.py            # MockLLM 确定性、无 Key 模式
        └── test_resilience.py      # LLM 返回垃圾 JSON / 截断 / 500 → 重试一次 → 502
```

## 4. API 契约（与 TS `PlannedTask` 严格对齐）

```
POST /plan
  req : { "title": str, "description"?: str, "deadline"?: ISO-8601 }
  res : { "tasks": [ { "title": str, "notes"?: str, "priority": 1|2|3,
            "estMinutes": int, "durationDays"?: int,
            "startDate"?: "YYYY-MM-DD", "dueDate"?: "YYYY-MM-DD",
            "dependsOn"?: [str] } ] }

POST /replan
  req : { "goalTitle": str, "goalDescription"?: str, "deadline"?: ISO-8601,
          "daysLeft": int,
          "tasks": [ { "title", "status": todo|in_progress|done,
                       "estMinutes", "priority", "dueDate"? } ] }
  res : { "reason": str, "tasks": [同上] }

GET /health → { "ok": true, "model": str, "mode": "llm"|"mock" }

错误：LLM 不可用/两次解析失败 → 502 {"detail": "..."}（TS 侧收到即降级）
```

TS 侧收到响应后**必须**再过一遍 `normalizePlannedTasks`（契约复验）才交给路由——不信任外部服务的结构。

## 5. LangGraph 第一版（要求 #3）

State（TypedDict）：

```python
class AgentState(TypedDict):
    kind: Literal["plan", "replan"]
    request: dict            # 原始请求
    analysis: dict           # analyze 产出：daysLeft / open_count / done_count / total_min / overload
    raw_output: str          # LLM 裸输出
    tasks: list[dict]        # 解析后任务
    reason: str
    attempts: int            # validate 已尝试次数（上限 2）
    error: str | None
```

节点：

| 节点 | 职责 | 确定性 |
|---|---|---|
| **Analyze** | 由请求算 daysLeft、未完成统计、总估时、是否过载；组装进 prompt 上下文 | ✅ 纯计算 |
| **Plan / Replan** | 调 LLM（prompt 含 Analyze 结果；replan 分支注入现有任务与容量约束） | LLM |
| **Validate** | extract JSON → pydantic 校验 → 结构检查（数量 3-8、est 10-600、priority、去重、依赖引用、日期格式）；失败且 attempts<2 → 带 error 反馈重试 LLM | ✅ |
| **Finalize** | 输出规范化响应（mirror TS normalizePlannedTasks 语义：非法字段丢弃/回退默认） | ✅ |

明确不做（要求 #4）：RAG、多 Agent、长期 Memory、Web Search、工具调用节点。

### 降级链（要求 #5 保留 mock fallback）

```
AGENT_MODE=local  → 全走 TS（现状，含 TS mock）            ← 默认，M1/M2
AGENT_MODE=auto   → Python（无 Key 时 Python 内置 MockLLM）
                     ↘ Python 不可达/5xx/超时(AGET_TIMEOUT_MS,默认 30s)/契约复验失败
                        → 降级 TS local 路径（无 Key 时 TS mock）
AGENT_MODE=python → 只走 Python，失败直接报错（用于对比评测，暴露真实质量）
```

## 6. 渐进迁移与回滚（要求 #2）

| 里程碑 | 内容 | 回滚方式 | 验收 |
|---|---|---|---|
| **M1** | agent/ 服务 + graph + MockLLM；pytest 全绿；Next.js 零改动 | 删除 agent/ 目录 | pytest 单测/契约/降级 全过 |
| **M2** | TS 新增 `agent/client.ts`，路由改调 `agentPlanGoal/agentReplanGoal`；默认 `AGENT_MODE=local` 行为与现在完全一致；新增 `npm run test:contract`（需 Python 在线，离线自动 skip） | `AGENT_MODE=local`（env） | 40/40 单测不回退 + contract test 过 |
| **M3** | `AGENT_MODE=auto` 下跑双路径评测：`LLM_EVAL_TARGET=python|local npm run test:eval`，产出质量/延迟/稳定性对比 | 同上 | 对比报告（要求 #9） |
| **M4** | `.env` 默认 `auto`；`src/lib/llm/` 降级为兜底专用（不删除） | 同上 | 连续评测无回退 |

每步独立 commit。任何一步出问题，回滚 = 改一个环境变量，无需回退代码。

## 7. 测试计划（要求 #7 #8）

- **Python 单测**（pytest，不依赖真实 LLM）：节点纯函数、Validate 全部分支（垃圾 JSON/截断/字段类型混乱/重复/依赖悬空）、MockLLM 确定性、`/health`。
- **契约测试**：Python `test_api.py` 用 TestClient 断言自身 schema；TS `test:contract` 用真实 HTTP 打 FastAPI 断言字段名/类型与 `PlannedTask` 完全一致（两侧双向锁定）。
- **故障降级测试**：TS 侧——Python 端口不可达 → 降级 local；返回畸形 payload → 契约复验拦截 → 降级 local；超时 → 降级。Python 侧——LLM 500/垃圾输出 → 重试一次 → 502。
- **存量保障**：`npm test`（40/40）与 `npm run test:eval`（40/40）每个里程碑必须全绿；M3 起评测支持 `LLM_EVAL_TARGET` 双跑。

## 8. 迁移前后对比指标（要求 #9）

同一评测集（10 目标 + 9 replan 场景 + 边界组）分别以 `LLM_EVAL_TARGET=local|python` 各跑 ≥2 轮：

| 维度 | 指标 | 采集点 |
|---|---|---|
| 质量 | 结构断言通过率、周期语义正确数、diff 合理性、延期压缩比 | 评测报告 JSON |
| 延迟 | p50 / p95（ms/次），Python 内部分解为 analyze/LLM/validate | 两侧统一计时 |
| 稳定性 | 错误率、降级触发次数、重试触发次数 | agent/client.ts 日志 + Python /health 统计 |

结论写入 `docs/eval/EVAL-PHASE-3.md`，作为 M4 是否切默认的依据。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 双侧 prompt 漂移 | prompts.py 顶部标注 `PROMPT_VERSION`，TS/Python 同步修改；M4 后 TS prompt 仅存于兜底路径 |
| Python 进程管理（Windows 开发机） | `npm run agent`（npm scripts 拉起 uvicorn）；`AGENT_MODE` 缺省 local，不启动 Python 不影响开发 |
| LangGraph 版本变动 | pyproject 锁定版本；graph 仅用 StateGraph 基础能力，无高级特性依赖 |
| 评测成本翻倍 | 双跑仅在 M3/M4 执行；日常 CI 只跑 local + Python 单测 |
