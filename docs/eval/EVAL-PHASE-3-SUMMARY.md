# Phase 3 总结报告 — Python Agent Core 迁移收口（M4）

- 日期：2026-09-09 · 里程碑：M1（服务）→ M2（接入+降级链）→ M3（双路径评测）→ M4（默认切换 auto）
- 设计：[PHASE3-DESIGN.md](../PHASE3-DESIGN.md) · 评测：[EVAL-PHASE-3-M3.md](EVAL-PHASE-3-M3.md)

## 1. M4 变更清单

| 项 | 内容 |
|---|---|
| 默认模式 | `.env` / `.env.example` 默认 `AGENT_MODE=auto`（Python 主路径，故障自动降级 local） |
| 启动 | 新增 `npm run agent`（拉起 FastAPI :8000）；README 明确"先 agent 后 dev，顺序不强制" |
| 可观测性 | 遥测 `recentAgentCalls()` 增加 `promptVersion`；降级日志含 provider/latency/fallbackReason |
| 保留 | `src/lib/llm/` 完整保留为 fallback；`plan.ts` 硬约束零改动；极简输出仅监控不拦截 |
| 冒烟 | 5 项全过：auto+Python 正常（真实 LLM 6 任务、零降级日志）/ 关闭（network）/ 5xx（http_502）/ 版本不匹配（version_mismatch）/ schema 不匹配（schema_mismatch），全部正确降级且用户无感 |

## 2. 全量验证（M4 门禁）

| 套件 | 结果 |
|---|---|
| npm test（单元+集成+契约） | 53/53 |
| pytest（Python 单测/契约/降级） | 39/39 |
| npm run build | 通过 |
| Phase 2 eval（真实 LLM，40 用例） | 40/40 |
| M3 双路径复跑（各 1 轮，19 场景/路径） | local 19/19、python 19/19；python 极简输出 1 例（与 M3 统计一致，持续监控） |

## 3. 四个问题的回答

### 3.1 是否正式完成 Python Agent Core 迁移？
**是。** Planner/Replanner 的 LLM 编排默认走 Python（auto 主路径），TS 侧只保留统一 Agent Client + 确定性产品校验（`plan.ts`）+ local fallback。M3 双路径评测证明质量/稳定性/延迟全面持平，M4 冒烟证明降级链覆盖全部故障形态。`src/lib/llm/` 按设计保留为兜底（删除是未来的独立决策，非本轮范围）。

### 3.2 当前 LangGraph 实际承担了什么职责？
- **Analyze**：确定性前置分析（daysLeft、未完成统计、容量、超载判定），注入 prompt——这是 python 路径 reason 质量优势的直接来源（能引用"原计划 2820 分钟 vs 容量 960"）。
- **Plan/Replan**：LLM 调用（prompt v2，与 TS 同源）。
- **Validate**：结构化校验 + 带反馈的重试一次（安全网，本轮评测未触发）+ 死循环免疫（attempts 门控）。
- **Finalize**：契约出口规范化（camelCase 严格字段）。
未承担（按范围约束）：RAG、Memory、多 Agent、Tools、Web Search——这些是 Phase 4 的扩展点，节点化图结构已为此预留。

### 3.3 fallback 是否足够可靠？
**可靠。** 证据链：M2 单测覆盖 7 种故障原因（network/timeout/5xx/bad_json/schema_mismatch/version_mismatch/empty_reason）；M2 真实冒烟 4 场景 + M4 真实冒烟 5 场景全部正确降级、用户无感、原因可观测（服务端日志 + 遥测）。降级决策在 TS 侧本地完成（不依赖 Python 自报状态），Python 整个进程消失也能在连接拒绝的毫秒级触发。残余风险：local fallback 依赖同机资源，若 LLM Key 无效则两侧都是 mock 质量——这是"无 Key 可运行"设计的预期行为，已在 README 说明。

### 3.4 Phase 4 最值得做的第一个 Agent Tool 是什么？
**GitHub 工具（读取仓库/Issue/PR/CI 状态）**。理由：
1. **数据结构最成熟**：REST API 稳定、`gh` CLI 可参考、返回结构化程度高——工具输出 → Agent 解析的可靠性最高，适合做第一个工具打通 `Tools` 节点模式（graph 从 4 节点扩展为带工具环的形态）。
2. **与现有领域模型天然衔接**：LifeOS 的目标大量是"交付型项目"（MVP 上线、CI/CD 搭建——评测集 10 个目标里 4 个适用），GitHub 的 issue/PR 状态可以直接映射为任务真实进度，替代用户手工点"完成"，让"主动获取执行进度"（Phase 4 路线图第 3 步）第一次有真实数据源。
3. **风险最低**：只读工具（list issues/check CI status）无副作用，不需要先解决写操作的确认机制；Email/Calendar 涉及 OAuth 与写操作，适合排在后面。

## 4. 交接状态

- 默认配置：`AGENT_MODE=auto`；开发方式：`npm run agent` + `npm run dev`
- 已知迁移差异（保留不强行对齐）：python prompt 注入 analysis；极简输出监控口径见 M3 报告 §3
- 监控建议：换模型或改 prompt 后跑 `npm run test:m3`（双路径）；月度复跑观察极简输出率
