import type { Goal, Task } from "@prisma/client";

/**
 * 并发冲突的稳定错误转换（Phase 13 稳定性验证发现 #3）：
 * 目标/任务在请求处理中途被删除（典型：用户在另一页面删除目标，而 replan 正在跑）
 * 时，Prisma 事务抛 P2025/P2003 —— 绝不允许把内部错误信息透传给用户，
 * 统一转换为稳定、可理解的 conflict/not_found 语义。
 */

const PRISMA_NOT_FOUND = ["P2025", "P2016"]; // 记录不存在 / 目标行缺失
const PRISMA_FK_VIOLATION = "P2003"; // 外键违规（引用的 goal/task 已被并发删除）

export interface StableError {
  status: number;
  message: string;
}

/** Prisma/未知错误 → 稳定错误；返回 null 表示不是并发删除类错误（按原逻辑处理）。 */
export function toStableConflictError(e: unknown): StableError | null {
  const err = e as { code?: string; message?: string; clientVersion?: unknown };
  if (err && typeof err.code === "string") {
    if (PRISMA_NOT_FOUND.includes(err.code)) {
      return { status: 404, message: "目标已被删除，请刷新页面" };
    }
    if (err.code === PRISMA_FK_VIOLATION) {
      return { status: 409, message: "目标刚被删除或有其他页面同时操作，请刷新后重试" };
    }
  }
  // 非结构化错误但消息含外键/不存在特征（防御：包装后的事务错误可能丢 code）
  const msg = e instanceof Error ? e.message : "";
  if (/Foreign key constraint failed/i.test(msg)) {
    return { status: 409, message: "目标刚被删除或有其他页面同时操作，请刷新后重试" };
  }
  return null;
}
