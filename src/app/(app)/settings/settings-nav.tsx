"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui";

export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto lg:flex-col">
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={pathname === i.href ? "page" : undefined} className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm", pathname === i.href ? "bg-white font-medium text-brand-700 shadow-sm" : "text-slate-600 hover:bg-white")}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
