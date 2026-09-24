import { prisma, type Tx } from "../db";
import { appUrl } from "../env";
import { queueEmail } from "../email/service";
import { renderEmailLayout, textToEmailHtml } from "../email/layout";

/**
 * Notifications: in-app rows + email. Channels are pluggable — Slack/Teams can
 * be added as further channels without changing callers.
 */
export type NotificationType =
  | "DOCUMENT_FIRST_VIEWED"
  | "QUOTE_ACCEPTED"
  | "QUOTE_REJECTED"
  | "CONTRACT_SIGNED"
  | "CONTRACT_REJECTED"
  | "DOCUMENT_EXPIRED"
  | "SIGNATURE_COMPLETED";

export async function notifyUser(
  params: { organizationId: string; userId: string; type: NotificationType; title: string; body?: string; documentId?: string | null; link?: string | null; email?: boolean },
  tx: Tx = prisma,
) {
  const notification = await tx.notification.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      type: params.type,
      title: params.title.slice(0, 300),
      body: params.body?.slice(0, 2000) ?? null,
      documentId: params.documentId ?? null,
      link: params.link ?? (params.documentId ? `/documents/${params.documentId}` : null),
    },
  });
  if (params.email !== false) {
    const user = await tx.user.findUnique({ where: { id: params.userId } });
    const org = await tx.organization.findUnique({ where: { id: params.organizationId } });
    if (user && user.status === "ACTIVE" && org) {
      await queueEmail(
        {
          organizationId: params.organizationId,
          documentId: params.documentId ?? null,
          kind: `NOTIFICATION_${params.type}`,
          to: [user.email],
          subject: params.title,
          html: renderEmailLayout({
            brandName: org.name,
            brandColor: org.brandColor,
            bodyHtml: textToEmailHtml(params.body ?? params.title),
            action: notification.link ? { label: "Open in DealDocs", url: appUrl(notification.link) } : undefined,
          }),
        },
        tx,
      );
      await tx.notification.update({ where: { id: notification.id }, data: { emailedAt: new Date() } });
    }
  }
  return notification;
}

export async function listNotifications(organizationId: string, userId: string, take = 50) {
  return prisma.notification.findMany({ where: { organizationId, userId }, orderBy: { createdAt: "desc" }, take });
}

export async function unreadCount(organizationId: string, userId: string) {
  return prisma.notification.count({ where: { organizationId, userId, readAt: null } });
}

export async function markNotificationsRead(organizationId: string, userId: string, ids?: string[]) {
  await prisma.notification.updateMany({
    where: { organizationId, userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
}
