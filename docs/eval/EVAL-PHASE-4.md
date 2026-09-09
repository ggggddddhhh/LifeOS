# Phase 4 验证报告 — GitHub 只读进度工具

- 日期：2026-09-09 · 设计：[PHASE4-DESIGN.md](../PHASE4-DESIGN.md)
- 验证：pytest 60/60（原 39 + 新增 21）、npm test 53/53、build 通过、真实闭环（stub GitHub + DeepSeek）、真实 GitHub API 冒烟

## 1. 实现摘要

- Graph：`Analyze → [github_tool → progress_analysis |（无仓库时跳过）] → Plan/Replan → Validate → Finalize`，无新增回边，LLM 调用上限不变（2）
- `agent/app/github.py`：只读 GET ×6 端点（repo/issues×2/pulls/actions/commits），httpx 超时 10s，`GITHUB_TOKEN` 可选，`GITHUB_API_BASE` 可指向 stub；与 Planner 解耦（独立模块+依赖注入），返回稳定 Pydantic Schema
- 三层语义分离：任务 status=用户声明；GithubFacts/observed_done=观察事实；ProgressReport.verdict/reasons 与 LLM 取舍=推断（Schema 中物理分区）
- 匹配机制：归一化精确 1.0 / 子串 0.75 / 词元 Jaccard ≥0.5；observed_done 仅认 ≥0.75；节点层 try/except 兜底，工具任何异常 → `ok=False` 事实对象，graph 永不因工具失败而失败
- TS 侧零改动（仓库地址由 Python 从 goalTitle/description 解析）；plan.ts 硬约束不感知 GitHub

## 2. 重点闭环验证（用户指定场景）

输入：`"7 天内完成这个 GitHub 项目的 MVP"`（描述含 repo URL）+ 6 个任务；GitHub 状态：8 个 open issue、关键 PR #12 四天未动、CI 失败、issue #30（=任务「设计数据库 Schema」）3 天前关闭。

输出（真实 DeepSeek，一次 LLM 调用，总耗时 3422ms）：

> 设计数据库 Schema 已在 GitHub issue #30 关闭，视为完成移除。剩余 5 项共 690 分钟…但 CI 失败（issue #45）与 PR #12 未合并是交付风险，且仓库有 8 个 open issue 含计划外工作（如 #48 连接池泄漏），故新增 1 项『排查数据库连接池泄漏』（对应 issue #48…），并压缩『编写用户文档』…

验证点逐条达成：读取仓库 ✓ → 发现 8 个 open issues ✓ → 关键 PR 未合并 ✓ → CI 失败 ✓ → 判定落后 ✓ → Replan（移除 1 + 新增 1，净数不超原任务数）✓ → 明确解释（引用具体 issue/PR 编号）✓。

## 3. 五问回答

### 3.1 Tool 是否真的改善了 Replan？
**是，且是质的改善。** 无工具时 Replan 只知道用户声明（"5/6 未完成"）；有工具后能发现：用户以为没做的其实做完了（#30）、用户没登记的隐患存在（#48）、交付被 CI/PR 阻塞。闭环 reason 的每个论据都可追溯到仓库事实——这是 Phase 1-3 无法产生的解释质量。

### 3.2 GitHub 数据和 LifeOS Task 如何匹配？
标题归一化三级置信度（精确 1.0 / 子串 0.75 / 词元 Jaccard ≥0.5），取每个任务的最佳匹配；`observed_done` 只认 ≥0.75（精确或包含关系）；LLM 侧被明确约束"仅 progress_report.matches 中的匹配可用，不得自行等同标题"。匹配是规划依据，最终取舍仍过 TS 硬约束（enforceTaskBudget/TimeBudget 原样生效，闭环输出 6 ≤ 6+1 证明）。

### 3.3 错误匹配率？
对抗性测试集上 **0 误报**（"部署上线" vs "部署文档编写"、"写技术方案文档" vs "写 API 文档" 均正确不匹配；最佳匹配选择正确）。这是受控数据下的下界保证；真实世界误报率的持续监控依赖后续积累（第一版无真实用户数据）。已知局限：中文短标题仅靠精确/子串，跨语言标题（中文任务 vs 英文 issue）不会匹配——宁缺勿错的代价。

### 3.4 Tool 调用带来的延迟？
闭环 3422ms 中 GitHub 部分约 100ms（stub 本地）；真实 GitHub API 冒烟 6470ms（公网 6 个 GET + LLM），工具占比约 2-3s（公网往返）。相对 LLM 的 3-5s 属同量级可接受；后续可并行化 6 个请求再压一半。

### 3.5 是否值得继续接 Calendar / Email？
**值得，顺序建议：Email（Gmail/IMAP 只读）→ Calendar。** 本工具证明了"外部事实 → 解释性 Replan"的产品价值成立；Email 提供的是"时间投入证据"（沟通记录、确认函），与 GitHub 的"交付状态证据"互补，且 IMAP/Gmail API 只读成熟；Calendar 的价值在时间预算冲突检测（Phase 2 预算条的数据源），但需要写操作（建日程）才能闭环，确认机制要先行。复用本阶段的模式即可：只读客户端 + 事实 Schema + 失败降级 + 确定性分析节点。

## 4. 边界确认

- 未做任何写操作（六端点全 GET，无 POST/PATCH/PUT/DELETE）
- 工具失败（404/403/超时/网络/异常）全部降级为 ok=False，graph 正常完成（有专项测试）
- 无仓库路径的 LLM payload 与 Phase 3 逐字节一致（测试锁定），存量行为零漂移
