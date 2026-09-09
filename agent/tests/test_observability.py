"""Phase 9.5：runId 注入 / relstats 统计与对账 / token_refresh trace 测试。"""

from __future__ import annotations

import json

from app.relstats import daily_summary, percentile, reconcile, summarize
from app.trace import set_run_id, trace


class TestRunId:
    def test_header_injects_run_id_into_trace(self, api_client, tmp_path, monkeypatch):
        p = tmp_path / "t.jsonl"
        monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
        res = api_client.post("/v1/plan", headers={"x-run-id": "abc12345"},
                              json={"title": "测试目标", "deadline": "2026-10-01"})
        assert res.status_code == 200
        rows = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()]
        assert rows, "应有 trace 行"
        assert all(r.get("runId") == "abc12345" for r in rows), "中间件注入的 runId 应出现在每行"

    def test_no_header_no_run_id(self, api_client, tmp_path, monkeypatch):
        p = tmp_path / "t.jsonl"
        monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
        res = api_client.post("/v1/plan", json={"title": "测试目标", "deadline": "2026-10-01"})
        assert res.status_code == 200
        rows = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines()]
        assert all("runId" not in r for r in rows)

    def test_set_run_id_truncates(self, tmp_path, monkeypatch):
        p = tmp_path / "t.jsonl"
        monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
        set_run_id("x" * 100)
        trace("e")
        set_run_id(None)
        row = json.loads(p.read_text(encoding="utf-8"))
        assert len(row["runId"]) == 32


class TestRelstats:
    ROWS = [
        {"ts": "2026-09-09T01:00:00Z", "event": "replan", "ok": True, "latencyMs": 100, "runId": "a"},
        {"ts": "2026-09-09T02:00:00Z", "event": "replan", "ok": True, "latencyMs": 300, "runId": "b"},
        {"ts": "2026-09-09T03:00:00Z", "event": "replan", "ok": True, "latencyMs": 500, "runId": "c"},
        {"ts": "2026-09-09T04:00:00Z", "event": "replan", "ok": False, "error_code": "reauth_required", "runId": "d"},
        {"ts": "2026-09-09T05:00:00Z", "event": "calendar_tool", "ok": False, "error_code": "reauth_required"},
        {"ts": "2026-09-09T06:00:00Z", "event": "token_refresh", "ok": True, "latency_ms": 250},
        {"ts": "2026-09-09T07:00:00Z", "event": "cal_confirm", "ok": True,
         "summary": {"success": 4, "duplicate_skipped": 2, "stale_conflict": 1, "failed": 0}},
        {"ts": "2026-09-09T08:00:00Z", "event": "replan", "ok": True, "invariantBreach": True, "agentFallbackReason": "timeout"},
    ]

    def test_percentile(self):
        assert percentile([], 50) is None
        assert percentile([1, 2, 3, 4, 5], 50) == 3
        assert percentile([1, 2, 3, 4, 5], 95) == 5

    def test_summarize_metrics(self):
        s = summarize(self.ROWS)
        assert s["totalRows"] == 8
        assert s["ok"]["replan"] == 4 and s["fail"]["replan"] == 1
        assert s["latencyMs"]["replan"]["p50"] == 300 and s["latencyMs"]["replan"]["max"] == 500
        assert s["tokenRefresh"] == {"ok": 1, "fail": 0}
        assert s["writeOutcomes"]["duplicate_skipped"] == 2 and s["writeOutcomes"]["stale_conflict"] == 1
        assert s["invariantBreach"] == 1
        assert s["runIdCoverage"] == 0.5  # 4/8
        # replan 失败(04:00) 后有 ok(08:00) → 已恢复；calendar_tool 失败(05:00) 后无成功 → 未恢复
        assert s["unrecoverable"] == 1
        assert s["keyPathSuccess"]["replan"] == 0.8

    def test_daily_grouping(self):
        days = daily_summary(self.ROWS + [{"ts": "2026-09-10T01:00:00Z", "event": "plan", "ok": True}])
        assert set(days) == {"2026-09-09", "2026-09-10"}
        assert days["2026-09-10"]["totalRows"] == 1

    def test_reconcile_clean_and_dirty(self):
        g = [{"idempotencyKey": "k1", "eventId": "e1"}, {"idempotencyKey": "k2", "eventId": "e2"}]
        d = [{"idempotencyKey": "k1", "externalEventId": "e1"}, {"idempotencyKey": "k2", "externalEventId": "e2"}]
        assert reconcile(g, d)["clean"] is True

        g2 = g + [{"idempotencyKey": "k1", "eventId": "e9"}, {"idempotencyKey": "k3", "eventId": "e3"}]
        d2 = [{"idempotencyKey": "k1", "externalEventId": "wrong"}, {"idempotencyKey": "k2", "externalEventId": "e2"}]
        r = reconcile(g2, d2)
        assert r["clean"] is False
        assert list(r["duplicateKeys"]) == ["k1"]
        assert r["orphans"] == ["k3"]
        assert r["mismatched"][0]["idempotencyKey"] == "k1"
