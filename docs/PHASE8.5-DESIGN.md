# Phase 8.5 设计：Google Calendar Provider Hardening

> 目标：不加新功能，补齐真实用户**长期运行**能力。Phase 8 已验证单次闭环可用；
> 本阶段回答的是"跑一周会不会坏、坏了用户能不能看懂、坏的过程中会不会重复写入"。

## 0. 非目标（明确不做）

- Calendar Update / Delete / Move（仍然只在代码层调用 read + insert）
- Email / 其他工具接入
- 多用户产品化（无用户体系；只做**隔离机制**，见 §7）
- UI 改动（错误提示经现有 error 字符串透传，TS 零改动）

## 1. 现状审计（缺口 → 本阶段动作）

| # | 缺口 | 现状 | 动作 |
|---|---|---|---|
| 1 | OAuth state | 只有 PKCE，无 state，回调可被伪造拼接 | §2 |
| 2 | token 明文存储 | `.google-token.json` 明文 JSON，生产也明文 | §3 |
| 3 | refresh 失效语义 | invalid_grant 后仅内存置 None，**磁盘不清**，下次启动又"复活" | §4 |
| 4 | 读无重试 | 429/timeout/5xx 一次即失败，fetch_facts 直接 ok=False | §5 |
| 5 | CREATE 超时回查无重试 | 回查一次，网络抖动时误报 failed | §5 |
| 6 | 账号/日历无绑定 | token 文件与 calendarId 无关联，换环境配置即串号 | §6 |
| 7 | 无 disconnect | 撤销授权只能在 Google 账号页手动操作 | §8 |
| 8 | 错误提示面向开发者 | `provider_5xx` 等裸码，用户不可行动 | §9 |

保持不变：Draft→确认→Execute→Verify、stale check、用户事件优先、仅 CREATE、
幂等双层（DB unique key + provider pre-check/回查）、Instant 全链路。

## 2. OAuth state + PKCE 会话

- `GoogleOAuth.begin_authorization()`：生成 `state`（urlsafe 32B）+ `verifier`，
  写入**会话文件** `.google-auth-session.json`（与 token 文件同目录）：
  `{state, verifier, createdAt, expiresAt}`，**10 分钟过期、一次性**（exchange 成功即删）。
- 授权 URL 追加 `&state=`。
- `exchange_code(code, state=None, verifier=None)`：verifier/state 缺省时从会话文件取；
  调用方传入 state 时**必须与会话一致**，不一致 → `auth_failed`（CSRF 防护）。
- 冒烟脚本改为"粘贴完整回调 URL"，自动解析 `state` + `code`。

## 3. TokenStore 抽象（安全存储 + 按用户隔离）

```
TokenStore: load() -> dict | None; save(record); delete()
├── FileTokenStore(path)      # 开发/本机；原子写（tmp+os.replace）
└── KeyringTokenStore(service) # 生产；OS 凭据管理器（Windows Credential Manager）
```

- token 记录升级为：`{refreshToken, accountEmail, calendarId, scopes, obtainedAt}`
  （旧格式 `{refresh_token}` 自动迁移读取）。
- 选择：`LIFEOS_TOKEN_STORE=keyring|file`（默认 file，保持现状兼容）。
- **生产门禁**：`LIFEOS_ENV=production` 且 store=file → 启动即 `RuntimeError`，
  禁止生产明文运行（fail fast，不静默降级）。
- keyring 延迟 import；未安装时选 keyring → 明确报错。
- 按用户：file 路径 `.google-token-{user_key}.json`（`default` 保持旧路径不变）；
  keyring service `LifeOS:{user_key}`。不同 user_key 物理隔离，加载失败**绝不回退**到其他用户。

## 4. 失效与重新授权（reauth_required 链路）

错误码细分：

| 码 | 含义 | 磁盘 token |
|---|---|---|
| `credentials_missing` | 凭据文件缺失/损坏 | 不动 |
| `reauth_required` | 无 refresh / refresh 被拒（invalid_grant、撤销、过期） | **删除** |
| `auth_failed` | code/state/verifier 交换被拒 | 不动 |
| `auth_invalid` | refresh 成功但 API 仍 401（scope 变更/应用侧问题） | 保留 |

- `_refresh_access` 失败 → `store.delete()` + 内存清空 + `reauth_required`。
- 401 → 单飞刷新 → 重放一次 → 仍 401 → `auth_invalid`。
- 下游表现：fetch_facts `ok=False` 带 `reauth_required: …（提示：…请重新授权）`；
  execute 单条 failed 同理；reconnect = 重跑授权流程（会话文件机制复用）。

## 5. 重试与退避（读重试；CREATE 仍禁止盲重试）

- `_get(path, params)`：GET 统一走此入口，最多 3 次尝试。
  可重试码：`timeout / network / rate_limited / provider_5xx`。
  退避：429 优先 `Retry-After`（上限 60s，错误对象携带），否则
  `base * 2^n + jitter`，base=`LIFEOS_GOOGLE_BACKOFF_BASE`（默认 0.5s，测试可调小）。
- 覆盖：fetch_facts / read_events / _find_by_key / verify_event / 账号绑定读。
- **CREATE（POST insert）永不自动重试**，维持 Phase 8 协议；增强点：
  insert 异常后的**幂等回查也走 `_get`（带退避重试）**，网络抖动时不再误报 failed。
  回查未命中时：原错误为 `timeout/network` → `timeout`（提示"结果未知，请勿手动重试，
  稍后重新确认会命中幂等回查"）；`rate_limited/provider_5xx` → 原样上抛（服务端未受理）。

## 6. 账号 + calendarId 绑定（防串号）

- connect 时（exchange 后 / provider 创建时）：`GET /calendars/primary` 取账号邮箱，
  与 `calendarId` 一起写入 token 记录。
- Provider 每次创建时校验：`记录.calendarId ≠ 配置.calendarId` → `account_mismatch`（本地即可判定）；
  `记录.accountEmail ≠ 当前 primary 账号` → `account_mismatch`（远端校验，connect 时执行并缓存）。
- 绑定校验失败 = 工具停用（fetch_facts ok=False 带提示），不崩服务。

## 7. 多用户隔离边界（机制，不做产品）

- `GoogleOAuth(credentials_file, store)`：store 可传入任意 user_key 的 TokenStore。
- main.py 当前固定 `user_key="default"`（LifeOS 尚无用户体系）；
  隔离由**机制 + 测试**保证：两个 user_key 的 store 互不可见、空 store 不回退他人 token、
  token 记录与 calendarId 绑定防"换配置读别人日历"。

## 8. disconnect / reconnect

- `GoogleOAuth.disconnect()`：POST `oauth2.googleapis.com/revoke`（token=refresh_token）；
  成功 → 删本地 store；revoke 网络失败 → 本地仍删（用户意图优先），返回 `revoked=False` + warning。
  内存 access/refresh 全清，main.py 单例重置。
- 运维面：`POST /v1/calendar/disconnect`、`GET /v1/calendar/status`
  （connected / accountEmail / calendarId / store 类型；不含任何 token 值）。
- reconnect = 重跑授权（smoke 脚本引导）。

## 9. 错误分类 + 用户可理解提示

`CalendarWriteError` 增加可选 `hint`，`__str__` 输出 `message（提示：hint）`——
executor 的 `f"{e.code}: {e}"` 与 fetch_facts 的 error 字符串自动携带，TS 零改动。

| code | 用户提示（hint） |
|---|---|
| reauth_required | Google 授权已失效，请重新运行授权流程 |
| auth_invalid / auth_failed | 授权状态异常，请断开后重新授权 |
| credentials_missing | 缺少 Google 凭据配置，请联系管理员 |
| api_disabled | 项目未启用 Google Calendar API，请在 Google Cloud Console 启用 |
| permission_denied | 当前 Google 账号无权访问该日历，请检查授权账号与日历 ID |
| rate_limited | Google 限流，请稍后重试 |
| provider_5xx | Google 服务暂时不可用，请稍后重试 |
| timeout | 请求超时且结果未知；系统会通过幂等键回查，请稍后刷新，切勿手动在日历中重复创建 |
| network | 网络异常，请稍后重试 |
| account_mismatch | 凭据与配置的账号/日历不一致，请重新连接（disconnect 后重新授权） |

## 10. 故障注入测试矩阵（Fake Google 扩展）

| 场景 | 注入 | 期望 |
|---|---|---|
| token 过期 | access 失效 | 401→refresh→重放成功 |
| refresh 失败 | token 端点 400 invalid_grant | reauth_required + 磁盘 token 被删 |
| 撤销授权 | refresh 被拒后再次调用 | 仍 reauth_required，不复活 |
| 429 后恢复 | list 429×2→200 | 重试退避后成功 |
| 429 持续 | list 429×∞ | rate_limited 且尝试=上限 |
| 5xx 后恢复 | list 5xx×1→200 | 重试成功 |
| 网络中断 | api_base 指向死端口 | network 分类 + 提示 |
| CREATE 超时实际成功 | timeout_after_write | 回查收敛，1 个事件 |
| CREATE 超时回查首次也失败 | 断连×1 后恢复 | 回查重试后收敛 |
| CREATE 429/5xx | 服务端未受理 | failed 原码上抛，0 事件 |
| 重复确认 | 同请求执行两次 | 第二次 pre-check 命中，0 新事件 |
| 账号切换 | primary 邮箱变更 / calendarId 变更 | account_mismatch |
| 用户隔离 | user A/B 两个 store | 互不可见、空不回退 |
| 生产明文门禁 | LIFEOS_ENV=production + file | RuntimeError |
| state 错误 | 回调 state≠会话 | auth_failed，token 不落库 |
| 泄露断言 | 全部失败路径 | 错误串无 refresh/access/secret 子串 |

## 11. 交付与回归

- pytest 全量（新增 hardening 用例）+ vitest 81 + build 不回退；
- smoke_google.py 支持新授权流（粘贴完整回调 URL）与 `--disconnect` / `--status`；
- EVAL-PHASE-8.5.md：故障矩阵结果 + dogfood 就绪判定；
- 依赖：pyproject 增加可选 `keyring`（默认 file store 不强依赖）。
