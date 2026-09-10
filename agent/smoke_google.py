"""真实 Google Calendar 冒烟脚本（凭据就绪后运行）。

前置：
  1. Google Cloud Console 创建 OAuth 客户端（Desktop），下载 client_secret 到 agent/google-credentials.json
  2. export GOOGLE_CREDENTIALS_FILE=agent/google-credentials.json
  3. 首次运行会打印授权 URL（含 state）→ 浏览器授权 → 把整个回调 URL 粘贴回来
  4. export GOOGLE_CALENDAR_ID=primary（或目标日历 id）

行为：创建一个 "[PlanShift Test]" 事件 → GET 回读 Verify（Instant+metadata）→ 打印 event id →
同 key 幂等复验。不自动删除（按要求）；人工清理：日历中删除该事件即可。

Phase 8.5：
  --url "<完整回调URL>"    粘贴 localhost:1/oauth2callback?state=..&code=..（推荐，state 自动校验）
  --code/--state/--verifier  逐参数传入（等价）
  --status                 查看连接状态（不含 token 值）
  --disconnect             revoke 远端 token + 清除本地凭据
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

from app.calendar_write import CalendarWriteError
from app.google_calendar import GoogleCalendarProvider, GoogleOAuth
from app.token_store import make_token_store

TZ = os.environ.get("LIFEOS_USER_TZ", "Asia/Shanghai")


def _auth() -> GoogleOAuth:
    creds = os.environ.get("GOOGLE_CREDENTIALS_FILE", "")
    if not creds:
        print("缺少 GOOGLE_CREDENTIALS_FILE —— 未配置 OAuth 凭据，按设计不伪造真实测试。"
              "\n凭据就绪后重跑本脚本。")
        raise SystemExit(2)
    return GoogleOAuth(creds, make_token_store("default"))


def _flag(name: str) -> str | None:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else None


def main() -> int:
    auth = _auth()

    if "--status" in sys.argv:
        print(auth.status())
        return 0
    if "--disconnect" in sys.argv:
        print(auth.disconnect())
        print("已断开；reconnect = 重跑本脚本完成一次新的授权流程")
        return 0

    if not auth._refresh:  # noqa: SLF001 —— 尚未授权
        callback = _flag("--url")
        if callback:
            q = parse_qs(urlparse(callback).query)
            code = (q.get("code") or [""])[0]
            state = (q.get("state") or [None])[0]
        else:
            code, state = _flag("--code"), _flag("--state")
        if not code:
            url, state_new = auth.begin_authorization()
            print("授权 URL（浏览器打开并授权，把整个 localhost 回调 URL 用 --url 传入）：")
            print(url)
            print(f"state={state_new}（已存会话文件，--url 会自动校验）")
            return 3
        auth.exchange_code(code, state=state, code_verifier=_flag("--verifier"))
        print("授权完成，refresh_token 已持久化（含账号绑定）")

    provider = GoogleCalendarProvider(auth, os.environ.get("GOOGLE_CALENDAR_ID", "primary"))
    try:
        binding = provider.connect()
        print(f"绑定校验通过：account={binding['accountEmail']} calendar={binding['calendarId']}")
    except CalendarWriteError as e:
        print(f"❌ 绑定校验失败：{e.code}: {e}")
        return 1

    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=1)
    end = start + timedelta(minutes=30)
    key = f"smoke:{start.strftime('%Y%m%d%H%M')}:t1:1"
    metadata = {"goalId": "smoke", "taskId": "t1", "planVersion": 1, "timezone": TZ}
    try:
        ev = provider.create_event(key, "[PlanShift Test] 冒烟事件", start, end, metadata=metadata)
        checks = provider.verify_event(ev["id"], expect_start=start, expect_end=end, metadata={**metadata, "idempotencyKey": key})
        print(f"✅ 创建并 Verify 通过：event id={ev['id']} start={ev['start']} checks={checks}")
        print("（按要求不自动删除；请人工在日历中清理该测试事件）")
        # 幂等复验：同 key 再创建 → 应命中既有事件
        again = provider.create_event(key, "[PlanShift Test] 冒烟事件", start, end, metadata=metadata)
        print(f"✅ 幂等复验：再次 create 返回同一事件 {again['id'] == ev['id']}")
        return 0
    except CalendarWriteError as e:
        print(f"❌ 冒烟失败：{e.code}: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
