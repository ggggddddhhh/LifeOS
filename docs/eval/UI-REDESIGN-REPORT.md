# LifeOS UI Redesign Report

日期：2026-09-09 · 设计 `7a917bb`（docs/UI-REDESIGN.md）· 全部页面重写，业务语义零变更

## 验证结论

| 项 | 结果 |
|---|---|
| npm test | **89/89**（87 存量 + 2 新增：planVersions 透出、settings 代理 502 结构化） |
| npm run build | ✅（6 路由：/ /goals /goals/[id] /calendar /activity /settings） |
| pytest（Agent 零改动确认） | **170/170** |
| Desktop 1440px | ✅ 侧栏+主区、焦点卡、三列看板、双栏下方区块、时间线 |
| Mobile 390px | ✅ 顶栏+单列内容+底部 5-tab（md 断点 CSS 验证 display:none） |
| Light / Dark | ✅ 三态切换（浅/深/跟随系统）+ 防闪白 boot script + 双主题截图确认 |
| Loading | ✅ 骨架屏（真实 API 慢时出现、加载后替换） |
| Error | ✅ Agent 不可达 → Settings 显示「状态未知」+ 处置提示；错误可重试、不再常驻 |
| Conflict/Fallback | ✅ stale_conflict/duplicate_skipped/failed 统一徽章（写入区）；风险信号只在有情况时出现 |
| Destructive 确认 | ✅ 删除目标、断开 Google、写入日历全部经 ConfirmDialog |

## Before → After

| 维度 | Before | After |
|---|---|---|
| 信息架构 | 单页堆叠全部 Goal 看板+日历面板；创建表单常占左栏 | 5 区 App Shell（Today/Goals/Calendar/Activity/Settings）+ Goal Detail 专属页；创建改为对话框按需触发 |
| AI 表达 | "🤖 reason" emoji 泡泡、"AI Replan" 大按钮常驻 | Replan 是克制的 Action：进行态（分析中）→ reason 摘要 + 结构化 diff + finalize 说明，动作后出现 |
| 任务卡 | 循环点击换状态（done 旁即"重开"易误触）、红 badge 表优先级、emoji meta | checkbox 显式三态 + 快捷键可预期；优先级用点密度；Lucide 图标；notes 折叠；tabular 数字 |
| 容量语义 | 硬编码 480min/天冒充容量 | 明确标注「估算容量」（默认 8h/天）语义，与后端真实容量来源区分展示 |
| 确认制写入 | CalendarPanel 淹没在卡片流末尾，"Confirm all" 英文裸按钮 | 独立「日历写入」区块：草稿清单 → 「写入我的日历」明确 external-write 确认对话（含幂等安全说明）→ 逐条结果徽章 + 写入历史 |
| Plan Diff | 纯文本堆行 | added/removed/changed 结构化 + 估时变化方向图标；Detail 时间线与 Activity 全局时间线（数据源 planVersions 透出） |
| 状态体系 | 加载/空态一行灰字；error 常驻红条 | 骨架屏 / EmptyState（图标+引导）/ ErrorState（可重试）/ 统一 StatusBadge |
| 主题 | 仅 light（变量存在无切换） | light/dark/system 三态 + localStorage + 防闪白 + 全 semantic 色双主题映射 |
| 动效 | 无规范 | 150–250ms 统一缓动；出现/背景色过渡；`prefers-reduced-motion` 全量禁用 |
| 可访问性 | 无 focus 规范 | focus-visible 全局 ring；aria-current/role=radiogroup/progressbar/aria-expanded；checkbox aria-label |
| 移动端 | 未设计（网格挤压） | 底部 tab 导航、看板列 tab 切换、单列流、安全区 padding |

## Design System 落地

- **Tokens**：semantic 四色（success/warning/danger/info，oklch 双主题）；`--radius` 收紧 0.5rem；
  数字 `tabular-nums` 工具类；motion keyframes（rise/fade）
- **密度**：任务卡 p-2.5 / 列表行 gap-1.5 / 区块 24-32px 二档；卡片 border-only（shadow 仅 popover）
- **图标**：全站 Lucide（替换全部 emoji 功能图标）
- **组件复用**：shadcn 现有 8 组件 + 新共享层（StatusBadge/states/ConfirmDialog），无重复造轮子

## 支撑性后端变更（零业务逻辑，已声明）

1. `GET /api/goals` include `versions`（PlanVersion 字段透出，供 Activity/Detail；测试覆盖）
2. `GET|POST /api/settings/calendar`（agent `/v1/calendar/status|disconnect` 纯代理；不触 OAuth；测试覆盖 502 结构化）

**禁改清单遵守确认**：Python Agent / LangGraph / Planner / Finalize / GitHub Tool / Calendar Provider /
OAuth / confirmation / idempotency / stale / verify 未动一行；全部既有 API 行为不变（89 存量测试语义零改动通过）。

## 过程修复的实现缺陷

- kanban 初版用 JS 判断宽度（hydration mismatch 风险）→ 改纯 CSS 断点
- goal-detail 状态更新在 setState updater 内做副作用（StrictMode 双调用风险）→ 改快照模式
- Base UI Dialog 的 `asChild` 用法不成立 → `render` prop
- Prisma 关系名 `versions`（非 planVersions）同步前后端与测试

## 已知边界

- Replan 全链路真实耗时 p50≈20s：按钮已显示「分析中」，但无独立进度流（属产品功能，未新增）
- 移动端看板用 tab 切列（未做拖拽排序——与 desktop 行为一致，避免误触）
- Activity 数据上限 50 条（客户端聚合）
