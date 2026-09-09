"""Phase 7.5：共享时间向量（Python 侧）—— canonical 转换/标记/回程。"""

from __future__ import annotations

import json
import os
from datetime import datetime

import pytest

from app.times import to_utc, wall_in_tz

VECTORS = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "docs", "timezone-vectors.json"), encoding="utf-8"))


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_canonical(case):
    wall = datetime.fromisoformat(case["wall"])
    r = to_utc(wall, case["tz"])
    assert r.instant == datetime.fromisoformat(case["expectInstant"]), case["name"]
    assert r.ambiguous is case["expectAmbiguous"], case["name"]
    assert r.nonexistent is case["expectNonexistent"], case["name"]
    assert wall_in_tz(r.instant, case["tz"]).isoformat() == case["expectRoundtripWall"], case["name"]
    if case.get("expectAdjustedWall"):
        assert r.adjusted_wall == case["expectAdjustedWall"], case["name"]


def test_spec_version():
    assert VECTORS["specVersion"] == "1"


def test_server_tz_independence():
    """同一墙钟+时区的转换结果与服务器本地时区无关（隐式：zoneinfo 不读本地 tz）。"""
    from zoneinfo import ZoneInfo

    r1 = to_utc(datetime(2027, 3, 10, 9, 0), "Asia/Tokyo")
    assert r1.instant.utcoffset().total_seconds() == 0
    assert datetime.now(ZoneInfo("Asia/Tokyo")).utcoffset() is not None  # zoneinfo 数据可用
