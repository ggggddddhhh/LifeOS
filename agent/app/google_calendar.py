"""Phase 8：Google Calendar Provider（真实日历接入）。

- 第一版只支持：读事件 / 读 all-day / 创建 LifeOS 事件 / 写后 Verify
- 禁止 Update / Delete / Move / 修改用户事件（代码层不调用相应 API）
- Google API 逻辑只存在于此文件；Planner/Graph/Finalize/路由零感知
- Token 铁律：access/refresh/secret 永不进入 prompt、AgentState、日志或错误响应
- 时间语义：dateTime+timeZone → Instant+IANA；date → LocalDate（Phase 7.5 模型）
- 幂等 CREATE：pre-check(privateExtendedProperty) → insert → 异常时回查而非盲重试
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
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

SCOPES = ["https://www.googleapis.com/auth/calendar.events"]  # 最小权限：读+建事件
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API_BASE = "https://www.googleapis.com/calendar/v3"
LIFEOS_MARKER = "app=lifeos"


class GoogleAuthError(CalendarWriteError):
    def __init__(self, code: str, message: str):
        super().__init__(code, message)


# ---------------------------------------------------------------- OAuth（Authorization Code + PKCE）

class GoogleOAuth:
    """Token 生命周期管理。token 只在本类与 token 文件之间流动。"""

    def __init__(self, credentials_file: str, token_file: str, http: httpx.Client | None = None):
        self.credentials_file = credentials_file
        self.token_file = token_file
        self._http = http
        self._lock = threading.Lock()
        self._access: str | None = None
        self._access_expiry: float = 0.0
        self._refresh: str | None = None
        self._load()

    def _load(self) -> None:
        try:
            with open(self.token_file, encoding="utf-8") as f:
                data = json.load(f)
            self._refresh = data.get("refresh_token")
        except (OSError, ValueError):
            self._refresh = None

    def _persist(self) -> None:
        with open(self.token_file, "w", encoding="utf-8") as f:
            json.dump({"refresh_token": self._refresh}, f)

    def _client_secret(self) -> tuple[str, str]:
        try:
            with open(self.credentials_file, encoding="utf-8") as f:
                creds = json.load(f)
            inst = creds.get("installed") or creds.get("web") or {}
            return inst["client_id"], inst["client_secret"]
        except (OSError, ValueError, KeyError) as e:
            raise GoogleAuthError("auth_required", "缺少或损坏的 Google 凭据文件") from e

    @staticmethod
    def build_authorization_url(client_id: str, redirect_uri: str = "http://localhost:1/oauth2callback") -> tuple[str, str]:
        """返回 (授权 URL, code_verifier)。PKCE S256。"""
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        url = (
            f"{AUTH_URL}?response_type=code&client_id={client_id}&redirect_uri={redirect_uri}"
            f"&scope={SCOPES[0]}&access_type=offline&prompt=consent"
            f"&code_challenge={challenge}&code_challenge_method=S256"
        )
        return url, verifier

    def exchange_code(self, code: str, code_verifier: str, redirect_uri: str = "http://localhost:1/oauth2callback") -> None:
        client_id, client_secret = self._client_secret()
        res = self._post_token({
            "client_id": client_id, "client_secret": client_secret,
            "code": code, "code_verifier": code_verifier,
            "grant_type": "authorization_code", "redirect_uri": redirect_uri,
        })
        self._apply_token(res)

    def _post_token(self, form: dict) -> dict:
        http = self._http or httpx.Client(timeout=30)
        try:
            res = http.post(TOKEN_URL, data=form)
        except httpx.HTTPError as e:
            raise GoogleAuthError("network", "Google OAuth 网络错误") from e
        if res.status_code >= 500:
            raise GoogleAuthError("provider_5xx", "Google OAuth 服务错误")
        if res.status_code >= 400:
            # 原始响应体绝不外抛
            raise GoogleAuthError("auth_required", "OAuth 授权失败（token 端点拒绝）")
        return res.json()

    def _apply_token(self, data: dict) -> None:
        self._access = data["access_token"]
        self._access_expiry = time.time() + int(data.get("expires_in", 3600)) - 60
        if data.get("refresh_token"):
            self._refresh = data["refresh_token"]
            self._persist()

    def _refresh_access(self) -> None:
        if not self._refresh:
            raise GoogleAuthError("auth_required", "无 refresh_token，需要用户授权")
        client_id, client_secret = self._client_secret()
        try:
            data = self._post_token({
                "client_id": client_id, "client_secret": client_secret,
                "refresh_token": self._refresh, "grant_type": "refresh_token",
            })
        except GoogleAuthError:
            self._refresh = None  # invalid_grant：撤销/过期，必须重新授权
            raise
        self._apply_token(data)

    def access_token(self) -> str:
        with self._lock:  # 单飞：并发只刷一次
            if self._access and time.time() < self._access_expiry:
                return self._access
            self._refresh_access()
            return self._access or ""


# ---------------------------------------------------------------- 错误映射（统一码，原始错误不出 provider）

def _map_error(e: httpx.HTTPError) -> CalendarWriteError:
    if isinstance(e, httpx.TimeoutException):
        return CalendarWriteError("timeout", "Google Calendar 请求超时")
    return CalendarWriteError("network", "Google Calendar 网络错误")


class GoogleCalendarProvider(CalendarClient, CalendarWriteProvider):
    """读（fetch_facts）+ 写（read_events/create_event）双协议实现。
    api_base 可覆写指向 Fake 服务（测试）。"""

    provider_name = "google"

    def __init__(self, auth: GoogleOAuth, calendar_id: str = "primary", api_base: str | None = None, planning_tz: str | None = None):
        self.auth = auth
        self.calendar_id = calendar_id
        self.api_base = (api_base or os.environ.get("GOOGLE_API_BASE") or API_BASE).rstrip("/")
        self._http = httpx.Client(timeout=30)
        self._planning_tz = planning_tz

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
        if res.status_code == 403:
            raise CalendarWriteError("permission_denied", "Google Calendar 权限不足（403）")
        if res.status_code == 429:
            raise CalendarWriteError("rate_limited", "Google Calendar 限流（429）")
        if res.status_code >= 500:
            raise CalendarWriteError("provider_5xx", "Google Calendar 服务错误")
        return res

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
        res = self._request("GET", f"/calendars/{self.calendar_id}/events", params=params)
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
        res = self._request("GET", f"/calendars/{self.calendar_id}/events",
                            params={"privateExtendedProperty": f"idempotencyKey={idempotency_key}", "maxResults": "5"})
        items = res.json().get("items", []) if res.status_code == 200 else []
        return items[0] if items else None

    def create_event(self, uid: str, title: str, start: datetime, end: datetime,
                     *, metadata: dict | None = None) -> dict:
        """幂等 CREATE：pre-check → insert → 异常回查（绝不盲重试）。返回创建的事件体。

        uid 参数即 idempotencyKey（executor 已保证唯一性）；externalEventId 使用 Google 返回的 id。
        """
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
        except CalendarWriteError:
            # timeout/network/5xx：先回查（第一次可能已成功），仅 429/5xx 允许一次退避重试
            found = self._find_by_key(uid)
            if found:
                return found
            raise
        if res.status_code in (200, 201):
            return res.json()
        raise CalendarWriteError("provider_5xx", f"创建失败（{res.status_code}）")

    def verify_event(self, external_event_id: str, *, expect_start: datetime, expect_end: datetime,
                     metadata: dict | None = None) -> dict:
        """GET 回读：Instant + calendarId + LifeOS metadata 全匹配才算通过。"""
        metadata = metadata or {}
        try:
            res = self._request("GET", f"/calendars/{self.calendar_id}/events/{external_event_id}")
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
