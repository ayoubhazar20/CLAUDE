import Link from "next/link";
import type { ReactNode } from "react";
import { logoutAction } from "@/app/actions/auth";
import { NavLinks, type NavItem } from "./nav-links";

export function AppShell({
  orgName,
  userName,
  userEmail,
  roleLabel,
  nav,
  unread,
  banner,
  isPlatformAdmin,
  children,
}: {
  orgName: string;
  userName: string;
  userEmail: string;
  roleLabel: string;
  nav: NavItem[];
  unread: number;
  banner?: ReactNode;
  isPlatformAdmin: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen lg:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="border-b border-slate-200 bg-white lg:fixed lg:inset-y-0 lg:w-60 lg:border-b-0 lg:border-r">
        <div className="flex h-14 items-center justify-between px-4 lg:h-16">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">
            Deal<span className="text-brand-600">Docs</span>
          </Link>
          <Link href="/notifications" className="relative rounded p-1 text-slate-600 hover:bg-slate-100 lg:hidden" aria-label={`Notifications (${unread} unread)`}>
            <BellIcon />
            {unread > 0 ? <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{unread}</span> : null}
          </Link>
        </div>
        <div className="hidden px-4 pb-3 lg:block">
          <p className="truncate text-sm font-medium text-slate-900" title={orgName}>{orgName}</p>
          <p className="text-xs text-slate-500">{roleLabel}</p>
        </div>
        <NavLinks items={nav} unread={unread} />
        <div className="hidden border-t border-slate-100 p-4 lg:absolute lg:inset-x-0 lg:bottom-0 lg:block">
          <p className="truncate text-sm font-medium">{userName}</p>
          <p className="truncate text-xs text-slate-500">{userEmail}</p>
          <div className="mt-2 flex items-center gap-3 text-xs">
            {isPlatformAdmin ? <Link href="/admin" className="text-brand-700 hover:underline">Platform admin</Link> : null}
            <form action={logoutAction}>
              <button type="submit" className="text-slate-600 hover:text-slate-900 hover:underline">Sign out</button>
            </form>
          </div>
        </div>
      </aside>
      <div className="flex-1 lg:pl-60">
        {banner}
        <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
