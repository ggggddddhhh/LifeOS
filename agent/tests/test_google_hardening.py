"""Phase 8.5：Google Provider Hardening 故障注入测试。

矩阵：token 过期 / refresh 失效与撤销 / 瞬时 refresh 故障 / 429 退避重试（成功与耗尽）/
5xx 重试 / 网络中断 / CREATE 超时实际成功（回查也抖动）/ CREATE 超时未写（结果未知语义）/
state CSRF / 账号绑定（calendarId + accountEmail）/ disconnect / 用户隔离 / 生产明文门禁 /
错误提示（hint）与 token 不泄露。
"""

from __future__ import annotations

import json
import threading
import time
from http.server import ThreadingHTTPServer

import httpx
import pytest

import app.google_calendar as gc
from app.calendar_write import CalendarWriteError, execute_drafts
from app.google_calendar import GoogleCalendarProvider, GoogleOAuth
from app.token_store import FileTokenStore, KeyringTokenStore, make_token_store, token_file_for_user

from tests.test_google_provider import FakeGoogle, STATE, _draft, _req


@pytest.fixture()
def server(monkeypatch, tmp_path):
    STATE.__init__()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeGoogle)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    creds = tmp_path / "creds.json"
    creds.write_text(json.dumps({"installed": {"client_id": "cid", "client_secret": "sec"}}), encoding="utf-8")
    http = httpx.Client(timeout=5, base_url=f"http://127.0.0.1:{port}")
    monkeypatch.setenv("LIFEOS_GOOGLE_BACKOFF_BASE", "0.001")  # 测试退避近零
    monkeypatch.delenv("GOOGLE_CALENDAR_ID", raising=False)
    monkeypatch.setattr(gc, "TOKEN_URL", f"http://127.0.0.1:{port}/token")
    monkeypatch.setattr(gc, "REVOKE_URL", f"http://127.0.0.1:{port}/revoke")

    def make_auth(token_path):
        a = GoogleOAuth(str(creds), str(token_path), http=http,
                        api_base=f"http://127.0.0.1:{port}", session_file=str(tmp_path / "session.json"))
        a._access = "tok-0"  # noqa: SLF001 —— 直接注入有效 access（绕过授权）
        a._access_expiry = time.time() + 3600  # noqa: SLF001
        a._refresh = "refresh-1"  # noqa: SLF001
        return a

    no_proxy = httpx.Client(timeout=5, trust_env=False)
    auth = make_auth(tmp_path / "token.json")
    STATE.access_grant_token = "tok-0"
    provider = GoogleCalendarProvider(auth, "primary", api_base=f"http://127.0.0.1:{port}", http=no_proxy)
    yield provider, auth, port, tmp_path, make_auth
    srv.shutdown()


# ---------------------------------------------------------------- OAuth state / PKCE

class TestOAuthState:
    def test_state_mismatch_rejected_no_token_persisted(self, server):
        _, _, _, tmp_path, make_auth = server
        auth2 = make_auth(tmp_path / "t2.json")
        auth2._refresh = None  # noqa: SLF001 —— 模拟未授权
        _, state = auth2.begin_authorization()
        with pytest.raises(CalendarWriteError) as ei:
            auth2.exchange_code("some-code", state="forged-state")
        assert ei.value.code == "auth_failed"  # CSRF 拦截，未发起交换
        assert not (tmp_path / "t2.json").exists()

    def test_expired_session_rejected(self, server):
        _, _, _, tmp_path, make_auth = server
        auth2 = make_auth(tmp_path / "t2.json")
        auth2._refresh = None  # noqa: SLF001
        auth2.begin_authorization()
        # 手动把会话改成已过期
        session_file = tmp_path / "session.json"
        data = json.loads(session_file.read_text(encoding="utf-8"))
        data["expiresAt"] = time.time() - 1
        session_file.write_text(json.dumps(data), encoding="utf-8")
        with pytest.raises(CalendarWriteError) as ei:
            auth2.exchange_code("some-code", state=data["state"])
        assert ei.value.code == "auth_failed"

    def test_exchange_with_state_binds_account_and_consumes_session(self, server):
        _, _, _, tmp_path, make_auth = server
        STATE.primary_email = "user@example.test"
        auth2 = make_auth(tmp_path / "t2.json")
        auth2._refresh = None  # noqa: SLF001
        _, state = auth2.begin_authorization()
        auth2.exchange_code("4/fake-code", state=state)
        rec = auth2.record
        assert rec["accountEmail"] == "user@example.test"
        assert rec["calendarId"] == "primary"
        assert not (tmp_path / "session.json").exists()  # 一次性
        # 同一 provider connect 通过（远端账号与记录一致）
        p2 = GoogleCalendarProvider(auth2, "primary", api_base=f"http://127.0.0.1:{server[2]}")
        assert p2.connect()["accountEmail"] == "user@example.test"


# ---------------------------------------------------------------- token 生命周期

class TestTokenLifecycle:
    def test_refresh_rejected_clears_store_no_revival(self, server):
        _, auth, _, tmp_path, _ = server
        STATE.access_grant = "revoked"
        STATE.access_grant_token = "expired"
        auth._access_expiry = 0  # noqa: SLF001 —— 强制走 refresh
        with pytest.raises(CalendarWriteError) as ei:
            auth.access_token()
        assert ei.value.code == "reauth_required"
        assert not (tmp_path / "token.json").exists()  # 磁盘清除，防下次启动"复活"
        with pytest.raises(CalendarWriteError) as ei2:
            auth.access_token()
        assert ei2.value.code == "reauth_required"

    def test_refresh_transient_5xx_keeps_store(self, server):
        _, auth, _, tmp_path, _ = server
        auth._persist()  # 先落库（模拟已授权状态）
        STATE.token_fault = "5xx_once"
        auth._access_expiry = 0  # noqa: SLF001
        with pytest.raises(CalendarWriteError) as ei:
            auth.access_token()
        assert ei.value.code == "provider_5xx"  # 瞬时：不清库
        assert (tmp_path / "token.json").exists()
        assert auth.access_token().startswith("tok-")  # 下次成功

    def test_auth_invalid_when_rejected_after_refresh(self, server):
        provider, auth, _, tmp_path, _ = server
        STATE.access_grant_token = "expired"
        STATE.reject_after_refresh = True  # 刷新拿到的 token 仍被 API 拒绝
        with pytest.raises(CalendarWriteError) as ei:
            provider.read_events()
        assert ei.value.code == "auth_invalid"
        assert (tmp_path / "token.json").exists()  # refresh 仍有效，不删


# ---------------------------------------------------------------- 读重试与退避

class TestReadRetry:
    def test_429_twice_then_success(self, server):
        provider, _, _, _, _ = server
        STATE.fault["list"] = "429_n2"
        assert isinstance(provider.read_events(), list)
        assert STATE.list_calls == 3  # 2×429（Retry-After:0）+ 1 成功，上限 3 次

    def test_429_forever_exhausts_at_limit(self, server):
        provider, _, _, _, _ = server
        STATE.fault["list"] = "429_forever"
        with pytest.raises(CalendarWriteError) as ei:
            provider.read_events()
        assert ei.value.code == "rate_limited"
        assert STATE.list_calls == 3  # 不无限重试

    def test_5xx_once_then_success(self, server):
        provider, _, _, _, _ = server
        STATE.fault["list"] = "5xx_n1"
        assert isinstance(provider.read_events(), list)
        assert STATE.list_calls == 2

    def test_network_interruption_classified_with_hint(self, server):
        provider, _, _, _, _ = server
        dead = GoogleCalendarProvider(provider.auth, "primary", api_base="http://127.0.0.1:9",
                                      http=httpx.Client(timeout=2, trust_env=False))
        with pytest.raises(CalendarWriteError) as ei:
            dead.read_events()
        # 拒绝=network / 挂起=timeout：传输层故障必须落入稳定码并带提示
        assert ei.value.code in ("network", "timeout")
        facts = dead.fetch_facts(3, "Asia/Shanghai")
        assert facts.ok is False and ei.value.code in facts.error


# ---------------------------------------------------------------- CREATE 超时与幂等

class TestCreateTimeout:
    def test_timeout_server_wrote_recovery_read_also_flaky(self, server):
        """实际成功 + 响应断连 + 回查首次 5xx：退避重试后收敛，绝不第二个事件。"""
        provider, _, _, _, _ = server
        STATE.fault["create"] = "timeout_after_write"
        STATE.fault["list"] = "5xx_n1"  # 回查（含 pre-check GET）也抖一次
        results = execute_drafts(_req([_draft()]), provider)
        lifeos = [e for e in STATE.events if e["extendedProperties"]["private"]["app"] == "lifeos"]
        assert len(lifeos) == 1
        assert results[0].status == "success"
        assert results[0].externalEventId == lifeos[0]["id"]

    def test_timeout_unconfirmed_when_not_written(self, server):
        """未写 + 断连 + 回查未命中 → '结果未知'语义（timeout 码 + 提示），非盲目重发。"""
        provider, _, _, _, _ = server
        STATE.fault["create"] = "timeout_no_write"
        results = execute_drafts(_req([_draft()]), provider)
        assert results[0].status == "failed"
        assert "timeout" in (results[0].error or "")
        assert "提示" in (results[0].error or "")
        assert STATE.events == []


# ---------------------------------------------------------------- 账号绑定（防串号）

class TestAccountBinding:
    def test_calendar_id_mismatch_rejected(self, server):
        _, _, port, tmp_path, make_auth = server
        store = FileTokenStore(str(tmp_path / "t3.json"))
        store.save({"refreshToken": "refresh-1", "accountEmail": "a@x.test",
                    "calendarId": "other@group.calendar.google.com", "scopes": [], "obtainedAt": "2026"})
        auth3 = GoogleOAuth(str(tmp_path / "creds.json"), store,
                            api_base=f"http://127.0.0.1:{port}", session_file=str(tmp_path / "s3.json"))
        p3 = GoogleCalendarProvider(auth3, "primary", api_base=f"http://127.0.0.1:{port}")
        with pytest.raises(CalendarWriteError) as ei:
            p3.read_events()  # 本地即可判定，不发请求
        assert ei.value.code == "account_mismatch"
        assert STATE.list_calls == 0

    def test_account_email_mismatch_on_connect(self, server):
        _, auth, port, _, _ = server
        STATE.primary_email = "someone-else@example.test"
        auth._record = {"refreshToken": auth._refresh, "accountEmail": "user@example.test",  # noqa: SLF001
                        "calendarId": "primary", "scopes": [], "obtainedAt": "2026"}
        p = GoogleCalendarProvider(auth, "primary", api_base=f"http://127.0.0.1:{port}")
        with pytest.raises(CalendarWriteError) as ei:
            p.connect()
        assert ei.value.code == "account_mismatch"

    def test_binding_mismatch_degrades_fetch_facts_not_crash(self, server):
        _, auth, port, _, _ = server
        auth._record = {"refreshToken": auth._refresh, "accountEmail": "",  # noqa: SLF001
                        "calendarId": "another-cal", "scopes": [], "obtainedAt": "2026"}
        p = GoogleCalendarProvider(auth, "primary", api_base=f"http://127.0.0.1:{port}")
        facts = p.fetch_facts(3, "Asia/Shanghai")
        assert facts.ok is False and "account_mismatch" in facts.error


# ---------------------------------------------------------------- disconnect / reconnect

class TestDisconnect:
    def test_revokes_and_clears_local(self, server):
        _, auth, _, tmp_path, _ = server
        out = auth.disconnect()
        assert out["revoked"] is True and STATE.revoke_calls == 1
        assert auth.status()["connected"] is False
        assert not (tmp_path / "token.json").exists()

    def test_revoke_failure_still_clears_local_with_warning(self, server):
        _, auth, _, tmp_path, _ = server
        STATE.revoke_status = 503
        out = auth.disconnect()
        assert out["revoked"] is False and out["warning"]
        assert not (tmp_path / "token.json").exists()  # 用户意图优先

    def test_reconnect_via_new_authorization(self, server):
        _, _, _, tmp_path, make_auth = server
        STATE.primary_email = "user@example.test"
        auth2 = make_auth(tmp_path / "t4.json")
        auth2._refresh = None  # noqa: SLF001
        auth2.disconnect()  # 断开（无 token 也安全）
        _, state = auth2.begin_authorization()  # reconnect = 新授权
        auth2.exchange_code("4/code-2", state=state)
        assert auth2.status()["connected"] is True


# ---------------------------------------------------------------- 用户隔离 / 生产门禁

class TestIsolationAndGate:
    def test_stores_isolated_per_user(self, tmp_path):
        a = make_token_store("alice", env={"LIFEOS_TOKEN_DIR": str(tmp_path)})
        b = make_token_store("bob", env={"LIFEOS_TOKEN_DIR": str(tmp_path)})
        a.save({"refreshToken": "rt-alice", "accountEmail": "a@x", "calendarId": "primary",
                "scopes": [], "obtainedAt": "t"})
        assert b.load() is None  # 互不可见
        assert a.load()["refreshToken"] == "rt-alice"
        b.save({"refreshToken": "rt-bob", "accountEmail": "b@x", "calendarId": "primary",
                "scopes": [], "obtainedAt": "t"})
        assert a.load()["refreshToken"] == "rt-alice"  # 不串号

    def test_empty_store_never_falls_back(self, server):
        _, _, _, tmp_path, _ = server
        auth5 = GoogleOAuth(str(tmp_path / "creds.json"), FileTokenStore(str(tmp_path / "t5.json")),
                            api_base="http://127.0.0.1:9", session_file=str(tmp_path / "s5.json"))
        with pytest.raises(CalendarWriteError) as ei:
            auth5.access_token()
        assert ei.value.code == "reauth_required"  # 空 store 不借用他人 token

    def test_default_user_keeps_legacy_path_others_namespaced(self, tmp_path):
        env = {"LIFEOS_TOKEN_DIR": str(tmp_path), "GOOGLE_TOKEN_FILE": str(tmp_path / "explicit.json")}
        assert str(make_token_store("default", env=env).path).endswith("explicit.json")  # 尊重显式路径
        p_bob = str(make_token_store("bob", env=env).path)
        assert p_bob.endswith(".google-token-bob.json")  # 非 default 用户忽略显式路径（防串号）
        assert token_file_for_user(str(tmp_path), "default").endswith(".google-token.json")  # 旧路径兼容

    def test_production_gate_blocks_plaintext(self):
        with pytest.raises(RuntimeError, match="明文"):
            make_token_store("default", env={"LIFEOS_ENV": "production"})
        make_token_store("default", env={"LIFEOS_ENV": "production", "LIFEOS_TOKEN_STORE": "keyring"})  # 不抛

    def test_keyring_store_roundtrip_isolated(self):
        class FakeKeyring:  # 内存后端（不依赖真实 keyring 安装）
            def __init__(self):
                self.data: dict[tuple[str, str], str] = {}

            def set_password(self, s, u, v):
                self.data[(s, u)] = v

            def get_password(self, s, u):
                return self.data.get((s, u))

            def delete_password(self, s, u):
                self.data.pop((s, u), None)

        fk = FakeKeyring()
        bob = KeyringTokenStore("LifeOS:bob")
        bob._kr = fk  # noqa: SLF001
        bob.save({"refreshToken": "rt-bob", "accountEmail": "b@x", "calendarId": "primary",
                  "scopes": [], "obtainedAt": "t"})
        assert bob.load()["refreshToken"] == "rt-bob"
        alice = KeyringTokenStore("LifeOS:alice")
        alice._kr = fk  # noqa: SLF001
        assert alice.load() is None  # service 命名空间隔离
        bob.delete()
        assert bob.load() is None


# ---------------------------------------------------------------- 提示与泄露断言

class TestHintsAndLeaks:
    def test_errors_carry_hint_but_never_secrets(self, server):
        provider, auth, _, tmp_path, _ = server
        # reauth 路径
        STATE.access_grant = "revoked"
        STATE.access_grant_token = "expired"
        auth._access_expiry = 0  # noqa: SLF001
        with pytest.raises(CalendarWriteError) as ei:
            provider.read_events()
        assert "提示" in str(ei.value)
        assert "refresh-1" not in str(ei.value) and "sec" not in str(ei.value) and "tok-" not in str(ei.value)
        # permission 路径
        STATE.access_grant = "ok"
        auth._access = "tok-0"  # noqa: SLF001
        auth._access_expiry = time.time() + 3600  # noqa: SLF001
        STATE.access_grant_token = "tok-0"
        STATE.fault["list"] = "403"
        with pytest.raises(CalendarWriteError) as ei2:
            provider.read_events()
        assert "提示" in str(ei2.value)
        assert "sec" not in str(ei2.value)

    def test_status_and_record_never_expose_refresh_token(self, server):
        _, auth, _, _, _ = server
        auth._record = {"refreshToken": "refresh-1", "accountEmail": "a@x",  # noqa: SLF001
                        "calendarId": "primary", "scopes": [], "obtainedAt": "t"}
        assert "refresh-1" not in json.dumps(auth.status())
        assert "refresh-1" not in json.dumps(auth.record)
