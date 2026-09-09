"""Phase 9.5：可靠性统计纯函数（audit 脚本与测试共用，零 IO）。

输入是 trace JSONL 解析后的 dict 行（agent + web 双侧混合）。
口径（与 EVAL 报告一致）：
- 不可恢复错误：reauth_required（需人工重授权）/ timeout（结果未知未收敛）
- 关键路径成功率：replan、cal_confirm 的 ok 率
"""

from __future__ import annotations

from collections import Counter, defaultdict

UNRECOVERABLE_CODES = {"reauth_required", "auth_rejected", "timeout"}


def percentile(sorted_vals: list[float], p: float) -> float | None:
    if not sorted_vals:
        return None
    k = min(len(sorted_vals) - 1, max(0, int(round((p / 100) * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def _lat(v) -> float | None:
    return v if isinstance(v, (int, float)) else None


def summarize(rows: list[dict]) -> dict:
    """单日（或全量）指标聚合。"""
    events = Counter(r.get("event", "?") for r in rows)
    ok = Counter(r["event"] for r in rows if r.get("ok") is True)
    fail = Counter(r["event"] for r in rows if r.get("ok") is False)

    lat: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        v = _lat(r.get("latencyMs", r.get("latency_ms")))
        if v is not None:
            lat[r.get("event", "?")].append(v)
    latency = {
        e: {"p50": percentile(sorted(v), 50), "p95": percentile(sorted(v), 95), "max": sorted(v)[-1], "n": len(v)}
        for e, v in lat.items()
    }

    fallbacks = Counter(r.get("agentFallbackReason") for r in rows if r.get("agentFallbackReason"))
    tool_fail = Counter(
        f"{r.get('event')}:{r.get('error_code') or (r.get('error') or '?')}" if r.get("event") in ("github_tool", "calendar_tool")
        else f"{r.get('event')}:{r.get('error_code', '?')}"
        for r in rows if r.get("ok") is False
    )
    token_refresh = {
        "ok": sum(1 for r in rows if r.get("event") == "token_refresh" and r.get("ok") is True),
        "fail": sum(1 for r in rows if r.get("event") == "token_refresh" and r.get("ok") is False),
    }
    breach = sum(1 for r in rows if r.get("invariantBreach"))
    run_id_rows = sum(1 for r in rows if r.get("runId"))

    # 写入结果聚合（web cal_confirm 的 summary dict；agent cal_execute 的 statuses dict）
    write_outcomes = Counter()
    for r in rows:
        s = r.get("summary") or r.get("statuses")
        if isinstance(s, dict) and r.get("event") in ("cal_confirm", "cal_execute"):
            for k, v in s.items():
                if isinstance(v, int):
                    write_outcomes[k] += v

    # 恢复判定（时序）：失败行之后同 event 是否出现过成功行（自愈/处置后恢复）
    ok_ts: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        if r.get("ok") is True:
            ok_ts[r.get("event", "?")].append(str(r.get("ts", "")))
    for lst in ok_ts.values():
        lst.sort()

    def _recovered_after(event: str, ts: str) -> bool:
        return any(t > ts for t in ok_ts.get(event, []))

    unrecoverable = 0
    for r in rows:
        code = r.get("error_code")
        bad_code = code in UNRECOVERABLE_CODES or (
            isinstance(r.get("error"), str) and any(c in r["error"] for c in UNRECOVERABLE_CODES))
        if bad_code and not _recovered_after(r.get("event", "?"), str(r.get("ts", ""))):
            unrecoverable += 1

    def rate(e: str) -> float | None:
        total = ok[e] + fail[e]
        return round(ok[e] / total, 4) if total else None

    return {
        "totalRows": len(rows),
        "events": dict(events),
        "ok": dict(ok),
        "fail": dict(fail),
        "latencyMs": latency,
        "fallbacks": dict(fallbacks),
        "failures": dict(tool_fail),
        "tokenRefresh": token_refresh,
        "writeOutcomes": dict(write_outcomes),
        "invariantBreach": breach,
        "runIdCoverage": round(run_id_rows / len(rows), 4) if rows else None,
        "unrecoverable": unrecoverable,
        "keyPathSuccess": {"replan": rate("replan"), "cal_confirm": rate("cal_confirm"), "cal_execute": rate("cal_execute")},
    }


def daily_summary(rows: list[dict]) -> dict[str, dict]:
    """按 UTC 日期分组聚合（ts 前 10 位）。"""
    by_day: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        ts = str(r.get("ts", ""))
        by_day[ts[:10] if len(ts) >= 10 else "unknown"].append(r)
    return {day: summarize(day_rows) for day, day_rows in sorted(by_day.items())}


def reconcile(google_events: list[dict], db_writes: list[dict]) -> dict:
    """Google lifeos 事件 ↔ DB CalendarWrite 对账。

    google_events: [{idempotencyKey, eventId}]（仅 lifeos 元数据事件）
    db_writes:     [{idempotencyKey, externalEventId}]（仅 status ∈ {success, duplicate_skipped}）
    """
    g_by_key: dict[str, list[str]] = defaultdict(list)
    for g in google_events:
        g_by_key[g["idempotencyKey"]].append(g["eventId"])
    d_by_key = {w["idempotencyKey"]: w["externalEventId"] for w in db_writes if w.get("externalEventId")}

    duplicate_keys = {k: v for k, v in g_by_key.items() if len(v) > 1}
    orphans = [k for k in g_by_key if k not in d_by_key]
    mismatched = [
        {"idempotencyKey": k, "db": d_by_key[k], "google": g_by_key[k]}
        for k, g in g_by_key.items() if k in d_by_key and d_by_key[k] not in g
    ]
    matched = sum(1 for k, g in g_by_key.items() if k in d_by_key and d_by_key[k] in g)
    return {
        "googleEvents": len(google_events),
        "dbWrites": len(d_by_key),
        "matched": matched,
        "duplicateKeys": duplicate_keys,
        "orphans": orphans,
        "mismatched": mismatched,
        "clean": not duplicate_keys and not orphans and not mismatched,
    }
