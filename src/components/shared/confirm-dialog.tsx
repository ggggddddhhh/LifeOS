"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * destructive / external-write 统一确认对话。
 * 触发按钮文案与变体由调用方决定；确认操作必须在这里显式点「确认」。
 * 受控模式（open/onOpenChange）：程序化打开审阅类确认框（如 Replan 预览）时使用。
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "确认",
  destructive = false,
  busy = false,
  onConfirm,
  children,
  open,
  onOpenChange,
}: {
  trigger?: React.ReactElement;
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const dialog = (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {children}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={busy} />}>取消</DialogClose>
        <Button
          variant={destructive ? "destructive" : "default"}
          disabled={busy}
          onClick={onConfirm}
          autoFocus
        >
          {busy ? "处理中…" : confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  );

  if (open === undefined) {
    return (
      <Dialog>
        {trigger && <DialogTrigger render={trigger} />}
        {dialog}
      </Dialog>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {dialog}
    </Dialog>
  );
}
