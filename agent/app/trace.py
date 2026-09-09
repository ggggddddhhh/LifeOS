"""Phase 9：结构化运行 trace（JSONL）。

铁律：
- 只记录 id/计数/状态/错误码/延迟等运行事实；goal/任务标题等用户内容不进 trace
- 双保险脱敏：secret 模式替换 + 任意字符串截断（80 字符）
- 字段值只允许标量（或标量 list/dict）；未知类型丢弃
- 失败静默（trace 永不影响主流程）
"""

from __future__ import annotations

import json
import os
import threading
from contextvars import ContextVar
from datetime import datetime, UTC
from pathlib import Path

_SECRET_MARKERS = ("ya29.", "GOCSPX-", "refresh-", "4/0A", "Bearer ", "client_secret")
_MAX_STR = 80
_lock = threading.Lock()

# Phase 9.5：请求级关联 ID（由 FastAPI 中间件从 x-run-id header 注入）
_run_id: ContextVar[str | None] = ContextVar("lifeos_run_id", default=None)


def set_run_id(run_id: str | None) -> None:
    _run_id.set((run_id or "")[:32] or None)


def current_run_id() -> str | None:
    return _run_id.get()


def _redact_str(s: str) -> str:
    low = s.lower()
    for marker in _SECRET_MARKERS:
        if marker.lower() in low:
            return "[REDACTED]"
    return s if len(s) <= _MAX_STR else s[:_MAX_STR] + "…"


def _sanitize(v):
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return _redact_str(v)
    if isinstance(v, list):
        return [_sanitize(x) for x in v[:20]]
    if isinstance(v, dict):
        return {str(k)[:40]: _sanitize(x) for k, x in list(v.items())[:20]}
    return f"<{type(v).__name__}>"  # 未知类型只留类型名


def trace(event: str, **fields) -> None:
    """追加一行 JSON。任何内部异常都吞掉（观测不伤主流程）。"""
    try:
        path = Path(os.environ.get("LIFEOS_TRACE_PATH") or "logs/agent-trace.jsonl")
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {"ts": datetime.now(UTC).isoformat(timespec="milliseconds"), "event": event[:64]}
        rid = current_run_id()
        if rid:
            row["runId"] = rid
        row.update({k: _sanitize(v) for k, v in fields.items()})
        line = json.dumps(row, ensure_ascii=False)
        with _lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:  # noqa: BLE001 —— trace 失败静默
        pass
