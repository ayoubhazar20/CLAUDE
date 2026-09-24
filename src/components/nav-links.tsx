"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "./ui";

export interface NavItem {
  href: string;
  label: string;
  match?: string;
}

export function NavLinks({ items, unread }: { items: NavItem[]; unread: number }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const isActive = (item: NavItem) => {
    const [path, query] = item.href.split("?");
    if (query) {
      const params = new URLSearchParams(query);
      return pathname === path && [...params.entries()].every(([k, v]) => search.get(k) === v);
    }
    if (path === "/documents") return pathname.startsWith("/documents") && !search.get("type");
    return pathname === path || pathname.startsWith(`${path}/`);
  };
  return (
    <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={isActive(item) ? "page" : undefined}
          className={cn(
            "flex items-center justify-between whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium",
            isActive(item) ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100",
          )}
        >
          {item.label}
          {item.href === "/notifications" && unread > 0 ? (
            <span className="ml-2 rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white" aria-label={`${unread} unread`}>
              {unread}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
