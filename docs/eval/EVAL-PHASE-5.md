# Phase 5 验证报告 — Calendar 只读工具（真实容量驱动 Replan）

- 日期：2026-09-09 · 模型：`deepseek-chat`
- 实现：`agent/app/calendar.py`（ICS 只读解析，无第三方依赖；`CAL_ICS_PATH` 未配置即停用）
- 评测：`agent/eval_p5.py`（6 场景 × G（仅 GitHub）/ GC（GitHub+Calendar）两臂，真实 LLM）+ 真实 ICS 端到端冒烟
- 测试：pytest 79/79（新增 18）、npm test 56/56（新增容量覆写/透传 3 个）、build 通过

## 1. Schema 与三层语义（要求 #1 #2 #3）

```
CalendarFacts（观察事实）      DayBusy{date, busy_minutes, event_count, all_day_event} / CalendarEvent
CapacityReport（容量合成）     per_day_declared（用户声明，请求字段 declaredMinutesPerDay）
                              per_day_inferred（Agent 推断 = max(0, 720 − busy)）
                              per_day_effective（声明 > 推断 > 默认 480）
                              conflicts[]（声明超出推断 60min+ → 显式标注，不静默采信）
```

冲突行为（scn 声明 480/天 vs 日历推断 120/天）：effective 按声明 480（声明优先），conflicts 逐天标注"声明 480 vs 推断 120"，prompt 要求 reason 必须显式标注风险并建议确认——实测 7 天全部标注。

## 2. 容量如何进入 Replan（要求 #4 #7）

双通道，硬约束原则不变：
1. **Python**：`capacity.capacityMinutes` 注入 prompt，REPLANNER 硬约束改为"以 capacity.capacityMinutes 为准"；
2. **TS**：`ReplanResponse.capacityMinutes` → agent client 透传 → replan 路由 `enforceTimeBudget(tasks, daysLeft, 480, capacityMinutes)`——只扩展容量输入来源，砍/压逻辑原样（有专项单测：1140 覆写下 P3 被砍、总量 ≤1140）。

无 Calendar 无声明 → capacity 字段不注入、响应为 null、路由走默认 480×天数——与既有行为逐字节一致（pytest 锁定）。

## 3. A/B 评测结果（6 场景，真实 LLM）

| 场景 | G 总估时 | GC 总估时 | 真实容量 | G 超真实容量 | GC 合容量 |
|---|---|---|---|---|---|
| **重点：前3天1h后4天4h**（负载1980） | **1560** | 1200 | 1140 | **是** | 图级差60，TS守卫兜底到≤1140 |
| 前2天全天事件 | 870 | 780 | 1800 | 否 | 是 |
| 整周半忙 | 1080 | 1080 | 2100 | 否 | 是 |
| 完全空闲周 | 1080 | 1080 | 5040 | 否 | 是 |
| 声明与日历冲突 | 990 | 990 | 3360(声明) | 否 | 是（冲突7天全标注） |
| 会议密集(60min/天) | 960 | **300** | 360 | **是** | 是 |

- ok 率 6/6；reason 提及容量 6/6；**任务 dueDate 落在全天事件日的违规 = 0**
- 工具额外延迟：本地平均 +291ms（LLM 波动为主）
- 重点场景里 G 臂对真实容量视而不见（1560 > 1140），GC 臂图级压到 1200、经 TS 硬守卫最终 ≤1140——分层保证（LLM 尽力 + 确定性兜底）按设计工作

## 4. 端到端冒烟（真实 ICS 文件 → 容量 → 重排）

构造 ICS（前 3 天 11h/天会议 → 推断 60min/天；后 4 天 7h/天 → 推断 300min/天），`CAL_ICS_PATH` 指向文件，真实 DeepSeek：

- `capacityMinutes=1380`（= 3×60+4×300，与 ICS 内容精确自洽）✓
- 计划 1980 → **1260 ≤ 1380**，reason 明说"容量上限 1380 超载 600，压缩+合并+删除排期" ✓
- **前 3 天（每天仅 1h）排期任务数为 0**——重活全部后移到可用量大的第 4-7 天 ✓
- 插曲：第一次冒烟 ICS 路径无效（Windows `/tmp`），工具静默降级、容量回退默认 3360、plan 正常返回——降级路径被意外实测 ✓

## 5. 六个要求场景的 pytest 覆盖

全天有会议（推断0+信号）/ 半天空闲（360）/ 周末全空（=窗口）/ 声明冲突（标注+声明优先）/ API 不可用（回退默认）/ 无事件（推断=窗口）+ ICS 解析（定时/全天/折行/文件读取/文件缺失降级）+ 重点模式（3×60+4×240=1140 精确断言）+ 图独立启用（仅GitHub/仅Calendar/双工具/无工具/工具爆炸/仅声明）。

## 6. 结论与边界

1. **真实容量显著提升可执行性**：G 臂在 2/6 场景规划超出真实容量（1560/1140、960/360），GC 臂全部收敛（图级 5/6 + TS 守卫 6/6）；排期避让全天事件日 0 违规。
2. **分层语义成立**：声明 > 推断 > 默认的优先级、冲突显式标注、三层在 Schema 中物理分离。
3. **解耦验证**：github/calendar 可独立启用（pytest 三组合 + 无工具路径逐字节不变）。
4. **边界确认**：全程只读（仅 ICS 文件读取）；未实现任何日历写操作；工具失败/文件缺失均不阻断。
5. 遗留观察：图级 LLM 压缩偶尔差少量分钟（focal 1200 vs 1140），由 TS 硬守卫兜底——这是"LLM 尽力 + 确定性保证"的预期分层，非缺陷；跨天多日事件的忙碌分摊采用保守整段计入，节假日/时区未建模（v1 边界，README 已注明）。
