import Link from "next/link";
import { requirePlatformAdminPage } from "@/server/auth/context";
import { logoutAction } from "@/app/actions/auth";

const NAV = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/plans", label: "Plans" },
  { href: "/admin/usage", label: "Usage" },
  { href: "/admin/integrations", label: "HubSpot / Zapier" },
  { href: "/admin/documents", label: "Documents statistics" },
  { href: "/admin/health", label: "System health" },
  { href: "/admin/errors", label: "Errors" },
  { href: "/admin/audit", label: "Audit logs" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePlatformAdminPage();
  return (
    <div className="min-h-screen">
      <header className="bg-slate-900 text-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <Link href="/admin" className="font-bold">DealDocs <span className="font-normal text-slate-400">Platform administration</span></Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-slate-300">{user.email}</span>
            <form action={logoutAction}><button type="submit" className="underline">Sign out</button></form>
          </div>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2" aria-label="Platform administration">
          {NAV.map((n) => <Link key={n.href} href={n.href} className="whitespace-nowrap rounded px-2.5 py-1 text-sm text-slate-300 hover:bg-slate-800 hover:text-white">{n.label}</Link>)}
        </nav>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
