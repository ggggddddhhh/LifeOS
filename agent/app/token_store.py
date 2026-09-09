"""Phase 8.5：Token 安全存储抽象。

- FileTokenStore：开发/本机（原子写）；生产 + LIFEOS_ENV=production 时 fail fast 禁用
- KeyringTokenStore：OS 凭据管理器（Windows Credential Manager / macOS Keychain）
- 按用户隔离：file 按 user_key 分文件；keyring 按 service 分命名空间；互不可见、绝不回退

token 记录（JSON dict）：
  {refreshToken, accountEmail, calendarId, scopes, obtainedAt}
旧格式 {refresh_token: str} 由 FileTokenStore 兼容读取。
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, UTC
from pathlib import Path
from typing import Protocol


def normalize_record(data: dict | None) -> dict | None:
    """旧格式迁移：{refresh_token} → 新 schema（绑定字段缺失=未知）。"""
    if not data:
        return None
    rt = data.get("refreshToken") or data.get("refresh_token")
    if not rt:
        return None
    return {
        "refreshToken": rt,
        "accountEmail": data.get("accountEmail") or "",
        "calendarId": data.get("calendarId") or "",
        "scopes": data.get("scopes") or [],
        "obtainedAt": data.get("obtainedAt") or datetime.now(UTC).isoformat(timespec="seconds"),
    }


class TokenStore(Protocol):
    def load(self) -> dict | None: ...
    def save(self, record: dict) -> None: ...
    def delete(self) -> None: ...


class FileTokenStore:
    """明文 JSON 文件（开发/本机）。生产环境必须换 KeyringTokenStore。"""

    def __init__(self, path: str):
        self.path = Path(path)

    def load(self) -> dict | None:
        try:
            return normalize_record(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return None

    def save(self, record: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # 原子写：先写同目录临时文件再替换，进程中断不会留下半截 token
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".token-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(record, f)
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def delete(self) -> None:
        try:
            self.path.unlink()
        except OSError:
            pass


class KeyringTokenStore:
    """OS 凭据管理器存储（生产推荐）。整个记录序列化为一个条目。"""

    def __init__(self, service: str):
        self.service = service
        self._kr = None

    def _keyring(self):
        if self._kr is None:
            try:
                import keyring  # 延迟 import：file 模式不强制依赖
            except ImportError as e:
                raise RuntimeError("LIFEOS_TOKEN_STORE=keyring 但未安装 keyring（pip install keyring）") from e
            self._kr = keyring
        return self._kr

    def load(self) -> dict | None:
        try:
            raw = self._keyring().get_password(self.service, "google_token")
        except Exception:  # noqa: BLE001 —— 后端不可用时如实返回未连接
            return None
        if not raw:
            return None
        try:
            return normalize_record(json.loads(raw))
        except ValueError:
            return None

    def save(self, record: dict) -> None:
        self._keyring().set_password(self.service, "google_token", json.dumps(record))

    def delete(self) -> None:
        try:
            self._keyring().delete_password(self.service, "google_token")
        except Exception:  # noqa: BLE001 —— 条目不存在等
            pass


def token_file_for_user(base_dir: str, user_key: str) -> str:
    """按用户分文件；default 保持旧路径（向后兼容既有授权）。"""
    if user_key == "default":
        return os.path.join(base_dir, ".google-token.json")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in user_key)
    return os.path.join(base_dir, f".google-token-{safe}.json")


def make_token_store(user_key: str = "default", *, env: dict | None = None) -> TokenStore:
    """按环境选择 store；生产 + 明文 → fail fast（禁止静默明文运行）。
    file 模式优先尊重显式 GOOGLE_TOKEN_FILE（默认用户专属路径，非 default 用户忽略之防串号）。"""
    e = env if env is not None else dict(os.environ)
    kind = e.get("LIFEOS_TOKEN_STORE", "file")
    if e.get("LIFEOS_ENV", "").lower() == "production" and kind != "keyring":
        raise RuntimeError(
            "生产环境禁止明文 token 存储：设置 LIFEOS_TOKEN_STORE=keyring（并提供 keyring 依赖）"
        )
    if kind == "keyring":
        return KeyringTokenStore(f"LifeOS:{user_key}")
    explicit = e.get("GOOGLE_TOKEN_FILE", "") if user_key == "default" else ""
    if explicit:
        return FileTokenStore(explicit)
    base_dir = e.get("LIFEOS_TOKEN_DIR") or e.get("GOOGLE_TOKEN_DIR") or "."
    return FileTokenStore(token_file_for_user(base_dir, user_key))
