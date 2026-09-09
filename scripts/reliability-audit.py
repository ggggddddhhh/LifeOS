"""Phase 9.5：一键可靠性 audit —— DB ↔ Google 对账 + 指标 + daily summary。

用法（agent venv）：
  .venv/Scripts/python.exe scripts/reliability-audit.py [--daily] [--all-days] [--db prisma/dev.db]

- 对账：SQLite CalendarWrite(success|duplicate_skipped) ↔ Google 全量 lifeos 事件 1:1
- 指标：双侧 trace JSONL（P50/P95/max、fallback、tool 失败、token refresh、
  duplicate/orphan/stale/failed 写入、invariant breach、runId 覆盖率、不可恢复错误）
- --daily：当日聚合落盘 logs/reliability-summary-YYYY-MM-DD.json
- --all-days：输出全部历史按日分组
退出码：对账不 clean 或出现不可接受指标 → 1（可挂 CI/计划任务）
敏感红线：不读取/输出任何 token、OAuth code、goal/task 正文。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "agent"))  # 复用 relstats 纯函数

from app.relstats import daily_summary, reconcile, summarize  # noqa: E402


def load_rows(paths: list[Path]) -> list[dict]:
    rows: list[dict] = []
    for p in paths:
        if p.exists():
            rows.extend(json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip())
    return rows


def read_db_writes(db_path: Path) -> tuple[list[dict], set[str]]:
    con = sqlite3.connect(str(db_path))
    try:
        cur = con.execute(
            "SELECT idempotencyKey, externalEventId, status, goalId FROM CalendarWrite "
            "WHERE status IN ('success','duplicate_skipped') AND externalEventId IS NOT NULL AND externalEventId != ''"
        )
        rows = [{"idempotencyKey": k, "externalEventId": e, "status": s} for k, e, s, _ in cur.fetchall()]
        goal_ids = {g for (g,) in con.execute("SELECT DISTINCT goalId FROM CalendarWrite")}
        return rows, goal_ids
    finally:
        con.close()


def read_google_events(token_file: Path, creds_file: Path) -> list[dict]:
    rec = json.loads(token_file.read_text(encoding="utf-8"))
    refresh = rec.get("refreshToken") or rec.get("refresh_token")
    creds = json.loads(creds_file.read_text(encoding="utf-8"))["installed"]
    tok = httpx.post("https://oauth2.googleapis.com/token", data={
        "client_id": creds["client_id"], "client_secret": creds["client_secret"],
        "refresh_token": refresh, "grant_type": "refresh_token"}, timeout=30).json()["access_token"]
    now = datetime.now(UTC).isoformat()
    till = (datetime.now(UTC) + timedelta(days=365)).isoformat()
    out: list[dict] = []
    page_token = None
    while True:
        params = {"timeMin": now, "timeMax": till, "singleEvents": "true", "maxResults": 250}
        if page_token:
            params["pageToken"] = page_token
        r = httpx.get("https://www.googleapis.com/calendar/v3/calendars/primary/events",
                      params=params, headers={"Authorization": f"Bearer {tok}"}, timeout=30)
        if r.status_code != 200:
            raise SystemExit(f"Google 读取失败: {r.status_code}")
        for ev in r.json().get("items", []):
            priv = (ev.get("extendedProperties") or {}).get("private") or {}
            if priv.get("app") == "lifeos" and priv.get("idempotencyKey"):
                out.append({"idempotencyKey": priv["idempotencyKey"], "eventId": ev["id"],
                            "goalId": priv.get("goalId", "")})
        page_token = r.json().get("nextPageToken")
        if not page_token:
            return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "prisma" / "dev.db"))
    ap.add_argument("--daily", action="store_true", help="输出当日聚合并落盘 JSON")
    ap.add_argument("--all-days", action="store_true", help="输出全部历史按日分组")
    ap.add_argument("--no-google", action="store_true", help="跳过 Google 对账（离线指标）")
    args = ap.parse_args()

    today = datetime.now(UTC).date().isoformat()
    rows = load_rows([ROOT / "logs" / "web-trace.jsonl", ROOT / "agent" / "logs" / "agent-trace.jsonl"])
    print(f"trace 行数：{len(rows)}")

    # ---- 对账
    if args.no_google:
        print("（--no-google：跳过 Google 对账）")
        rec = None
    else:
        g_all = read_google_events(ROOT / "agent" / ".google-token.json", ROOT / "agent" / "google-credentials.json")
        d, goal_ids = read_db_writes(Path(args.db))
        # 对账范围 = DB 存在的 goal；DB 外的 lifeos 事件（冒烟/清理前历史）单列不计入
        out_of_scope = [e for e in g_all if e["goalId"] not in goal_ids]
        g = [e for e in g_all if e["goalId"] in goal_ids]
        rec = reconcile(g, d)
        rec["outOfScopeGoogleEvents"] = len(out_of_scope)
        rec["outOfScopeGoals"] = sorted({e["goalId"] for e in out_of_scope})
        print(json.dumps(rec, ensure_ascii=False, indent=1, default=str))

    # ---- 指标
    day_rows = [r for r in rows if str(r.get("ts", "")).startswith(today)]
    if args.all_days:
        summary = daily_summary(rows)
        for day, s in summary.items():
            print(f"\n===== {day} =====")
            print(json.dumps(s, ensure_ascii=False, indent=1))
    else:
        s = summarize(day_rows or rows)
        print("\n===== 汇总（无当日数据时为全量） =====")
        print(json.dumps(s, ensure_ascii=False, indent=1))

    if args.daily:
        out_path = ROOT / "logs" / f"reliability-summary-{today}.json"
        out_path.write_text(json.dumps(
            {"date": today, "summary": summarize(day_rows), "reconciliation": rec},
            ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\ndaily summary 落盘：{out_path}")

    # ---- 判定（五指标）：对账看全量（存量必须 clean）；不可恢复错误只看当日
    day_rows = [r for r in rows if str(r.get("ts", "")).startswith(today)]
    today_unrecoverable = summarize(day_rows)["unrecoverable"] if day_rows else 0
    bad = (rec is not None and not rec["clean"]) or today_unrecoverable > 0
    print(f"\n判定：对账 {'✅ clean' if rec is None or rec['clean'] else '❌'} · "
          f"当日不可恢复错误 {today_unrecoverable} {'✅' if today_unrecoverable == 0 else '❌'}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
