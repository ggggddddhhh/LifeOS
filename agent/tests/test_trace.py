"""Phase 9：trace 脱敏与格式测试（红线：token/code/敏感内容不落盘）。"""

from __future__ import annotations

import json

from app.trace import trace


def test_jsonl_format_and_fields(tmp_path, monkeypatch):
    p = tmp_path / "trace.jsonl"
    monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
    trace("plan", kind="plan", ok=True, llm_calls=1, tasks_out=5, latency_ms=123.4)
    rows = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines()]
    assert len(rows) == 1
    r = rows[0]
    assert r["event"] == "plan" and r["ok"] is True and r["llm_calls"] == 1
    assert "ts" in r and r["ts"].endswith("Z") is False or "ts" in r  # ISO 时间戳存在即可
    assert isinstance(r["latency_ms"], float)


def test_secret_patterns_redacted(tmp_path, monkeypatch):
    p = tmp_path / "trace.jsonl"
    monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
    trace("leak_probe", token="ya29.a0ARr5M", secret="GOCSPX-abc", refresh="refresh-xyz",
          code="4/0ATsMZq", header="Bearer abc.def", cs="client_secret=zzz")
    line = p.read_text(encoding="utf-8")
    assert "ya29" not in line and "GOCSPX" not in line and "4/0AT" not in line
    assert "refresh-xyz" not in line and "Bearer abc" not in line
    assert line.count("[REDACTED]") == 6


def test_long_strings_truncated_user_content_dropped(tmp_path, monkeypatch):
    p = tmp_path / "trace.jsonl"
    monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
    trace("big", note="x" * 300)
    row = json.loads(p.read_text(encoding="utf-8"))
    assert len(row["note"]) <= 82  # 80 + 省略号
    assert row["note"].endswith("…")


def test_nested_and_unknown_types(tmp_path, monkeypatch):
    p = tmp_path / "trace.jsonl"
    monkeypatch.setenv("LIFEOS_TRACE_PATH", str(p))
    trace("nested", statuses={"success": 2, "failed": 0}, codes=["timeout", "network"], obj=object())
    row = json.loads(p.read_text(encoding="utf-8"))
    assert row["statuses"] == {"success": 2, "failed": 0}
    assert row["codes"] == ["timeout", "network"]
    assert row["obj"] == "<object>"


def test_trace_failure_never_raises(tmp_path, monkeypatch):
    monkeypatch.setenv("LIFEOS_TRACE_PATH", str(tmp_path / "no-dir" / "sub" / "t.jsonl"))
    trace("plan", ok=True)  # 目录可创建，正常
    monkeypatch.setenv("LIFEOS_TRACE_PATH", "Z:\\invalid\\<path>\\t.jsonl")
    trace("plan", ok=True)  # 不可写路径也不抛
