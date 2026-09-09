# Phase 8.5 评测报告：Google Calendar Provider Hardening

日期：2026-09-09 · 前置：PHASE8-DESIGN.md（af711fc）· 实现 + 测试 + 真实验证一次通过

## 一、做了什么（对应需求逐项）

| 需求 | 实现 | 验证 |
|---|---|---|
| token 自动 refresh / 失效 / 重新授权 | 401→单飞刷新→重放；invalid_grant→**清磁盘 token** + `reauth_required`；刷新成功仍 401→`auth_invalid`（保留 refresh） | 注入测试 + 真实撤销路径 |
| OAuth state / PKCE 安全 | `begin_authorization()` 生成 state+verifier 存**一次性会话文件**（10 分钟 TTL）；exchange 校验 state 一致性（CSRF） | 注入测试 + 真实重授权 |
| refresh token 安全存储 | `TokenStore` 抽象：`FileTokenStore`（开发，原子写）/ `KeyringTokenStore`（生产，OS 凭据管理器）；**生产+明文 fail fast 门禁**；token 记录含绑定字段 | 单元测试（含 FakeKeyring） |
| 429/timeout/5xx 重试退避 | GET 统一走 `_get`：≤3 次，429 优先 `Retry-After`（上限 60s），指数退避+抖动（`LIFEOS_GOOGLE_BACKOFF_BASE` 可调） | 注入测试（恢复/耗尽两路） |
| CREATE 超时幂等回查 | insert **永不盲重试**不变；回查走 `_get`（带退避）；未命中且原错误为 timeout/network → `timeout`"结果未知"语义 | 注入测试 ×2 |
| 账号与 calendarId 绑定 | token 记录 `{accountEmail, calendarId}`；本地校验零成本每次做，远端校验 connect 一次；不一致→`account_mismatch` 拒绝访问 | 注入测试 ×3 + 真实绑定回填 |
| disconnect / reconnect | `disconnect()`：尽力 revoke（失败如实 warning）+ 本地必清；`POST /v1/calendar/disconnect`、`GET /v1/calendar/status`；reconnect=重授权 | 注入测试 + **真实 revoke 验证** |
| stale check / Verify / confirmation | 未动（设计红线），全部存量测试保持 | 回归 |
| 错误分类 + 用户提示 | 11 个稳定码 + 中文 hint 随 `str(e)` 透传（TS 零改动自动显示） | 泄露断言测试 |
| 多用户隔离 | store 按 user_key 物理隔离（file 分文件 / keyring 分 service）；空 store **绝不回退**他人 token；非 default 用户忽略显式路径防串号 | 单元测试 |

## 二、故障注入矩阵（全部通过）

| # | 场景 | 注入方式 | 结果 |
|---|---|---|---|
| 1 | token 过期 | access 失效 | 401→刷新→重放成功 |
| 2 | refresh 被拒（invalid_grant/撤销） | token 端点 400 | `reauth_required` + 磁盘清除 + 二次调用不复活 |
| 3 | refresh 瞬时 5xx | token 端点 503×1 | `provider_5xx` 上抛、**token 保留**、下次成功 |
| 4 | 刷新成功仍被拒 | 新 token 被替换 | `auth_invalid`，refresh 保留 |
| 5 | 429×2 后恢复 | list 429（Retry-After:0） | 第 3 次收敛，`list_calls==3` |
| 6 | 429 持续 | list 429∞ | `rate_limited`，重试止于上限 3 |
| 7 | 5xx×1 后恢复 | list 503 | 第 2 次收敛 |
| 8 | 网络中断 | 死端口（trust_env=False） | 稳定码 network/timeout + fetch_facts 降级不崩 |
| 9 | CREATE 超时**实际成功**+回查也抖动 | 断连×1 + list 503×1 | 退避回查收敛，仍只有 1 个事件 |
| 10 | CREATE 超时**未写** | 断连且未写 | `timeout`"结果未知"提示，0 事件，不盲重发 |
| 11 | 重复确认 | 同请求执行两次 | pre-check 命中，0 新事件（存量保持） |
| 12 | state 伪造 | 回调 state≠会话 | `auth_failed`，token 不落库 |
| 13 | 会话过期 | expiresAt 过期 | `auth_failed` |
| 14 | calendarId 串号 | 记录≠配置 | `account_mismatch`，本地判定 0 网络请求 |
| 15 | 账号不一致 | primary 邮箱≠记录 | connect 拒绝 |
| 16 | 绑定失败 | 同上走 fetch | `ok=False` 带提示，服务不崩 |
| 17 | disconnect 正常 | revoke 200 | 远端 revoke + 本地清 + `connected=False` |
| 18 | disconnect 远端失败 | revoke 503 | 本地仍清 + 如实 warning |
| 19 | reconnect | 断开后新授权 | 新 token + 绑定建立 |
| 20 | 用户隔离 | alice/bob 双 store | 互不可见、不串号、空不回退 |
| 21 | 生产明文门禁 | production+file | `RuntimeError`；keyring 通过 |
| 22 | 泄露断言 | 全部失败路径 | 错误串/响应/状态无 refresh/access/secret 子串 |

## 三、真实验证（用户真实 Google 账号）

1. **disconnect**：真实 revoke 成功，本地清除（`{'ok': True, 'revoked': True}`）
2. **重新授权**：state+PKCE 会话 → 用户粘贴完整回调 URL → state 校验通过 → 双 scope 授予
3. **账号绑定回填**：`account=user@example.test calendar=primary`（connect 远端校验 + 旧格式迁移路径均验证）
4. **冒烟**：创建 → Verify（exists/startOk/endOk/metadataOk）→ 幂等复验（同 event id）

## 四、过程中发现并修复的问题（如实记录）

1. **scope 契约错误**（真实验证发现）：`calendar.events` 不含日历元数据端点，账号绑定读 `/calendars/primary` 返回 403。修复：scope 扩为 `calendar.events + calendar.readonly`（仍只读）。**教训：scope 是与真实服务的契约，Fake 不校验 scope 测不出来**——真实链路验证不可替代。
2. **测试机系统代理干扰**：httpx 默认 `trust_env=True` 走系统代理，"服务端断连"被代理转成 502、死端口被代理应答 5xx，故障语义全变。修复：Provider 支持注入 http client，测试用 `trust_env=False`；**生产保留环境代理**（用户可能依赖代理访问 Google）。
3. **Windows 死端口表现为挂起超时**而非立即拒绝：断言放宽为传输层故障族（network/timeout 都是正确分类）。

## 五、回归

| 套件 | 结果 |
|---|---|
| pytest | **155/155**（127 存量 + 25 hardening + 3 API；存量仅 1 处按新错误码更新断言） |
| vitest | **81/81**（TS 零改动，纯回归） |
| next build | 通过（exit 0） |
| 真实 Google 链路 | 授权/绑定/创建/验证/幂等/断开/重连 全通过 |

## 六、dogfood 就绪判定

**结论：适合小规模真实用户 dogfood（建议 ≤5 人、单机部署）。**

支撑：
- 需求清单全部落地且有对应故障注入测试；核心安全属性（不重复创建、不静默串号、不泄露 token）多层验证；
- 真实账号端到端闭环（含断开/重连）已走通；长期运行最常见故障（token 失效、限流、网络抖动）全部有确定性收敛路径；
- 失败时用户能看到可行动的中文提示（hint 随现有 error 字符串透传，TS 未改一行）。

dogfood 已知边界（如实）：
1. **单用户**：`user_key="default"` 固定，多用户隔离机制就绪但 API 无用户维度（等产品用户体系）；
2. dogfood 用 file store（明文本地文件）——符合开发定位；**上线生产前必须切 `LIFEOS_TOKEN_STORE=keyring` 且门禁会强制拦截明文**；
3. scope 较 Phase 8 多一项 `calendar.readonly`（仍只读），已重新授权；
4. `timeout`"结果未知"场景的收敛依赖用户稍后重新确认（幂等回查兜底），无自动后台对账；
5. disconnect 时远端 revoke 网络失败会留残 token（本地已清、warning 如实上报），Google 侧最长存活至自然过期。

未做（按指示）：Update/Delete、Email、下一阶段。
