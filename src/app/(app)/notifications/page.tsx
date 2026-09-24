import Link from "next/link";
import { requireOrgPage } from "@/server/auth/context";
import { listNotifications } from "@/server/services/notifications";
import { EmptyState, PageHeader, cn } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { relativeTime } from "@/lib/format";
import { markReadAction } from "@/app/actions/settings";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requireOrgPage();
  const items = await listNotifications(ctx.organizationId, ctx.user.id, 100);
  const unread = items.filter((n) => !n.readAt).length;
  return (
    <>
      <PageHeader title="Notifications" description={`${unread} unread`} actions={unread ? <InlineAction action={markReadAction}>Mark all as read</InlineAction> : null} />
      {items.length === 0 ? (
        <EmptyState title="You are all caught up" description="You will be notified when clients view, accept, sign or decline your documents." />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
          {items.map((n) => (
            <li key={n.id} className={cn("flex items-start justify-between gap-4 px-4 py-3", !n.readAt ? "bg-brand-50/40" : "")}>
              <div>
                <p className={cn("text-sm", !n.readAt ? "font-semibold" : "")}>{n.link ? <Link href={n.link} className="hover:underline">{n.title}</Link> : n.title}</p>
                {n.body ? <p className="mt-0.5 text-sm text-slate-600">{n.body}</p> : null}
                <p className="mt-0.5 text-xs text-slate-500">{relativeTime(n.createdAt)}</p>
              </div>
              {!n.readAt ? <InlineAction action={markReadAction} hidden={{ id: n.id }}>Mark read</InlineAction> : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
