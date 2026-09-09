"""稳定结构化错误码。对外响应永不包含 Python traceback。"""

from __future__ import annotations

AGENT_INPUT_INVALID = "AGENT_INPUT_INVALID"        # 422 请求不符合 schema
AGENT_LLM_ERROR = "AGENT_LLM_ERROR"                # 502 LLM 返回非 2xx
AGENT_LLM_TIMEOUT = "AGENT_LLM_TIMEOUT"            # 502 LLM 超时
AGENT_PARSE_ERROR = "AGENT_PARSE_ERROR"            # 502 两次尝试均无法解析 JSON
AGENT_VALIDATION_ERROR = "AGENT_VALIDATION_ERROR"  # 502 两次尝试均未通过校验
AGENT_INTERNAL_ERROR = "AGENT_INTERNAL_ERROR"      # 500 未预期错误


class AgentError(Exception):
    """携带稳定错误码的异常；message 面向 TS 调用方，禁止包含 traceback。"""

    def __init__(self, code: str, message: str, status_code: int = 502, retryable: bool = True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.retryable = retryable
