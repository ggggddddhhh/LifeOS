"use client";

import Link from "next/link";
import { SidebarNav } from "./sidebar-nav";
import { ThemeToggle } from "./theme-toggle";

/** App Shell：Desktop 左侧 Sidebar + 主区；Mobile 底部 Tab 栏。 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[220px] flex-col border-r bg-sidebar md:flex">
        <div className="flex h-14 items-center gap-2 px-4">
          <Link href="/" className="flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">L</span>
            <span className="text-sm font-semibold tracking-tight">LifeOS</span>
          </Link>
        </div>
        <div className="flex-1 px-2">
          <SidebarNav />
        </div>
        <div className="border-t p-3">
          <ThemeToggle />
        </div>
      </aside>

      {/* 主区 */}
      <div className="md:pl-[220px]">
        {/* Mobile 顶栏 */}
        <header className="sticky top-0 z-20 flex h-12 items-center justify-between border-b bg-background/90 px-4 backdrop-blur md:hidden">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded bg-primary text-[10px] font-bold text-primary-foreground">L</span>
            <span className="text-sm font-semibold">LifeOS</span>
          </Link>
          <ThemeToggle />
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 md:px-8 md:pb-12 md:pt-8">{children}</main>

        {/* Mobile 底部 Tab */}
        <nav aria-label="主导航" className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
          <SidebarNav />
        </nav>
      </div>
    </div>
  );
}
