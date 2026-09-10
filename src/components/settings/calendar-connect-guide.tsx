"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, FileJson, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/utils";

/** 一键复制按钮：复制成功后短暂显示「已复制」。 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非 https/localhost 环境回退（当前部署在 localhost，正常走 clipboard）
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`复制${label}`}
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        copied ? "border-success/30 bg-success/10 text-success" : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
      {copied ? "已复制" : "复制"}
    </button>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-xs font-medium leading-snug text-foreground">{title}</p>
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-2 py-1">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{text}</code>
      <CopyButton text={text} label={text} />
    </div>
  );
}

const ENV_SNIPPET = ["CALENDAR_PROVIDER=google", "GOOGLE_CREDENTIALS_FILE=google-credentials.json", "GOOGLE_CALENDAR_ID=primary"].join("\n");
const AUTH_CMD = "cd agent && .venv/Scripts/python.exe smoke_google.py";

/**
 * Google Calendar 连接引导：真实流程对齐 README 与 smoke_google.py。
 * 不触碰 OAuth 逻辑本身——只是把操作步骤讲清楚、做成可复制。
 * showIcsHint=false 用于已用 ICS 接入、仅升级 Google 的场景（ICS 备选提示不再需要）。
 */
export function CalendarConnectGuide({ showIcsHint = true }: { showIcsHint?: boolean }) {
  return (
    <div className="mt-3 space-y-3 rounded-lg border bg-muted/20 p-3.5">
      <p className="text-xs leading-relaxed text-muted-foreground">
        连接后 PlanShift 只读你的空闲容量，写入事件前始终需要你确认。整个过程约 5 分钟：
      </p>
      <ol className="space-y-3.5">
        <Step n={1} title="获取 Google 授权凭据">
          <p>
            打开{" "}
            <a
              href="https://console.cloud.google.com/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2 hover:opacity-80"
            >
              Google Cloud Console
              <ExternalLink className="size-3" aria-hidden />
            </a>
            ，创建一个 <span className="text-foreground">OAuth 客户端（类型选「桌面应用」）</span>
            ，下载 JSON 密钥文件，重命名为：
          </p>
          <CodeLine text="agent/google-credentials.json" />
          <p className="flex items-start gap-1">
            <FileJson className="mt-0.5 size-3 shrink-0" aria-hidden />
            该文件已被 gitignore，不会提交到仓库。
          </p>
        </Step>
        <Step n={2} title="在 agent/.env 末尾加入三行配置">
          <CodeLine text={ENV_SNIPPET} />
        </Step>
        <Step n={3} title="运行一次授权命令">
          <p className="flex items-start gap-1">
            <TerminalSquare className="mt-0.5 size-3 shrink-0" aria-hidden />
            在项目根目录运行（复制后粘贴到终端）：
          </p>
          <CodeLine text={AUTH_CMD} />
          <p>
            终端会打印一个 Google 授权链接 → 浏览器打开并登录授权 → 把浏览器跳转后的
            <span className="text-foreground"> 完整地址 </span>复制回终端回车即可。
          </p>
        </Step>
        <Step n={4} title="重启 Agent 并回到本页">
          <p>
            重启 Agent 服务（<code className="rounded bg-muted px-1 font-mono text-[11px]">npm run agent</code>），
            然后点右下角「刷新状态」——看到绿色的「已连接」就完成了。
          </p>
        </Step>
      </ol>
      {showIcsHint && (
        <p className="border-t pt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          只想先体验日历能力？不用连 Google：从任意日历软件导出 .ics 文件，在 agent/.env 设
          <code className="mx-1 rounded bg-muted px-1 font-mono text-[11px]">CAL_ICS_PATH=文件路径</code>
          即可以只读方式接入。
        </p>
      )}
    </div>
  );
}
