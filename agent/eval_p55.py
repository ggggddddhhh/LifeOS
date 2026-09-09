"""Phase 5.5：GitHub × Calendar 双工具联合价值评测。

10 场景 × 四臂：A=无工具 / B=仅GitHub / C=仅Calendar / D=双工具。
真实 LLM，输出 docs/eval/p55-results.json。
期望谓词描述各场景「正确行为」（由 fixture 世界状态推导，非答案模板）。
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import date, timedelta

from app.calendar import DEFAULT_DAILY_WINDOW_MINUTES, StaticCalendarClient
from app.github import _norm
from app.graph import run_replan
from app.llm import OpenAICompatLLM
from app.schemas import DayBusy
from tests.test_github import FakeGithub, make_facts as gh_facts

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "eval", "p55-results.json")
W = DEFAULT_DAILY_WINDOW_MINUTES


def day(i: int, busy: int, events: int = 0, all_day: bool = False) -> DayBusy:
    return DayBusy(date=(date.today() + timedelta(days=i)).isoformat(), busy_minutes=busy, event_count=events, all_day_event=all_day)


class Exploding:
    def __init__(self, kind: str):
        self.kind = kind
        self.calls = 0

    def fetch_facts(self, *a, **kw):
        self.calls += 1
        raise RuntimeError(f"{self.kind} down")


# 任务集（中性措辞，避免与指标正则撞词；总量 1170min）
TASKS = [
    {"title": "实现核心 API", "status": "todo", "estMinutes": 300, "priority": 1},
    {"title": "实现前端页面", "status": "todo", "estMinutes": 300, "priority": 1},
    {"title": "集成测试", "status": "todo", "estMinutes": 180, "priority": 2},
    {"title": "编写部署脚本", "status": "todo", "estMinutes": 120, "priority": 2},
    {"title": "数据迁移", "status": "todo", "estMinutes": 180, "priority": 2},
    {"title": "用户文档", "status": "todo", "estMinutes": 90, "priority": 3},
]

GH_CLEAN = dict(open_issue_titles=["实现核心 API", "实现前端页面"], ci_conclusion="success")
GH_BEHIND = dict(
    open_issue_titles=["实现核心 API", "修复支付回调偶发失败", "订单导出内存溢出", "支持批量退款"],
    closed_issue_titles=["数据迁移"],
    prs=["实现核心 API（含鉴权重构）"],
    ci_conclusion="failure",
)
CAL_FREE = [day(i, 0, 0) for i in range(7)]
CAL_DENSE = [day(i, 660, 7) for i in range(7)]          # 推断 60/天
CAL_FOCAL = [day(i, 660, 6) for i in range(3)] + [day(i, 480, 3) for i in range(3, 5)]  # 3×60 + 2×240 = 660
CAL_MODERATE = [day(i, 360, 4) for i in range(7)]       # 推断 360/天

SCENARIOS = [
    {
        "key": "s1_ok_free", "type": "GH正常+CAL充足",
        "daysLeft": 7, "tasks": TASKS, "gh": GH_CLEAN, "cal": CAL_FREE,
        "risk": "none",
        "expect": lambda r: not r["progressRisk"] and not r["structuralChangeVsA"] and not r["falseCitation"],
        "forbidden": [r"CI[^成]{0,6}(失败|不通过|异常)", r"PR[^。]{0,10}(未合并|待合并|阻塞)"],
    },
    {
        "key": "s2_behind_free", "type": "GH落后+CAL充足",
        "daysLeft": 7, "tasks": TASKS, "gh": GH_BEHIND, "cal": CAL_FREE,
        "risk": "progress",
        "expect": lambda r: r["progressRisk"] and "数据迁移" in (r.get("observedDone") or []) and not r["capacityRisk"],
    },
    {
        "key": "s3_ok_tight", "type": "GH正常+CAL严重不足",
        "daysLeft": 6, "tasks": TASKS, "gh": GH_CLEAN, "cal": CAL_DENSE[:6],
        "risk": "capacity",
        "expect": lambda r: r["capacityRisk"] and not r["progressRisk"] and r["withinCapacity"],
        "forbidden": [r"CI[^成]{0,6}(失败|不通过|异常)", r"PR[^。]{0,10}(未合并|待合并|阻塞)"],
    },
    {
        "key": "s4_behind_tight", "type": "重点：GH落后+CAL不足",
        "daysLeft": 5, "tasks": TASKS, "gh": GH_BEHIND, "cal": CAL_FOCAL,
        "risk": "both",
        "expect": lambda r: r["progressRisk"] and r["capacityRisk"] and r["withinCapacity"]
        and r["dualDimension"] and "数据迁移" in (r.get("observedDone") or []),
    },
    {
        "key": "s5_ci_deadline", "type": "CI失败+临近Deadline",
        "daysLeft": 2, "tasks": TASKS, "gh": {**GH_BEHIND, "open_issue_titles": ["实现核心 API", "实现前端页面"], "prs": []}, "cal": CAL_MODERATE[:2],
        "risk": "both",
        "expect": lambda r: r["progressRisk"] and r["withinCapacity"],
    },
    {
        "key": "s6_pr_dense", "type": "PR阻塞+会议密集",
        "daysLeft": 5, "tasks": TASKS,
        "gh": {**GH_CLEAN, "prs": ["实现核心 API（含鉴权重构）"]},
        "cal": CAL_DENSE[:5],
        "risk": "both",
        "expect": lambda r: r["progressRisk"] and r["withinCapacity"],
    },
    {
        "key": "s7_declared_conflict", "type": "声明与CAL冲突",
        "daysLeft": 5, "tasks": TASKS, "gh": GH_CLEAN, "cal": [day(i, 600, 6) for i in range(5)],
        "declared": [480] * 5,
        "risk": "none",
        "expect": lambda r: r["conflictAnnotated"] and not r["capacityRisk"],
        "forbidden": [r"CI[^成]{0,6}(失败|不通过|异常)", r"PR[^。]{0,10}(未合并|待合并|阻塞)"],
    },
    {
        "key": "s8_status_conflict", "type": "GH事实与用户状态冲突",
        "daysLeft": 6,
        "tasks": [dict(t, status="done") if t["title"] == "实现核心 API" else t for t in TASKS],
        "gh": {**GH_CLEAN, "open_issue_titles": ["实现核心 API", "实现前端页面"]},
        "cal": CAL_FREE[:6],
        "risk": "conflict",
        "expect": lambda r: r["conflictAnnotated"] and not r["structuralChangeVsA"],
        "forbidden": [r"CI[^成]{0,6}(失败|不通过|异常)", r"PR[^。]{0,10}(未合并|待合并|阻塞)"],
    },
    {
        "key": "s9_gh_down", "type": "GH单独故障",
        "daysLeft": 5, "tasks": TASKS, "gh": "EXPLODE", "cal": CAL_DENSE[:5],
        "risk": "capacity",
        # 图级允许小幅超出（TS 硬守卫兜底到 ≤cap，已有专项单测）；核心是：不失败、不编造、贴近容量
        "expect": lambda r: r["ok"] and r["totalEst"] <= r["capacityMinutes"] * 1.3 and not r["falseCitation"],
        "forbidden": [r"CI[^成]{0,6}(失败|不通过|异常)", r"PR[^。]{0,10}(未合并|待合并|阻塞)"],
    },
    {
        "key": "s10_both_down", "type": "双工具故障",
        "daysLeft": 5, "tasks": TASKS, "gh": "EXPLODE", "cal": "EXPLODE",
        "risk": "none",
        "expect": lambda r: r["ok"] and not r["falseCitation"] and not r["structuralChangeVsA"],
        "forbidden": [r"CI[^成]{0,6}(失败|不通过|异常)", r"PR[^。]{0,10}(未合并|待合并|阻塞)"],
    },
]

ARMS = ["A", "B", "C", "D"]


def run_arm(req, llm, gh, cal):
    t0 = time.monotonic()
    state = run_replan(req, llm, gh, cal)
    return state, round((time.monotonic() - t0) * 1000)


def arm_row(state, ms):
    tasks = state.get("tasks") or []
    cap = state.get("capacity") or {}
    progress = state.get("progress") or {}
    reason = state.get("reason", "")
    capacity = cap.get("capacity_minutes") or 0
    total = sum(t["estMinutes"] for t in tasks)
    return {
        "ok": state.get("error_code") is None,
        "latencyMs": ms,
        "taskCount": len(tasks),
        "totalEst": total,
        "capacityMinutes": capacity,
        "capacitySource": cap.get("source"),
        "verdict": progress.get("verdict"),
        "observedDone": progress.get("observed_done") or [],
        "conflicts": len(progress.get("conflicts") or []) + len(cap.get("conflicts") or []),
        "reason": reason,
        "reasonMentionsCapacity": bool(re.search(r"容量|空闲|可用|分钟上限", reason)),
        "reasonCitesGithub": bool(re.search(r"#\d+|issue|PR|CI", reason)),
    }


def main():
    base, key, model = os.environ.get("LLM_BASE_URL"), os.environ.get("LLM_API_KEY"), os.environ.get("LLM_MODEL")
    if not (base and key and model):
        print("缺少 LLM 环境变量")
        return 1
    llm = OpenAICompatLLM(base, key, model)

    results = []
    for scn in SCENARIOS:
        req = {
            "goalTitle": f"{scn['daysLeft']} 天内完成项目交付",
            "goalDescription": "repo:eval/p55",
            "daysLeft": scn["daysLeft"],
            "tasks": scn["tasks"],
        }
        if scn.get("declared"):
            req["declaredMinutesPerDay"] = scn["declared"]

        gh_factory = (lambda: Exploding("github")) if scn["gh"] == "EXPLODE" else (lambda: FakeGithub(gh_facts(**scn["gh"])))
        cal_factory = (lambda: Exploding("calendar")) if scn["cal"] == "EXPLODE" else (lambda: StaticCalendarClient(scn["cal"]))

        arms = {}
        for label, gh, cal in [
            ("A", None, None),
            ("B", gh_factory(), None),
            ("C", None, cal_factory()),
            ("D", gh_factory(), cal_factory()),
        ]:
            state, ms = run_arm(req, llm, gh, cal)
            arms[label] = arm_row(state, ms)

        a_titles = None
        base_total = arms["A"]["totalEst"]
        for label in ARMS:
            r = arms[label]
            if label == "A":
                r["structuralChangeVsA"] = False
            else:
                est_delta = abs(r["totalEst"] - base_total) / max(1, base_total)
                r["structuralChangeVsA"] = r["taskCount"] != arms["A"]["taskCount"] or est_delta > 0.25

        d = arms["D"]
        cap = d["capacityMinutes"]
        for label in ARMS:
            r = arms[label]
            r["progressRisk"] = r["verdict"] == "behind"
            r["capacityRisk"] = bool(cap) and r["reasonMentionsCapacity"] and base_total > cap  # 提及容量且确实紧张
            r["withinCapacity"] = (not cap) or r["totalEst"] <= cap + 30
            r["exceedsRealCapacity"] = bool(cap) and r["totalEst"] > cap + 30
            forbidden = scn.get("forbidden") or []
            r["falseCitation"] = any(re.search(p, r["reason"]) for p in forbidden) if forbidden else False
            r["expansion"] = r["taskCount"] > len([t for t in scn["tasks"] if t["status"] != "done"]) + 1
        for label in ARMS:
            arms[label]["conflictAnnotated"] = "冲突" in arms[label]["reason"]
            arms[label]["dualDimension"] = arms[label]["reasonCitesGithub"] and arms[label]["reasonMentionsCapacity"]

        expect_ok = None
        try:
            expect_ok = bool(scn["expect"](d))
        except Exception:
            expect_ok = False

        row = {
            "key": scn["key"], "type": scn["type"], "risk": scn["risk"],
            "arms": arms, "expectMet_D": expect_ok,
        }
        results.append(row)
        print(
            f"[{scn['key']}] {scn['type']}: expect(D)={expect_ok} | "
            + " ".join(
                f"{l}:total={arms[l]['totalEst']}/cap={arms[l]['capacityMinutes']}/behind={arms[l]['progressRisk']}/capRisk={arms[l]['capacityRisk']}"
                for l in ARMS
            )
        )

    def agg(fn):
        return sum(1 for r in results if fn(r))

    n = len(results)
    summary = {
        "ranAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": model,
        "scenarios": n,
        "llmCalls": n * 4,
        "okRateAllArms": sum(1 for r in results for l in ARMS if r["arms"][l]["ok"]) / (n * 4),
        "expectMetRate_D": agg(lambda r: r["expectMet_D"]) / n,
        "dualDimensionOnlyInD": agg(lambda r: r["arms"]["D"]["dualDimension"] and not (r["arms"]["B"]["dualDimension"] or r["arms"]["C"]["dualDimension"])) / n,
        "B_exceedsRealCapacityRate": agg(lambda r: r["arms"]["B"]["exceedsRealCapacity"]) / n,
        "D_withinCapacityRate": agg(lambda r: r["arms"]["D"]["withinCapacity"]) / n,
        "falseCitationArms": sum(r["arms"][l]["falseCitation"] for r in results for l in ARMS),
        "expansionArms": sum(r["arms"][l]["expansion"] for r in results for l in ARMS),
        "unnecessaryChangeS1_S10": agg(lambda r: r["key"] in ("s1_ok_free", "s10_both_down") and r["arms"]["D"]["structuralChangeVsA"]),
        "avgLatencyMs": sum(r["arms"][l]["latencyMs"] for r in results for l in ARMS) / (n * 4),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "results": results}, f, ensure_ascii=False, indent=2)
    print("\n== summary ==")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
