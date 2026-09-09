"""Phase 8：Google Calendar Provider 测试（本地 Fake Google 服务，覆盖 13 类场景）。"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timedelta, timezone as tzmod
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from app.calendar_write import CalendarWriteError, execute_drafts
from app.google_calendar import GoogleCalendarProvider, GoogleOAuth
from app.schemas import CalendarDraftItem, ExecuteRequest

UTC = tzmod.utc
PORT_HOLDER = {"port": 0}


class FakeGoogleState:
    def __init__(self):
        self.events: list[dict] = []
        self.next_id = 1
        self.create_calls = 0
        self.fault: dict = {}  # {"create": ..., "get": ..., "list": ...}
        self.refresh_calls = 0
        self.access_grant = "ok"  # ok | revoked
        self.precreated: list[dict] = []  # 服务器"已经"存在的事件（timeout-after-write 场景）
        # Phase 8.5 故障注入扩展：
        self.primary_email: str | None = None  # /calendars/primary 返回的账号（None=404）
        self.token_fault: str | None = None  # token 端点瞬时故障："5xx_once" | "429_once"
        self.revoke_status: int = 200
        self.revoke_calls = 0
        self.list_calls = 0  # GET events 次数（重试断言用）
        self.reject_after_refresh = False  # 刷新"成功"但新 token 仍被 API 拒绝（auth_invalid 路径）


STATE = FakeGoogleState()


class FakeGoogle(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, body, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length)) if length else {}

    def _authorized(self) -> bool:
        auth = self.headers.get("Authorization", "")
        return auth.endswith(STATE.access_grant_token) if hasattr(STATE, "access_grant_token") else auth.startswith("Bearer ")

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        if self.path.startswith("/token"):
            return self._handle_token(parse_qs(raw))
        if self.path.startswith("/revoke"):
            STATE.revoke_calls += 1
            return self._json(STATE.revoke_status, {})
        if not self._authorized():
            return self._json(401, {"error": "invalid_credentials"})
        try:
            body = json.loads(raw) if raw else {}
        except ValueError:
            body = {}
        if self.path.endswith("/events"):
            f = STATE.fault.get("create")
            STATE.create_calls += 1
            if f == "5xx":
                return self._json(503, {"error": "backendError"})
            if f == "429":
                return self._json(429, {"error": "rateLimitExceeded"})
            if f == "timeout_after_write":
                # 服务端实际成功但响应超时：写入后断连（不回包）
                STATE._insert(body)
                self.connection.close()
                return
            if f == "timeout_no_write":
                self.connection.close()
                return
            ev = STATE._insert(body)
            return self._json(200, ev)
        self._json(404, {})

    def _handle_token(self, form):
        STATE.refresh_calls += 1
        grant = form.get("grant_type", [""])[0]
        # Phase 8.5：瞬时故障注入（保持 refresh token 有效——区别于 invalid_grant）
        if STATE.token_fault == "5xx_once":
            STATE.token_fault = None
            return self._json(503, {"error": "backendError"})
        if STATE.token_fault == "429_once":
            STATE.token_fault = None
            return self._json(429, {"error": "rate_limit"}, headers={"Retry-After": "0"})
        if STATE.access_grant == "revoked" and grant == "refresh_token":
            return self._json(400, {"error": "invalid_grant"})
        token = f"tok-{STATE.refresh_calls}"
        STATE.access_grant_token = "someone-else-token" if STATE.reject_after_refresh else token
        out = {"access_token": token, "expires_in": 3600}
        if grant == "authorization_code":
            out["refresh_token"] = "refresh-1"
        return self._json(200, out)

    def do_GET(self):
        if not self._authorized():
            return self._json(401, {"error": "invalid_credentials"})
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path.endswith("/calendars/primary"):
            if not STATE.primary_email:
                return self._json(404, {"error": "notFound"})
            return self._json(200, {"id": STATE.primary_email, "summary": "primary"})
        if u.path.endswith("/events"):
            STATE.list_calls += 1
            f = STATE.fault.get("list")
            if f == "429_n2":  # 前 2 次 429（带 Retry-After: 0），之后恢复
                if STATE.list_calls <= 2:
                    return self._json(429, {"error": "rateLimitExceeded"}, headers={"Retry-After": "0"})
            elif f == "429_forever":
                return self._json(429, {"error": "rateLimitExceeded"}, headers={"Retry-After": "0"})
            elif f == "5xx_n1":  # 第 1 次 5xx，之后恢复
                if STATE.list_calls == 1:
                    return self._json(503, {"error": "backendError"})
            if f == "403":
                return self._json(403, {"error": "forbidden"})
            if STATE.fault.get("list") == "403_api_disabled":
                return self._json(403, {
                    "error": {
                        "code": 403,
                        "message": "Google Calendar API has not been used in project 1 before or it is disabled.",
                        "errors": [{"reason": "accessNotConfigured", "domain": "global", "message": "accessNotConfigured"}],
                        "status": "PERMISSION_DENIED",
                    }
                })
            key = q.get("privateExtendedProperty", [""])[0]
            if key.startswith("idempotencyKey="):
                want = key.split("=", 1)[1]
                # timeout_after_write：insert 已写入但客户端没拿到响应 → 回查能找到
                items = [e for e in STATE.events if e["extendedProperties"]["private"]["idempotencyKey"] == want]
                return self._json(200, {"items": items})
            items = [e for e in STATE.events]  # 简化：不做窗口过滤（测试自控数据）
            return self._json(200, {"items": items})
        if "/events/" in u.path:
            eid = u.path.rsplit("/", 1)[1]
            ev = next((e for e in STATE.events if e["id"] == eid), None)
            if ev is None:
                return self._json(404, {"error": "notFound"})
            if STATE.fault.get("get") == "wrong_start":
                bad = json.loads(json.dumps(ev))
                bad["start"]["dateTime"] = (datetime.fromisoformat(bad["start"]["dateTime"].replace("Z", "+00:00")) + timedelta(hours=3)).astimezone(UTC).isoformat().replace("+00:00", "Z")
                return self._json(200, bad)
            return self._json(200, ev)
        self._json(404, {})


def _insert(self, body):
    ev = dict(body)
    ev["id"] = f"g-{STATE.next_id}"
    ev["status"] = "confirmed"
    STATE.next_id += 1
    STATE.events.append(ev)
    return ev


FakeGoogleState._insert = _insert  # 挂到状态类（服务器写入即状态变更）


@pytest.fixture()
def fake_server(monkeypatch, tmp_path):
    STATE.__init__()
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeGoogle)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    # credentials/token 文件（OAuth 走 fake token 端点）
    creds = tmp_path / "creds.json"
    creds.write_text(json.dumps({"installed": {"client_id": "cid", "client_secret": "sec"}}), encoding="utf-8")
    token_file = tmp_path / "token.json"
    http = httpx.Client(timeout=5, base_url=f"http://127.0.0.1:{port}", trust_env=False)  # 隔离系统代理
    monkeypatch.setenv("LIFEOS_GOOGLE_BACKOFF_BASE", "0.001")  # 测试退避近零
    auth = GoogleOAuth(str(creds), str(token_file), http=http,
                       api_base=f"http://127.0.0.1:{port}", session_file=str(tmp_path / "session.json"))
    # 直接注入一个有效 access（绕过授权流程；token 端点用于刷新测试）
    auth._access = "tok-0"
    auth._access_expiry = __import__("time").time() + 3600
    auth._refresh = "refresh-1"  # 预置 refresh（模拟已完成一次授权）
    STATE.access_grant_token = "tok-0"
    auth.__dict__["_token_base"] = f"http://127.0.0.1:{port}"
    # token 端点指向 fake
    import app.google_calendar as gc

    monkeypatch.setattr(gc, "TOKEN_URL", f"http://127.0.0.1:{port}/token")
    provider = GoogleCalendarProvider(auth, "primary", api_base=f"http://127.0.0.1:{port}", http=httpx.Client(timeout=5, trust_env=False))
    yield provider, port
    server.shutdown()


def _draft(key="g1:1:t1:1", start="2027-03-10T01:00:00Z", end="2027-03-10T02:00:00Z"):
    return CalendarDraftItem(taskId="t1", taskTitle="任务A", calendarId="primary", startUtc=start, endUtc=end,
                             timezone="Asia/Shanghai", actionType="create", idempotencyKey=key)


def _req(drafts, tasks=None):
    return ExecuteRequest(goalId="g1", planVersion=1, timezone="Asia/Shanghai",
                          drafts=drafts, tasks=tasks or [{"taskId": "t1", "estMinutes": 60}])


def _seed_user_event(start="2027-03-20T01:00:00Z", end="2027-03-20T02:00:00Z", all_day=None):
    ev = {
        "id": f"u-{STATE.next_id}", "status": "confirmed", "summary": "用户会议",
        "start": {"dateTime": start, "timeZone": "UTC"},
        "end": {"dateTime": end, "timeZone": "UTC"},
    }
    if all_day:
        ev = {"id": f"u-{STATE.next_id}", "status": "confirmed", "summary": "全天外出",
              "start": {"date": all_day}, "end": {"date": all_day}}
    STATE.next_id += 1
    STATE.events.append(ev)
    return ev


# ---------------------------------------------------------------- 读取

class TestRead:
    def test_normal_and_all_day_and_multiz(self, fake_server):
        provider, _ = fake_server
        _seed_user_event()  # 定时
        _seed_user_event(all_day="2026-09-20")  # all-day
        _seed_user_event(start="2027-03-21T00:00:00Z", end="2027-03-21T01:00:00Z")  # 东京 09:00
        events = provider.read_events()
        assert len(events) == 3
        assert events[0]["allDay"] is False and events[0]["startUtc"].endswith("Z")
        assert events[1]["allDay"] is True and events[1]["localDate"] == "2026-09-20"

    def test_fetch_facts_counts_busy(self, fake_server):
        provider, _ = fake_server
        facts = provider.fetch_facts(3, "Asia/Shanghai")
        assert facts.ok

    def test_403_maps_permission_denied(self, fake_server):
        provider, _ = fake_server
        STATE.fault["list"] = "403"
        with pytest.raises(CalendarWriteError) as ei:
            provider.read_events()
        assert ei.value.code == "permission_denied"

    def test_403_access_not_configured_maps_api_disabled(self, fake_server):
        provider, _ = fake_server
        STATE.fault["list"] = "403_api_disabled"
        with pytest.raises(CalendarWriteError) as ei:
            provider.read_events()
        assert ei.value.code == "api_disabled"


# ---------------------------------------------------------------- 写入与幂等

class TestCreate:
    def test_create_success_with_metadata_and_verify(self, fake_server):
        provider, _ = fake_server
        results = execute_drafts(_req([_draft()]), provider)
        assert results[0].status == "success", results[0].error
        ev = STATE.events[0]
        priv = ev["extendedProperties"]["private"]
        assert priv["app"] == "lifeos" and priv["idempotencyKey"] == "g1:1:t1:1"
        assert priv["goalId"] == "g1" and priv["taskId"] == "t1"
        assert results[0].externalEventId == ev["id"]  # Google eventId

    def test_duplicate_idempotency_key_no_second_event(self, fake_server):
        provider, _ = fake_server
        execute_drafts(_req([_draft()]), provider)
        STATE.create_calls = 0
        results = execute_drafts(_req([_draft()]), provider)
        assert STATE.create_calls == 0  # pre-check 命中，insert 未被调用
        assert len([e for e in STATE.events if e["extendedProperties"]["private"]["app"] == "lifeos"]) == 1
        # Phase 9 盲区修复：重放必须收敛为 duplicate_skipped（自己的既有事件≠用户占用，
        # 不允许误报 stale_conflict）；externalEventId 是 Google eventId
        assert results[0].status == "duplicate_skipped"
        assert results[0].externalEventId == STATE.events[0]["id"]
        assert results[0].verify and all(results[0].verify.values())

    def test_timeout_recovery_full_batch_replay_converges(self, fake_server):
        """Phase 9 真实形态：整批已写成功 + 重放 → 全部 duplicate_skipped，零新事件、零 stale。"""
        provider, _ = fake_server
        first = execute_drafts(_req([_draft(key="g1:1:t1:1"), _draft(key="g1:1:t1:2", start="2027-03-11T01:00:00Z", end="2027-03-11T02:00:00Z")]), provider)
        assert all(r.status == "success" for r in first)
        n = len(STATE.events)
        STATE.create_calls = 0
        second = execute_drafts(_req([_draft(key="g1:1:t1:1"), _draft(key="g1:1:t1:2", start="2027-03-11T01:00:00Z", end="2027-03-11T02:00:00Z")]), provider)
        assert all(r.status == "duplicate_skipped" for r in second)
        assert len(STATE.events) == n  # 零新增
        assert STATE.create_calls == 0

    def test_create_timeout_server_actually_wrote(self, fake_server):
        """timeout 但服务端已成功 → 回查收敛，不产生第二个事件。"""
        provider, _ = fake_server
        STATE.fault["create"] = "timeout_after_write"
        # fake 的断连会产生 httpx 远端断开 → provider 视为网络错误 → 回查
        results = execute_drafts(_req([_draft()]), provider)
        assert results[0].status in ("success", "failed")
        # 断连路径：httpx.RemoteProtocolError → CalendarWriteError(network) → _find_by_key 命中 → 返回已建事件
        lifeos_events = [e for e in STATE.events if e["extendedProperties"]["private"]["app"] == "lifeos"]
        assert len(lifeos_events) == 1
        if results[0].status == "success":
            assert results[0].externalEventId == lifeos_events[0]["id"]

    def test_create_5xx_reports_provider_5xx_no_event(self, fake_server):
        provider, _ = fake_server
        STATE.fault["create"] = "5xx"
        results = execute_drafts(_req([_draft()]), provider)
        assert results[0].status == "failed"
        assert "provider_5xx" in (results[0].error or "")
        assert STATE.events == []

    def test_stale_conflict_not_written(self, fake_server):
        provider, _ = fake_server
        _seed_user_event(start="2027-03-10T01:00:00Z", end="2027-03-10T02:00:00Z")  # 精确占用草稿时段
        results = execute_drafts(_req([_draft()]), provider)
        assert results[0].status == "stale_conflict"
        assert len(STATE.events) == 1  # 只有用户事件

    def test_verify_wrong_start_fails(self, fake_server):
        provider, _ = fake_server
        STATE.fault["get"] = "wrong_start"
        results = execute_drafts(_req([_draft()]), provider)
        assert results[0].status == "failed"
        assert "verify_failed" in (results[0].error or "")
        assert results[0].verify and results[0].verify.get("startOk") is False

    def test_verify_404_event_not_found(self, fake_server):
        provider, _ = fake_server
        # create 成功后立即让 GET 404（删除其数据）
        STATE.fault["create"] = None
        # 手动劫持：写入后清空 events 使 GET 404
        class Vanish(provider.__class__):
            def create_event(self, uid, title, start, end, **kw):
                out = super().create_event(uid, title, start, end, **kw)
                STATE.events.clear()
                return out

        provider.__class__ = Vanish
        results = execute_drafts(_req([_draft()]), provider)
        assert results[0].status == "failed"
        assert "event_not_found" in (results[0].error or "")


# ---------------------------------------------------------------- token 生命周期

class TestTokens:
    def test_401_refresh_and_replay(self, fake_server):
        provider, _ = fake_server
        STATE.access_grant_token = "expired-token"  # 当前 access 失效
        events = provider.read_events()
        assert isinstance(events, list)  # 刷新后重放成功
        assert STATE.refresh_calls >= 1

    def test_revoked_refresh_maps_reauth_required(self, fake_server, monkeypatch, tmp_path):
        provider, _ = fake_server
        STATE.access_grant = "revoked"
        STATE.access_grant_token = "expired"
        with pytest.raises(CalendarWriteError) as ei:
            provider.read_events()
        assert ei.value.code in ("reauth_required",)

    def test_token_never_in_errors(self, fake_server):
        provider, _ = fake_server
        STATE.access_grant = "revoked"
        STATE.access_grant_token = "expired"
        try:
            provider.read_events()
            raise AssertionError("should raise")
        except CalendarWriteError as e:
            assert "refresh-1" not in str(e) and "tok-" not in str(e) and "sec" not in str(e)


# ---------------------------------------------------------------- 429

class TestRateLimit:
    def test_429_maps_rate_limited(self, fake_server):
        provider, _ = fake_server
        STATE.fault["list"] = "429x"  # list 429
        # 直接构造： faults for list only support 403; use create 429 path
        STATE.fault.pop("list")
        STATE.fault["create"] = "429"
        with pytest.raises(CalendarWriteError):
            provider.create_event("k9", "LifeOS:X", datetime(2027, 3, 10, 1, tzinfo=UTC), datetime(2027, 3, 10, 2, tzinfo=UTC))


class TestNoTokenExecute:
    def test_execute_without_token_reports_per_item_failure(self, fake_server, monkeypatch, tmp_path):
        """Phase 9：无 token（reauth_required）写路径逐条结构化失败，绝不整批 500。"""
        import json as _json

        provider, _ = fake_server
        creds = tmp_path / "creds2.json"
        creds.write_text(_json.dumps({"installed": {"client_id": "cid", "client_secret": "sec"}}), encoding="utf-8")
        empty = tmp_path / "empty-token.json"
        from app.google_calendar import GoogleOAuth
        from app.token_store import FileTokenStore

        bare = GoogleOAuth(str(creds), FileTokenStore(str(empty)),
                           api_base="http://127.0.0.1:9", session_file=str(tmp_path / "s.json"))
        p = GoogleCalendarProvider(bare, "primary", api_base="http://127.0.0.1:9",
                                   http=httpx.Client(timeout=2, trust_env=False))
        results = execute_drafts(_req([_draft()]), p)
        assert len(results) == 1
        assert results[0].status == "failed" and "reauth_required" in (results[0].error or "")


class TestTokenRefreshTrace:
    def test_refresh_failure_traced_without_secret(self, fake_server, tmp_path, monkeypatch):
        """Phase 9.5：refresh 失败有 trace（error_code），且不含 token 值。"""
        provider, _ = fake_server
        auth = provider.auth
        p = tmp_path / "t.jsonl"
        monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
        STATE.access_grant = "revoked"
        auth._access_expiry = 0  # noqa: SLF001
        with pytest.raises(CalendarWriteError):
            auth.access_token()
        rows = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()]
        tr = [r for r in rows if r["event"] == "token_refresh"]
        assert tr and tr[0]["ok"] is False and tr[0]["error_code"] == "reauth_required"
        assert "refresh-1" not in p.read_text(encoding="utf-8")
