# Phase 4 设计 — GitHub 只读进度工具

状态：设计定稿后实施。第一版只读，无任何写操作。

## 1. 架构审计（改动面）

| 现有模块 | 是否改动 | 说明 |
|---|---|---|
| Python graph.py / nodes.py | ✅ | 插入 `github_tool` + `progress_analysis` 两节点与分支 |
| Python schemas.py | ✅ | 新增 GitHub 事实/进度报告 Schema |
| Python 新增 github.py | ✅ 新文件 | 只读 HTTP 客户端（与 Planner 解耦，依赖注入） |
| Python prompts.py | ✅ | 附加「GitHub 上下文使用规范」注入块（仅当有仓库时） |
| TS 路由 / plan.ts / agent client | ❌ 零改动 | 仓库地址由 Python 从 goalTitle/description 解析；plan.ts 硬约束不感知 GitHub |
| DB Schema | ❌ 零改动 | GitHub 上下文是易逝输入，不持久化（快照可后续加） |

**关键决策**：不做 TS 侧任何改动。仓库标识从目标文本中解析（`github.com/owner/repo` 或 `repo:owner/name`），意味着存量 API 契约不动、存量测试天然不回退。

## 2. Graph 扩展（无新增环，保持无死循环）

```
analyze ──有仓库标识──→ github_tool → progress_analysis ──┐
   │                                                      ├→ plan/replan → validate ⇄(重试≤1) → finalize
   └──无仓库标识──────────────────────────────────────────┘
```

- 唯一回边仍是 validate→plan/replan（attempts 门控），LLM 调用上限不变（2）。
- `github_tool` 捕获一切异常 → `ok=False` 的事实对象，**永不使 graph 失败**（要求 #3）。
- `progress_analysis` 是纯确定性函数（无 LLM）。

## 3. 数据模型（Pydantic，事实与推断分离）

```python
class GithubFacts(BaseModel):          # 观察到的事实
    ok: bool; error: str | None
    repo: RepoInfo | None              # full_name/default_branch/pushed_at/open_issues_count
    open_issues: list[IssueBrief]      # number/title/updated_at（剔除 PR）
    closed_recent: list[IssueBrief]    # 近 14 天关闭
    open_prs: list[PRBrief]            # number/title/merged=False/draft/updated_at
    ci_runs: list[CIRunBrief]          # 每个 workflow 最新一次：name/conclusion
    commits: list[CommitBrief]         # sha7/message 首行/date
    fetched_at: str

class TaskMatch(BaseModel):            # 匹配带置信度（要求 #7）
    task_title: str; issue_number: int; issue_title: str
    confidence: float                  # 1.0 精确 / 0.75 包含 / Jaccard∈[0.5,1) 词元重合
    method: str

class ProgressReport(BaseModel):
    available: bool
    signals: list[str]                 # 事实性观察（"CI 最新运行失败"）
    matches: list[TaskMatch]
    observed_done: list[str]           # 匹配到已关闭 Issue 的未完成任务标题（GitHub 观察事实）
    inference:                         # Agent 推断，明确标注（要求 #6）
        verdict: "ahead" | "on_track" | "behind" | "unknown"
        reasons: list[str]
```

三层语义（要求 #6）：任务 status 字段 = 用户声明；GithubFacts/observed_done = 观察事实；verdict/reasons 与 LLM 的最终取舍 = 推断。

## 4. 匹配与置信度

`normalize` 后：精确相等 → 1.0；互为子串 → 0.75；英文词元 Jaccard ≥ 0.5 → 该值；否则不匹配。阈值以下的相似对**不匹配**（宁缺勿错，错误匹配率的控制手段）。observed_done 仅接受 confidence ≥ 0.75。

## 5. 工具调用（全部只读 GET）

| 端点 | 用途 |
|---|---|
| `/repos/{o}/{r}` | 仓库基本信息 |
| `/repos/{o}/{r}/issues?state=open` | 开放 Issue（按 `pull_request` 键剔除 PR） |
| `/repos/{o}/{r}/issues?state=closed` | 近期关闭 Issue（进度信号） |
| `/repos/{o}/{r}/pulls?state=open` | PR 状态 |
| `/repos/{o}/{r}/actions/runs?per_page=10` | CI 最新状态 |
| `/repos/{o}/{r}/commits?per_page=10` | 最近提交 |

- httpx，单请求 timeout 10s（`GITHUB_TIMEOUT_S`），总计预算 ≤ 15s
- `GITHUB_TOKEN` 可选（提高限额）；`GITHUB_API_BASE` 可覆写（测试/闭环验证指向 stub）
- 404（仓库不存在/私有）/403（限额）/超时/网络错误 → `ok=False` + error 摘要，graph 继续

## 6. Prompt 注入（仅有仓库时）

user payload 追加 `github_context`（Facts 摘要）与 `progress_report`，附使用规范：
- GitHub 事实优先于用户声明中过时的状态；`observed_done` 中的任务视为已完成，从新计划移除并在 reason 说明
- 调整必须可归因（reason 引用具体 Issue/PR/CI 事实）
- 数据不可用时按原流程规划，不得编造仓库状态
- 无仓库路径的 payload **逐字节不变**（回归零风险）

## 7. 测试与验证计划

- pytest：extract_repo 解析、匹配置信度（含对抗样本零误报）、进度分析各 verdict 分支、graph 分支（有/无仓库）、GitHub 失败/超时降级、闭环 fixture（MockLLM 下管线正确）
- 真实闭环（重点场景）：stub GitHub 服务提供「8 open issues + 关键 PR 未合并 + CI 失败 + 近期关闭 Issue 命中一个 LifeOS 任务」，真实 DeepSeek 跑 `/v1/replan`，验证 reason 引用事实并给出落后判定与调整
- 回归：npm test / pytest / build；无仓库路径 payload 不变性由测试锁定
