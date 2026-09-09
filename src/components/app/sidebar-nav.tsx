"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, ListTodo, Settings, Sparkles, Target } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Today", icon: Sparkles },
  { href: "/goals", label: "Goals", icon: Target },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/activity", label: "Activity", icon: ListTodo },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Desktop 侧栏导航（mobile 折叠为底部 Tab，见 app-shell）。 */
export function SidebarNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="主导航" className="flex gap-0.5 md:flex-col">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-150",
              "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active && "bg-muted text-foreground",
              "md:flex-none md:justify-start md:px-3",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="hidden md:inline">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
