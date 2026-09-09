"""Phase 9 dogfood harness：真实 Google Calendar + GitHub + DeepSeek 长跑验证。

分段幂等（状态存 logs/dogfood-state.json），走真实用户路径（Next API → agent → Google）。
用法：.venv/Scripts/python.exe scripts/dogfood-longrun.py <setup|occupy|cycle2|confirm2|resume|tokenfail|ghfail|audit>

段间由外部执行的动作（进程重启/token 删除恢复）见 PHASE9-DESIGN.md §3。
Google 直连仅用于：① 模拟用户手动占用日历（occupy，运维脚本非 Agent 路径）
② audit 对账读取。绝不删除/修改用户事件；LifeOS 测试事件留人工清理。
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx

BASE = "http://127.0.0.1:3000"
AGENT = "http://127.0.0.1:8000"
ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = ROOT / "logs" / "dogfood-state.json"
TOKEN_FILE = ROOT / "agent" / ".google-token.json"
CREDS_FILE = ROOT / "agent" / "google-credentials.json"
GOAL_PREFIX = "[DOGFOOD9]"


def die(msg: str) -> None:
    print(f"❌ {msg}")
    raise SystemExit(1)


def check(cond: bool, msg: str) -> None:
    print(("✅ " if cond else "❌ ") + msg)
    if not cond:
        raise SystemExit(1)


def load_state() -> dict:
    return json.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}


def save_state(s: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")


def api(method: str, path: str, body: dict | None = None, expect: int = 200) -> dict:
    r = httpx.request(method, f"{BASE}{path}", json=body, timeout=180)
    if r.status_code != expect:
        die(f"{method} {path} → {r.status_code}（期望 {expect}）: {r.text[:300]}")
    return r.json()


# ---------------- Google 直连（仅运维：占用模拟 / 对账读取）


def google_access() -> str:
    rec = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    refresh = rec.get("refreshToken") or rec.get("refresh_token")
    creds = json.loads(CREDS_FILE.read_text(encoding="utf-8"))["installed"]
    r = httpx.post("https://oauth2.googleapis.com/token", data={
        "client_id": creds["client_id"], "client_secret": creds["client_secret"],
        "refresh_token": refresh, "grant_type": "refresh_token"}, timeout=30)
    if r.status_code != 200:
        die(f"Google token 刷新失败: {r.status_code}")
    return r.json()["access_token"]


def google_events(tok: str) -> list[dict]:
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    till = (datetime.now(UTC) + timedelta(days=60)).isoformat().replace("+00:00", "Z")
    r = httpx.get("https://www.googleapis.com/calendar/v3/calendars/primary/events",
                  params={"timeMin": now, "timeMax": till, "singleEvents": "true", "maxResults": 250},
                  headers={"Authorization": f"Bearer {tok}"}, timeout=30)
    return r.json().get("items", [])


def lifeos_events(tok: str, goal_id: str) -> list[dict]:
    out = []
    for ev in google_events(tok):
        priv = (ev.get("extendedProperties") or {}).get("private") or {}
        if priv.get("app") == "lifeos" and priv.get("goalId") == goal_id:
            out.append(ev)
    return out


def iso_in_days(d: int) -> str:
    return (date.today() + timedelta(days=d)).isoformat()


# ---------------- 段


def seg_setup() -> None:
    r = api("POST", "/api/goals", {
        "title": f"{GOAL_PREFIX} 10 天内上线一个个人博客（dogfood 长跑） repo:octocat/Hello-World",
        "description": "dogfood 阶段可靠性验证目标，可随时删除",
        "deadline": iso_in_days(10),
    }, expect=201)
    goal = r["data"]
    gid = goal["id"]
    check(len(goal["tasks"]) >= 3, f"v1 计划生成 {len(goal['tasks'])} 个任务（GitHub 工具真实调用路径）")

    d = api("POST", f"/api/goals/{gid}/calendar/drafts")
    drafts = d["data"]["drafts"]
    check(len(drafts) >= 1, f"v1 草稿 {len(drafts)} 条")

    c = api("POST", f"/api/goals/{gid}/calendar/confirm")
    s = c["data"]["summary"]
    check(s["success"] == len(drafts), f"v1 写入 success={s['success']} / {len(drafts)}（failed={s['failed']}）")

    tok = google_access()
    evs = lifeos_events(tok, gid)
    check(len(evs) == s["success"], f"Google 日历 lifeos 事件数 {len(evs)} == DB success {s['success']}（1:1）")

    save_state({"goalId": gid, "v1DraftIds": [x["id"] for x in drafts], "v1Success": s["success"],
                "v1Keys": [x["idempotencyKey"] for x in drafts]})
    print(f"state: goalId={gid} revision=1")


def seg_occupy() -> None:
    st = load_state()
    # 取 v2 会用的时段：用第一个 v1 事件结束后 1 小时插入外部会议（模拟用户手动加会）
    tok = google_access()
    evs = sorted(lifeos_events(tok, st["goalId"]), key=lambda e: e["start"]["dateTime"])
    if not evs:
        die("无 v1 事件可参照")
    anchor = datetime.fromisoformat(evs[0]["start"]["dateTime"].replace("Z", "+00:00"))
    start = anchor + timedelta(hours=3)
    r = httpx.post("https://www.googleapis.com/calendar/v3/calendars/primary/events",
                   headers={"Authorization": f"Bearer {tok}"}, timeout=30, json={
                       "summary": "[外部占用] 临时会议（dogfood 模拟）",
                       "start": {"dateTime": start.isoformat().replace("+00:00", "Z"), "timeZone": "Asia/Shanghai"},
                       "end": {"dateTime": (start + timedelta(hours=2)).isoformat().replace("+00:00", "Z"), "timeZone": "Asia/Shanghai"},
                   })
    if r.status_code not in (200, 201):
        die(f"占用事件写入失败: {r.status_code} {r.text[:200]}")
    st["occupyStart"] = start.isoformat()
    st["occupyEnd"] = (start + timedelta(hours=2)).isoformat()
    save_state(st)
    print(f"✅ 外部占用事件已写入（运维脚本模拟用户行为，非 Agent 路径）: {st['occupyStart']} ~ {st['occupyEnd']}")


def _overlap(a1: str, a2: str, b1: str, b2: str) -> bool:
    return max(a1, b1) < min(a2, b2)


def seg_cycle2() -> None:
    st = load_state()
    gid = st["goalId"]
    g = api("GET", f"/api/goals/{gid}")["data"]
    first_task = next(t for t in g["tasks"] if t["status"] != "done")
    api("PATCH", f"/api/tasks/{first_task['id']}", {"status": "done"})
    print(f"✅ 完成任务（order={first_task['order']}）")

    r = api("POST", f"/api/goals/{gid}/replan")
    v2 = r["data"]["goal"]["revision"]
    check(v2 == 2, f"replan → v{v2}（reason 已入库，diff={ {k: len(r['data']['diff'][k]) for k in r['data']['diff']} }）")

    d = api("POST", f"/api/goals/{gid}/calendar/drafts")
    drafts = d["data"]["drafts"]
    check(len(drafts) >= 1, f"v2 草稿 {len(drafts)} 条")
    check(all(x["planVersion"] == 2 for x in drafts), "草稿全部属于 v2")

    all_drafts = api("GET", f"/api/goals/{gid}/calendar/drafts")["data"]["drafts"]
    alive_v1 = [x for x in all_drafts if x["id"] in st["v1DraftIds"] and x["status"] in ("pending_confirmation", "confirmed")]
    check(not alive_v1, "旧 v1 草稿已作废（不存在可误执行的 pending/confirmed）")

    if st.get("occupyStart"):
        clashes = [x for x in drafts
                   if _overlap(x["proposedStart"], x["proposedEnd"], st["occupyStart"], st["occupyEnd"])]
        check(not clashes, f"v2 草稿全部避开外部占用事件（冲突 {len(clashes)} 条）")

    st["v2Drafts"] = [{"id": x["id"], "key": x["idempotencyKey"]} for x in drafts]
    save_state(st)


def seg_confirm2() -> None:
    st = load_state()
    gid = st["goalId"]
    c = api("POST", f"/api/goals/{gid}/calendar/confirm")
    s = c["data"]["summary"]
    n = len(st["v2Drafts"])
    check(s["success"] + s["stale_conflict"] == n, f"v2 写入 success={s['success']} stale={s['stale_conflict']} / {n}")

    r2 = api("POST", f"/api/goals/{gid}/calendar/confirm", expect=400)
    check("没有待确认" in r2.get("error", ""), "重复确认被拒（pending 已清，无重复执行路径）")

    tok = google_access()
    evs = lifeos_events(tok, gid)
    keys = [((e.get("extendedProperties") or {}).get("private") or {}).get("idempotencyKey") for e in evs]
    check(len(keys) == len(set(keys)), "Google 事件 idempotencyKey 无重复")
    check(len(evs) == st["v1Success"] + s["success"], f"Google 累计 lifeos 事件 {len(evs)} == v1+v2 success 总和")


def seg_resume() -> None:
    """进程重启后执行：idempotency 跨进程 + 继续新一轮。"""
    st = load_state()
    gid = st["goalId"]
    r = api("POST", f"/api/goals/{gid}/calendar/confirm", expect=400)
    check("没有待确认" in r.get("error", ""), "重启后重放 confirm 安全（幂等，无重复写入）")

    g = api("GET", f"/api/goals/{gid}")["data"]
    t = next((x for x in g["tasks"] if x["status"] != "done"), None)
    if t:
        api("PATCH", f"/api/tasks/{t['id']}", {"status": "done"})
        api("POST", f"/api/goals/{gid}/replan")
        d = api("POST", f"/api/goals/{gid}/calendar/drafts")
        c = api("POST", f"/api/goals/{gid}/calendar/confirm")
        s = c["data"]["summary"]
        check(s["failed"] == 0, f"重启后新一轮 v3 写入 success={s['success']} failed=0")
        st["v3Success"] = s["success"]
    save_state(st)


def seg_tokenfail() -> None:
    """agent 已在无 token 状态（外部删 token + 重启）执行：降级断言。"""
    st = load_state()
    gid = st["goalId"]
    h = httpx.get(f"{AGENT}/v1/calendar/status", timeout=15).json()
    check(h.get("connected") is False, f"agent 状态感知 token 失效: {h}")

    d = api("POST", f"/api/goals/{gid}/calendar/drafts")
    check(d["ok"], "无 token 下 drafts 请求不崩（日历事实降级，任务可能已全部排期而空）")

    # graph 路径降级：直接 replan（真实 LLM + 无日历容量），日历工具 ok=false 但计划仍产出
    rr = httpx.post(f"{AGENT}/v1/replan", json={
        "goalTitle": "[DOGFOOD9] token 失效降级验证", "daysLeft": 5,
        "tasks": [{"title": "降级验证任务A", "status": "todo", "estMinutes": 90, "priority": 1},
                  {"title": "降级验证任务B", "status": "todo", "estMinutes": 120, "priority": 2}],
    }, timeout=180)
    check(rr.status_code == 200 and len(rr.json().get("tasks", [])) >= 1, "无 token 下 replan 仍产出计划（工具降级不崩）")

    # agent trace 应记录 calendar_tool ok=false（reauth_required）
    trace_p = ROOT / "agent" / "logs" / "agent-trace.jsonl"
    rows = [json.loads(x) for x in trace_p.read_text(encoding="utf-8").splitlines()] if trace_p.exists() else []
    degraded = [r for r in rows if r.get("event") == "calendar_tool" and r.get("ok") is False]
    check(len(degraded) >= 1, f"trace 记录日历工具降级 {len(degraded)} 次（error_code 示例: {degraded[-1].get('error_code') if degraded else 'n/a'}）")

    # 写路径探测：无 token 下 execute 如实逐条失败（reauth_required），不静默不伪造
    c = httpx.post(f"{AGENT}/v1/calendar/execute", json={
        "goalId": "tokenfail-probe", "planVersion": 1, "timezone": "Asia/Shanghai",
        "drafts": [{"taskId": "probe1", "taskTitle": "probe", "startUtc": "2027-06-01T01:00:00Z",
                     "endUtc": "2027-06-01T02:00:00Z", "timezone": "Asia/Shanghai",
                     "actionType": "create", "idempotencyKey": "tokenfail-probe:1:probe1:1"}],
        "tasks": [{"taskId": "probe1", "estMinutes": 60}],
    }, timeout=120)
    results = c.json().get("results", [])
    check(c.status_code == 200 and results and all(
        r["status"] == "failed" and "reauth_required" in (r.get("error") or "") for r in results),
        f"无 token 写入如实全失败（{results[0]['status']}: {(results[0].get('error') or '')[:60]}…）")


def seg_ghfail() -> None:
    r = api("POST", "/api/goals", {
        "title": f"{GOAL_PREFIX} 不存在的仓库降级验证 repo:dogfood/nonexistent-9x7q",
        "deadline": iso_in_days(7),
    }, expect=201)
    g = r["data"]
    check(len(g["tasks"]) >= 1, "GitHub 工具故障（404 repo）下计划仍产出（安全降级，无伪造引用）")
    save_state({**load_state(), "goal2Id": g["id"]})


def seg_audit() -> None:
    st = load_state()
    gid = st["goalId"]
    tok = google_access()
    evs = lifeos_events(tok, gid)
    gkeys = {}
    for e in evs:
        priv = (e.get("extendedProperties") or {}).get("private") or {}
        gkeys[priv.get("idempotencyKey")] = e["id"]

    data = api("GET", f"/api/goals/{gid}/calendar/drafts")["data"]
    # success 与 duplicate_skipped（超时恢复收敛形态）都代表"事件确实在日历上"
    writes = [w for w in data["writes"] if w["status"] in ("success", "duplicate_skipped")]
    dup = [k for k in gkeys if list(gkeys).count(k) > 1]
    unmatched = [w for w in writes if w["idempotencyKey"] not in gkeys or gkeys[w["idempotencyKey"]] != w["externalEventId"]]
    extra = [k for k in gkeys if k not in {w["idempotencyKey"] for w in writes}]
    check(not dup, f"Google 无重复 idempotencyKey（{len(gkeys)} 事件）")
    check(not unmatched, "DB success 写入 ↔ Google 事件 externalEventId 全部 1:1 匹配")
    check(not extra, f"无 DB 外的孤儿 LifeOS 事件（多余 {len(extra)}）")

    # 指标汇总（trace JSONL）
    stats = {"agent": _trace_stats(ROOT / "agent" / "logs" / "agent-trace.jsonl"),
             "web": _trace_stats(ROOT / "logs" / "web-trace.jsonl")}
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    print(f"ℹ️  人工清理：Google 日历中 {GOAL_PREFIX} 相关 lifeos 事件 {len(gkeys)} 个 + 外部占用事件 1 个；"
          f"DB goals {gid}{', ' + st['goal2Id'] if st.get('goal2Id') else ''}")


def _trace_stats(p: Path) -> dict:
    if not p.exists():
        return {"missing": True}
    rows = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
    by_event: dict = {}
    for r in rows:
        e = by_event.setdefault(r["event"], {"count": 0, "ok": 0, "fail": 0, "unknown": 0, "lat": [], "breach": 0, "fallback": []})
        e["count"] += 1
        if r.get("ok") is True:
            e["ok"] += 1
        elif r.get("ok") is False:
            e["fail"] += 1
        else:
            e["unknown"] += 1  # ok 字段缺失（如 cal_execute/cal_cancel 无布尔语义）不计失败
        lat = r.get("latencyMs", r.get("latency_ms"))
        if isinstance(lat, (int, float)):
            e["lat"].append(lat)
        if r.get("invariantBreach"):
            e["breach"] += 1
        if r.get("agentFallbackReason"):
            e["fallback"].append(r["agentFallbackReason"])
    out = {}
    for k, v in by_event.items():
        lat = sorted(v["lat"])
        out[k] = {
            "count": v["count"], "ok": v["ok"], "fail": v["fail"], "noOkField": v["unknown"],
            "p50": lat[len(lat) // 2] if lat else None,
            "max": lat[-1] if lat else None,
            "invariantBreach": v["breach"],
            "fallbacks": sorted(set(v["fallback"])),
        }
    return out


def main() -> int:
    seg = sys.argv[1] if len(sys.argv) > 1 else ""
    fns = {"setup": seg_setup, "occupy": seg_occupy, "cycle2": seg_cycle2, "confirm2": seg_confirm2,
           "resume": seg_resume, "tokenfail": seg_tokenfail, "ghfail": seg_ghfail, "audit": seg_audit}
    if seg not in fns:
        print(__doc__)
        return 2
    fns[seg]()
    print(f"—— 段 {seg} 完成 ——")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
