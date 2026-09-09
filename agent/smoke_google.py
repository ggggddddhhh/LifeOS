"""真实 Google Calendar 冒烟脚本（凭据就绪后运行）。

前置：
  1. Google Cloud Console 创建 OAuth 客户端（Desktop），下载 client_secret 到 agent/google-credentials.json
  2. export GOOGLE_CREDENTIALS_FILE=agent/google-credentials.json
  3. 首次运行会打印授权 URL → 浏览器授权 → 把回调 code 粘贴回来（一次性）
  4. export GOOGLE_CALENDAR_ID=primary（或目标日历 id）

行为：创建一个 "[LifeOS Test]" 事件 → GET 回读 Verify（Instant+metadata）→ 打印 event id。
不自动删除（按要求）；人工清理：日历中删除该事件即可。

用法：.venv/Scripts/python.exe smoke_google.py [--code <authorization_code>] [--verifier <pkce_verifier>]
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime, timedelta

from app.calendar_write import CalendarWriteError
from app.google_calendar import GoogleCalendarProvider, GoogleOAuth

TZ = os.environ.get("LIFEOS_USER_TZ", "Asia/Shanghai")


def main() -> int:
    creds = os.environ.get("GOOGLE_CREDENTIALS_FILE", "")
    if not creds:
        print("缺少 GOOGLE_CREDENTIALS_FILE —— 未配置 OAuth 凭据，按设计不伪造真实测试。"
              "\n凭据就绪后重跑本脚本。")
        return 2
    auth = GoogleOAuth(creds, os.environ.get("GOOGLE_TOKEN_FILE", ".google-token.json"))
    if not auth._refresh:  # noqa: SLF001 —— 尚未授权
        if "--code" not in sys.argv:
            from app.google_calendar import GoogleOAuth as G

            client_id = auth._client_secret()[0]  # noqa: SLF001
            url, verifier = G.build_authorization_url(client_id)
            print("授权 URL（浏览器打开并授权，把 ?code=... 的 code 用 --code 传入）：")
            print(url)
            print(f"--verifier {verifier}")
            return 3
        code = sys.argv[sys.argv.index("--code") + 1]
        verifier = sys.argv[sys.argv.index("--verifier") + 1] if "--verifier" in sys.argv else ""
        auth.exchange_code(code, verifier)
        print("授权完成，refresh_token 已持久化")

    provider = GoogleCalendarProvider(auth, os.environ.get("GOOGLE_CALENDAR_ID", "primary"))
    start = datetime.now(UTC).replace(microsecond=0) + timedelta(days=1)
    end = start + timedelta(minutes=30)
    key = f"smoke:{start.strftime('%Y%m%d%H%M')}:t1:1"
    metadata = {"goalId": "smoke", "taskId": "t1", "planVersion": 1, "timezone": TZ}
    try:
        ev = provider.create_event(key, "[LifeOS Test] 冒烟事件", start, end, metadata=metadata)
        checks = provider.verify_event(ev["id"], expect_start=start, expect_end=end, metadata={**metadata, "idempotencyKey": key})
        print(f"✅ 创建并 Verify 通过：event id={ev['id']} start={ev['start']} checks={checks}")
        print("（按要求不自动删除；请人工在日历中清理该测试事件）")
        # 幂等复验：同 key 再创建 → 应命中既有事件
        again = provider.create_event(key, "[LifeOS Test] 冒烟事件", start, end, metadata=metadata)
        print(f"✅ 幂等复验：再次 create 返回同一事件 {again['id'] == ev['id']}")
        return 0
    except CalendarWriteError as e:
        print(f"❌ 冒烟失败：{e.code}: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
