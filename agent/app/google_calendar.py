"""Phase 8/8.5：Google Calendar Provider（真实日历接入 + 长期运行加固）。

- 第一版只支持：读事件 / 读 all-day / 创建 LifeOS 事件 / 写后 Verify（8.5 不变）
- 禁止 Update / Delete / Move / 修改用户事件（代码层不调用相应 API）
- Google API 逻辑只存在于此文件；Planner/Graph/Finalize/路由零感知
- Token 铁律：access/refresh/secret 永不进入 prompt、AgentState、日志或错误响应
- 时间语义：dateTime+timeZone → Instant+IANA；date → LocalDate（Phase 7.5 模型）
- 幂等 CREATE：pre-check(privateExtendedProperty) → insert → 异常时回查而非盲重试
- Phase 8.5：state+PKCE 会话 / TokenStore 安全存储 / reauth_required 链路 /
  读退避重试（CREATE 仍禁盲重试）/ 账号+calendarId 绑定 / disconnect / 用户提示
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import secrets
import threading
import time
from datetime import datetime, timedelta
from typing import Protocol

import httpx

from .calendar import CalendarClient
from .calendar_write import CalendarWriteError, CalendarWriteProvider
from .schemas import CalendarEvent, CalendarFacts, DayBusy
from .times import DEFAULT_PLANNING_TZ, UTC, today_in, to_utc
from .token_store import FileTokenStore, TokenStore, make_token_store

SCOPES = [
    "https://www.googleapis.com/auth/calendar.events",    # 创建/读取事件（幂等 CREATE 所需）
    "https://www.googleapis.com/auth/calendar.readonly",  # 读日历元数据（账号绑定校验所需）
]
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
API_BASE = "https://www.googleapis.com/calendar/v3"
LIFEOS_MARKER = "app=lifeos"
SESSION_TTL_SECONDS = 600  # 授权会话（state+verifier）10 分钟一次性

# 用户可理解提示（Phase 8.5）：随 CalendarWriteError.hint 透传到 TS error 字符串
HINTS = {
    "reauth_required": "Google 授权已失效，请重新运行授权流程（smoke_google.py）",
    "auth_invalid": "授权状态异常，请断开后重新授权",
    "auth_failed": "授权校验失败（state/code 不匹配），请重新发起授权",
    "credentials_missing": "缺少 Google 凭据配置，请检查 GOOGLE_CREDENTIALS_FILE",
    "api_disabled": "项目未启用 Google Calendar API，请在 Google Cloud Console 启用后重试",
    "permission_denied": "当前 Google 账号无权访问该日历，请检查授权账号与日历 ID",
    "rate_limited": "Google 限流，请稍后重试",
    "provider_5xx": "Google 服务暂时不可用，请稍后重试",
    "timeout": "请求超时且结果未知；系统会通过幂等键回查，请稍后刷新，切勿手动在日历中重复创建",
    "network": "网络异常，请稍后重试",
    "account_mismatch": "凭据与配置的账号/日历不一致，请 disconnect 后重新授权",
}


class GoogleAuthError(CalendarWriteError):
    def __init__(self, code: str, message: str, hint: str | None = None):
        super().__init__(code, message, hint or HINTS.get(code))


# ---------------------------------------------------------------- OAuth（Authorization Code + PKCE + state）

class GoogleOAuth:
    """Token 生命周期管理。token 只在本类与 TokenStore 之间流动。

    Phase 8.5：state+PKCE 会话文件（一次性、10 分钟）；refresh 被拒即清库并要求重新授权；
    账号绑定记录（accountEmail/calendarId）随 token 一起存储，防串号。
    """

    def __init__(self, credentials_file: str, token_store: TokenStore | str,
                 http: httpx.Client | None = None, *, api_base: str | None = None,
                 session_file: str | None = None):
        self.credentials_file = credentials_file
        self.store: TokenStore = FileTokenStore(token_store) if isinstance(token_store, str) else token_store
        self._http = http
        self.api_base = (api_base or API_BASE).rstrip("/")
        self._session_file = session_file or ".google-auth-session.json"
        self._lock = threading.Lock()
        self._access: str | None = None
        self._access_expiry: float = 0.0
        self._refresh: str | None = None
        self._record: dict | None = None
        self._load()

    # -------- 持久化（TokenStore）

    def _load(self) -> None:
        self._record = self.store.load()
        self._refresh = self._record["refreshToken"] if self._record else None

    def _persist(self) -> None:
        if self._refresh:
            base = self._record or {}
            self._record = {
                "refreshToken": self._refresh,
                "accountEmail": base.get("accountEmail", ""),
                "calendarId": base.get("calendarId", ""),
                "scopes": base.get("scopes") or SCOPES,
                "obtainedAt": datetime.now(UTC).isoformat(timespec="seconds"),
            }
            self.store.save(self._record)

    @property
    def record(self) -> dict | None:
        """绑定信息快照（不含 token 值的安全字段可展示；refreshToken 本身不出本类）。"""
        if not self._record:
            return None
        r = dict(self._record)
        r.pop("refreshToken", None)
        return r

    def _client_secret(self) -> tuple[str, str]:
        try:
            with open(self.credentials_file, encoding="utf-8") as f:
                creds = json.load(f)
            inst = creds.get("installed") or creds.get("web") or {}
            return inst["client_id"], inst["client_secret"]
        except (OSError, ValueError, KeyError) as e:
            raise GoogleAuthError("credentials_missing", "缺少或损坏的 Google 凭据文件") from e

    # -------- 授权入口（state + PKCE，会话一次性）

    def begin_authorization(self, redirect_uri: str = "http://localhost:1/oauth2callback") -> tuple[str, str]:
        """生成授权 URL（含 state），state+verifier 存会话文件（10 分钟一次性）。"""
        from urllib.parse import quote

        client_id, _ = self._client_secret()
        verifier = secrets.token_urlsafe(48)
        state = secrets.token_urlsafe(24)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        url = (
            f"{AUTH_URL}?response_type=code&client_id={client_id}&redirect_uri={redirect_uri}"
            f"&scope={quote(' '.join(SCOPES))}&access_type=offline&prompt=consent"
            f"&code_challenge={challenge}&code_challenge_method=S256&state={state}"
        )
        with open(self._session_file, "w", encoding="utf-8") as f:
            json.dump({"state": state, "verifier": verifier, "createdAt": time.time(),
                       "expiresAt": time.time() + SESSION_TTL_SECONDS}, f)
        return url, state

    def _load_session(self) -> dict | None:
        try:
            with open(self._session_file, encoding="utf-8") as f:
                s = json.load(f)
        except (OSError, ValueError):
            return None
        if time.time() > float(s.get("expiresAt", 0)):
            self._consume_session()
            return None
        return s

    def _consume_session(self) -> None:
        try:
            os.unlink(self._session_file)
        except OSError:
            pass

    def exchange_code(self, code: str, code_verifier: str | None = None, state: str | None = None,
                      redirect_uri: str = "http://localhost:1/oauth2callback") -> None:
        """code 换 token。verifier/state 缺省从会话文件取；传入 state 必须与会话一致（CSRF 防护）。"""
        session = self._load_session()
        verifier = code_verifier or (session or {}).get("verifier", "")
        if state and session and state != session.get("state"):
            raise GoogleAuthError("auth_failed", "OAuth state 不匹配（疑似伪造回调或会话过期）")
        if not verifier:
            raise GoogleAuthError("auth_failed", "缺少 code_verifier（无活跃授权会话）")
        client_id, client_secret = self._client_secret()
        res = self._post_token({
            "client_id": client_id, "client_secret": client_secret,
            "code": code, "code_verifier": verifier,
            "grant_type": "authorization_code", "redirect_uri": redirect_uri,
        })
        self._apply_token(res)
        self._consume_session()
        self._fetch_account_binding()  # 绑定账号邮箱（best-effort，失败不阻断）

    def _fetch_account_binding(self) -> None:
        """GET /calendars/primary 取账号邮箱写入 token 记录（connect 时绑定）。"""
        try:
            res = self._api_get("/calendars/primary")
            email = (res.json() or {}).get("id", "") if res.status_code == 200 else ""
        except (httpx.HTTPError, CalendarWriteError, ValueError):
            email = ""
        if email:
            base = self._record or {}
            self._record = {**base, "accountEmail": email,
                            "calendarId": base.get("calendarId") or os.environ.get("GOOGLE_CALENDAR_ID", "primary")}
            self._persist()

    def _api_get(self, path: str) -> httpx.Response:
        http = self._http or httpx.Client(timeout=30)
        return http.get(f"{self.api_base}{path}", headers={"Authorization": f"Bearer {self.access_token()}"})

    # -------- token 端点

    def _post_token(self, form: dict) -> dict:
        http = self._http or httpx.Client(timeout=30)
        try:
            res = http.post(TOKEN_URL, data=form)
        except httpx.HTTPError as e:
            raise GoogleAuthError("network", "Google OAuth 网络错误") from e
        if res.status_code >= 500:
            raise GoogleAuthError("provider_5xx", "Google OAuth 服务错误")
        if res.status_code == 429:
            raise GoogleAuthError("rate_limited", "Google OAuth 限流")
        if res.status_code >= 400:
            # 原始响应体绝不外抛
            raise GoogleAuthError("auth_rejected", "OAuth 授权失败（token 端点拒绝）")
        return res.json()

    def _apply_token(self, data: dict) -> None:
        self._access = data["access_token"]
        self._access_expiry = time.time() + int(data.get("expires_in", 3600)) - 60
        if data.get("refresh_token"):
            self._refresh = data["refresh_token"]
        self._persist()

    # -------- refresh / 失效 / disconnect

    def _refresh_access(self) -> None:
        if not self._refresh:
            raise GoogleAuthError("reauth_required", "无 refresh_token，需要用户授权")
        client_id, client_secret = self._client_secret()
        t0 = time.perf_counter()
        try:
            data = self._post_token({
                "client_id": client_id, "client_secret": client_secret,
                "refresh_token": self._refresh, "grant_type": "refresh_token",
            })
        except GoogleAuthError as e:
            from .trace import trace

            transient = e.code in ("network", "provider_5xx", "rate_limited")
            # trace 记最终语义码（与 relstats 不可恢复口径一致）；瞬时保留原码
            trace("token_refresh", ok=False, error_code="reauth_required" if not transient else e.code)
            if transient:
                raise  # 瞬时故障：保留 token，下次再试
            # invalid_grant（撤销/过期/换密码）：清库防"复活"，必须重新授权
            self._refresh = None
            self._record = None
            self.store.delete()
            raise GoogleAuthError("reauth_required", "refresh_token 已失效（撤销/过期），本地凭据已清除") from e
        from .trace import trace

        trace("token_refresh", ok=True, latency_ms=round((time.perf_counter() - t0) * 1000))
        self._apply_token(data)

    def access_token(self) -> str:
        with self._lock:  # 单飞：并发只刷一次
            if self._access and time.time() < self._access_expiry:
                return self._access
            self._refresh_access()
            return self._access or ""

    def disconnect(self) -> dict:
        """断开：尽力 revoke 远端 token，无论如何清除本地凭据（用户意图优先）。"""
        out: dict = {"ok": True, "revoked": True, "warning": None}
        refresh = self._refresh
        if refresh:
            http = self._http or httpx.Client(timeout=30)
            try:
                res = http.post(REVOKE_URL, data={"token": refresh})
                out["revoked"] = res.status_code == 200
                if res.status_code != 200:
                    out["warning"] = f"远端 revoke 返回 {res.status_code}（本地凭据已清除）"
            except httpx.HTTPError as e:
                out["revoked"] = False
                out["warning"] = f"远端 revoke 网络失败（本地凭据已清除）：{type(e).__name__}"
        self._access = None
        self._access_expiry = 0.0
        self._refresh = None
        self._record = None
        self.store.delete()
        self._consume_session()
        return out

    def status(self) -> dict:
        return {"connected": bool(self._refresh), **(self.record or {"accountEmail": "", "calendarId": ""})}

    def bind_account(self, email: str, calendar_id: str) -> None:
        """回填账号绑定（旧格式 token 迁移 / connect 首次确认时）。"""
        if not email:
            return
        base = self._record or {}
        self._record = {**base, "accountEmail": email,
                        "calendarId": base.get("calendarId") or calendar_id}
        self._persist()


# ---------------------------------------------------------------- 错误映射（统一码，原始错误不出 provider）

def _map_error(e: httpx.HTTPError) -> CalendarWriteError:
    if isinstance(e, httpx.TimeoutException):
        return CalendarWriteError("timeout", "Google Calendar 请求超时", hint=HINTS["timeout"])
    return CalendarWriteError("network", "Google Calendar 网络错误", hint=HINTS["network"])


RETRYABLE_CODES = {"timeout", "network", "rate_limited", "provider_5xx"}
GET_ATTEMPTS = 3


def _backoff_seconds(attempt: int, retry_after: float | None) -> float:
    """429 优先 Retry-After（上限 60s）；否则指数退避 + 抖动。测试可调小 base。"""
    if retry_after is not None:
        return min(float(retry_after), 60.0)
    base = float(os.environ.get("LIFEOS_GOOGLE_BACKOFF_BASE", "0.5"))
    return base * (2 ** attempt) + random.uniform(0, 0.2)


class GoogleCalendarProvider(CalendarClient, CalendarWriteProvider):
    """读（fetch_facts）+ 写（read_events/create_event）双协议实现。
    api_base 可覆写指向 Fake 服务（测试）。"""

    provider_name = "google"

    def __init__(self, auth: GoogleOAuth, calendar_id: str = "primary", api_base: str | None = None,
                 planning_tz: str | None = None, http: httpx.Client | None = None):
        self.auth = auth
        self.calendar_id = calendar_id
        self.api_base = (api_base or os.environ.get("GOOGLE_API_BASE") or API_BASE).rstrip("/")
        # http 可注入（测试用 trust_env=False 隔离系统代理；生产默认走环境代理配置）
        self._http = http or httpx.Client(timeout=30)
        self._planning_tz = planning_tz
        self._binding_verified = False

    # ---------------- 账号/calendarId 绑定（Phase 8.5 防串号）

    def _ensure_binding(self) -> None:
        """本地校验每次都做（零成本）；远端校验一次（connect）。"""
        rec = self.auth.record
        if rec and rec.get("calendarId") and rec["calendarId"] != self.calendar_id:
            raise CalendarWriteError(
                "account_mismatch",
                f"token 绑定日历 {rec['calendarId']} 与当前配置 {self.calendar_id} 不一致，拒绝串号访问",
                hint=HINTS["account_mismatch"])

    def connect(self) -> dict:
        """远端绑定校验（每个 provider 生命周期一次）：primary 账号 vs 记录。返回账号信息。"""
        if self._binding_verified:
            return {"accountEmail": (self.auth.record or {}).get("accountEmail", ""), "calendarId": self.calendar_id}
        self._ensure_binding()
        try:
            res = self._get("/calendars/primary")
            email = res.json().get("id", "") if res.status_code == 200 else ""
        except (CalendarWriteError, ValueError):
            email = ""
        rec = self.auth.record
        if email and rec and rec.get("accountEmail") and email != rec["accountEmail"]:
            raise CalendarWriteError(
                "account_mismatch",
                f"token 归属账号 {rec['accountEmail']} 与当前授权账号 {email} 不一致",
                hint=HINTS["account_mismatch"])
        if email and (not rec or not rec.get("accountEmail")):
            self.auth.bind_account(email, self.calendar_id)  # 旧格式迁移：回填绑定
        self._binding_verified = True
        return {"accountEmail": email or (rec or {}).get("accountEmail", ""), "calendarId": self.calendar_id}

    # ---------------- 底层请求（401 → 单飞刷新 → 重放一次）

    def _request(self, method: str, path: str, *, params: dict | None = None, json_body: dict | None = None) -> httpx.Response:
        try:
            res = self._http.request(
                method, f"{self.api_base}{path}",
                params=params, json=json_body,
                headers={"Authorization": f"Bearer {self.auth.access_token()}"},
            )
        except httpx.HTTPError as e:
            raise _map_error(e) from e
        if res.status_code == 401:
            with self.auth._lock:  # noqa: SLF001 —— 强制刷新后重放一次
                self.auth._access = None  # noqa: SLF001
                self.auth._refresh_access()
            try:
                res = self._http.request(
                    method, f"{self.api_base}{path}",
                    params=params, json=json_body,
                    headers={"Authorization": f"Bearer {self.auth.access_token()}"},
                )
            except httpx.HTTPError as e:
                raise _map_error(e) from e
            if res.status_code == 401:
                # 刷新成功但 API 仍拒：scope 变更/应用侧异常（refresh token 仍有效，不删）
                raise CalendarWriteError("auth_invalid", "access_token 刷新后仍被拒绝", hint=HINTS["auth_invalid"])
        if res.status_code == 403:
            reason = ""
            try:
                err_obj = res.json().get("error")
                errs = err_obj.get("errors", []) if isinstance(err_obj, dict) else []
                reason = errs[0].get("reason", "") if errs else ""
            except ValueError:  # 响应体不是 JSON
                pass
            if reason == "accessNotConfigured":
                raise CalendarWriteError("api_disabled", "Google Calendar API 未在项目中启用（403 accessNotConfigured）", hint=HINTS["api_disabled"])
            raise CalendarWriteError("permission_denied", "Google Calendar 权限不足（403）", hint=HINTS["permission_denied"])
        if res.status_code == 429:
            ra: float | None = None
            try:
                ra = float(res.headers.get("Retry-After") or "")
            except ValueError:
                ra = None
            raise CalendarWriteError("rate_limited", "Google Calendar 限流（429）", hint=HINTS["rate_limited"], retry_after=ra)
        if res.status_code >= 500:
            raise CalendarWriteError("provider_5xx", "Google Calendar 服务错误", hint=HINTS["provider_5xx"])
        return res

    # ---------------- GET 统一退避重试（CREATE 的 POST 永不自动重试）

    def _get(self, path: str, params: dict | None = None, attempts: int = GET_ATTEMPTS) -> httpx.Response:
        last: CalendarWriteError | None = None
        for attempt in range(attempts):
            try:
                return self._request("GET", path, params=params)
            except CalendarWriteError as e:
                last = e
                if e.code not in RETRYABLE_CODES or attempt == attempts - 1:
                    raise
                time.sleep(_backoff_seconds(attempt, getattr(e, "retry_after", None)))
        raise last  # pragma: no cover —— 循环必经 raise/return

    # ---------------- 时间映射（Google ↔ Phase 7.5 模型）

    @staticmethod
    def _to_instant(g: dict) -> tuple[str, str]:
        """Google {dateTime, timeZone} → (startUtc, timezone)。dateTime 含偏移/Z → 直接 Instant。"""
        dt = g["dateTime"]
        tz = g.get("timeZone", "")
        if ("+" in dt[10:]) or dt.endswith("Z"):
            utc = datetime.fromisoformat(dt.replace("Z", "+00:00")).astimezone(UTC)
            return utc.isoformat(timespec="seconds").replace("+00:00", "Z"), tz
        # 无偏移墙钟（罕见）→ canonical 转换
        conv = to_utc(datetime.fromisoformat(dt), tz or DEFAULT_PLANNING_TZ)
        return conv.instant.isoformat(timespec="seconds").replace("+00:00", "Z"), tz

    @staticmethod
    def _from_instant(instant: datetime, tz: str) -> dict:
        return {"dateTime": instant.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"), "timeZone": tz}

    def _events_in_window(self, time_min_utc: datetime, time_max_utc: datetime) -> list[dict]:
        params = {
            "timeMin": time_min_utc.isoformat().replace("+00:00", "Z"),
            "timeMax": time_max_utc.isoformat().replace("+00:00", "Z"),
            "singleEvents": "true", "maxResults": "250",
        }
        res = self._get(f"/calendars/{self.calendar_id}/events", params=params)
        return res.json().get("items", []) if res.status_code == 200 else []

    # ---------------- 读协议（CalendarClient）

    def fetch_facts(self, days: int, timezone: str = DEFAULT_PLANNING_TZ) -> CalendarFacts:
        tz = self._planning_tz or timezone
        base = today_in(tz)
        time_min = to_utc(datetime(base.year, base.month, base.day), tz).instant
        last = base + timedelta(days=max(1, days) - 1)
        time_max = to_utc(datetime(last.year, last.month, last.day) + timedelta(days=1) - timedelta(seconds=1), tz).instant
        fetched_at = datetime.now().astimezone().isoformat(timespec="seconds")
        try:
            self._ensure_binding()
            items = self._events_in_window(time_min, time_max)
        except CalendarWriteError as e:
            return CalendarFacts(ok=False, error=f"{e.code}: {e}", window_days=days, fetched_at=fetched_at)

        events: list[CalendarEvent] = []
        by_date = {base + timedelta(days=i): DayBusy(date=(base + timedelta(days=i)).isoformat()) for i in range(days)}
        daily_window = int(os.environ.get("CAL_DAILY_WINDOW_MINUTES", 720))
        for it in items:
            priv = (it.get("extendedProperties") or {}).get("private") or {}
            source = "lifeos" if priv.get("app") == "lifeos" or it.get("summary", "").startswith("LifeOS:") else "user"
            s, e = it.get("start") or {}, it.get("end") or {}
            if "date" in s:  # all-day：LocalDate 语义
                ld = s["date"]
                events.append(CalendarEvent(
                    title=it.get("summary", ""), startUtc="", endUtc="", timezone=s.get("timeZone", tz or ""),
                    all_day=True, local_date=ld, source=source,
                ))
                try:
                    from datetime import date as _date

                    d = _date.fromisoformat(ld)
                    if d in by_date:
                        by_date[d].all_day_event = True
                        by_date[d].busy_minutes = daily_window
                        by_date[d].event_count += 1
                except ValueError:
                    pass
                continue
            start_utc, ev_tz = self._to_instant(s)
            end_utc, _ = self._to_instant(e) if "dateTime" in e else (start_utc, ev_tz)
            events.append(CalendarEvent(
                title=it.get("summary", ""), startUtc=start_utc, endUtc=end_utc,
                timezone=ev_tz or tz, source=source,
            ))
            si, ei = datetime.fromisoformat(start_utc.replace("Z", "+00:00")), datetime.fromisoformat(end_utc.replace("Z", "+00:00"))
            for d, db in by_date.items():
                ws = to_utc(datetime(d.year, d.month, d.day, 0), tz).instant
                we = ws + timedelta(days=1)
                ov = (min(ei, we) - max(si, ws)).total_seconds() / 60
                if ov > 0:
                    db.busy_minutes += int(ov)
                    db.event_count += 1
        return CalendarFacts(ok=True, days=[by_date[base + timedelta(days=i)] for i in range(days)],
                             events=events[:50], window_days=days, fetched_at=fetched_at)

    # ---------------- 写协议（CalendarWriteProvider）

    def read_events(self) -> list[dict]:
        """供 executor 的幂等/冲突复检：返回窗口内事件（uid=Google eventId）。"""
        self._ensure_binding()
        tz = self._planning_tz or DEFAULT_PLANNING_TZ
        base = today_in(tz)
        time_min = to_utc(datetime(base.year, base.month, base.day), tz).instant
        time_max = time_min + timedelta(days=31)
        items = self._events_in_window(time_min, time_max)
        out = []
        for it in items:
            s, e = it.get("start") or {}, it.get("end") or {}
            priv = (it.get("extendedProperties") or {}).get("private") or {}
            if "date" in s:
                out.append({"uid": it["id"], "title": it.get("summary", ""), "allDay": True,
                            "localDate": s["date"], "startUtc": "", "endUtc": ""})
                continue
            start_utc, _ = self._to_instant(s)
            end_utc, _ = self._to_instant(e) if "dateTime" in e else (start_utc, "")
            out.append({"uid": it["id"], "title": it.get("summary", ""), "allDay": False, "localDate": None,
                        "startUtc": start_utc, "endUtc": end_utc, "private": priv})
        return out

    def _find_by_key(self, idempotency_key: str) -> dict | None:
        res = self._get(f"/calendars/{self.calendar_id}/events",
                        params={"privateExtendedProperty": f"idempotencyKey={idempotency_key}", "maxResults": "5"})
        items = res.json().get("items", []) if res.status_code == 200 else []
        return items[0] if items else None

    def create_event(self, uid: str, title: str, start: datetime, end: datetime,
                     *, metadata: dict | None = None) -> dict:
        """幂等 CREATE：pre-check → insert → 异常回查（绝不盲重试）。返回创建的事件体。

        uid 参数即 idempotencyKey（executor 已保证唯一性）；externalEventId 使用 Google 返回的 id。
        Phase 8.5：回查走 _get（带退避重试）；timeout/network 回查未命中 → 语义为"结果未知"，
        绝不重发 insert。
        """
        self._ensure_binding()
        metadata = metadata or {}
        body = {
            "summary": title,
            "description": f"LifeOS 计划块 goal={metadata.get('goalId')} task={metadata.get('taskId')} "
                           f"v{metadata.get('planVersion')} key={uid}",
            "start": self._from_instant(start, metadata.get("timezone") or DEFAULT_PLANNING_TZ),
            "end": self._from_instant(end, metadata.get("timezone") or DEFAULT_PLANNING_TZ),
            "extendedProperties": {"private": {
                "app": "lifeos", "goalId": str(metadata.get("goalId", "")),
                "taskId": str(metadata.get("taskId", "")), "planVersion": str(metadata.get("planVersion", "")),
                "idempotencyKey": uid,
            }},
        }
        existing = self._find_by_key(uid)
        if existing:
            return existing  # 幂等收敛：历史 CREATE 实际已成功
        try:
            res = self._request("POST", f"/calendars/{self.calendar_id}/events", json_body=body)
        except CalendarWriteError as e:
            # timeout/network/429/5xx：先回查（第一次可能已成功；回查本身带退避重试）
            found = self._find_by_key(uid)
            if found:
                return found
            if e.code in ("timeout", "network"):
                raise CalendarWriteError("timeout", "创建请求超时且回查未命中——结果未知，禁止重发", hint=HINTS["timeout"]) from e
            raise  # rate_limited/provider_5xx：服务端未受理，原样上抛
        if res.status_code in (200, 201):
            return res.json()
        raise CalendarWriteError("provider_5xx", f"创建失败（{res.status_code}）", hint=HINTS["provider_5xx"])

    def verify_event(self, external_event_id: str, *, expect_start: datetime, expect_end: datetime,
                     metadata: dict | None = None) -> dict:
        """GET 回读：Instant + calendarId + LifeOS metadata 全匹配才算通过。"""
        metadata = metadata or {}
        try:
            res = self._get(f"/calendars/{self.calendar_id}/events/{external_event_id}")
        except CalendarWriteError as e:
            raise CalendarWriteError("event_not_found" if e.code in ("network", "timeout") else e.code, "Verify 读取失败") from e
        if res.status_code == 404:
            raise CalendarWriteError("event_not_found", "事件不存在")
        ev = res.json()
        checks = {
            "exists": ev.get("status", "confirmed") != "cancelled",
            "startOk": False, "endOk": False, "metadataOk": False,
        }
        s, e = ev.get("start") or {}, ev.get("end") or {}
        if "dateTime" in s:
            got_s, _ = self._to_instant(s)
            got_e, _ = self._to_instant(e) if "dateTime" in e else (got_s, "")
            checks["startOk"] = datetime.fromisoformat(got_s.replace("Z", "+00:00")) == expect_start
            checks["endOk"] = datetime.fromisoformat(got_e.replace("Z", "+00:00")) == expect_end
        priv = (ev.get("extendedProperties") or {}).get("private") or {}
        checks["metadataOk"] = (
            priv.get("app") == "lifeos"
            and priv.get("idempotencyKey") == metadata.get("idempotencyKey")
            and priv.get("goalId") == str(metadata.get("goalId", ""))
            and priv.get("taskId") == str(metadata.get("taskId", ""))
        )
        if not all(checks.values()):
            raise CalendarWriteError("verify_failed", f"Verify 失败 {checks}")
        return checks
