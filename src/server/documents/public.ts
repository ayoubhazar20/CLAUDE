import { prisma } from "../db";
import { hmac } from "../security/crypto";
import type { RequestMeta } from "../request";
import { scheduleHubSpotSync } from "../hubspot/sync";
import { notifyUser } from "../services/notifications";
import { automationEvent } from "./automation";
import { changeStatus, recordEvent } from "./events";
import { invalidateOpenChallenges } from "./otp";
import { resolveFromRows } from "./render-input";
import { OPEN_STATUSES, isForwardProgress } from "@/domain/status";

/**
 * Public (client) access to documents via the stable secure token /d/{token}.
 * No DealDocs account is required; the token is long, random and non-sequential.
 */
export const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9]{32}$/;

export async function findPublishedDocument(token: string) {
  if (!PUBLIC_TOKEN_PATTERN.test(token)) return null;
  const doc = await prisma.document.findUnique({ where: { publicToken: token } });
  if (!doc || !doc.publishedVersionId) return null;
  return doc;
}

/** Lazily mark overdue documents as expired (also done by a periodic job). */
export async function expireIfDue(doc: { id: string; organizationId: string; status: import("@prisma/client").DocumentStatus; type: import("@prisma/client").DocumentType; expiresAt: Date | null; ownerId: string; number: string; latestVersionNumber: number }) {
  if (!doc.expiresAt || doc.expiresAt > new Date() || !OPEN_STATUSES.includes(doc.status)) return false;
  const changed = await prisma.$transaction(async (tx) => {
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    if (!OPEN_STATUSES.includes(fresh.status)) return false;
    await changeStatus(tx, fresh, "EXPIRED", { type: "SYSTEM" }, null, { expiredAt: new Date() });
    await invalidateOpenChallenges(tx, doc.id);
    await recordEvent(tx, fresh, "EXPIRED", { type: "SYSTEM" }, null);
    await notifyUser({ organizationId: doc.organizationId, userId: doc.ownerId, type: "DOCUMENT_EXPIRED", title: `${doc.number} has expired`, body: `${doc.number} reached its expiration date without being completed.`, documentId: doc.id }, tx);
    return true;
  });
  return changed;
}

export async function expireDueDocuments() {
  const due = await prisma.document.findMany({
    where: { status: { in: OPEN_STATUSES }, expiresAt: { lt: new Date() }, archivedAt: null },
    take: 500,
  });
  for (const doc of due) await expireIfDue(doc);
  return due.length;
}

export async function loadPublicView(token: string) {
  let doc = await findPublishedDocument(token);
  if (!doc) return null;
  if (await expireIfDue(doc)) doc = (await findPublishedDocument(token))!;
  const [version, organization, recipients, attachments] = await Promise.all([
    prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.publishedVersionId! } }),
    prisma.organization.findUniqueOrThrow({ where: { id: doc.organizationId } }),
    prisma.documentRecipient.findMany({ where: { documentId: doc.id, removedAt: null }, orderBy: [{ signingOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.attachment.findMany({ where: { documentId: doc.id, visibility: "CLIENT", archivedAt: null }, include: { file: { select: { size: true, contentType: true } } }, orderBy: { createdAt: "asc" } }),
  ]);
  const [lineItems, signatures] = await Promise.all([
    prisma.documentLineItem.findMany({ where: { versionId: version.id }, orderBy: { position: "asc" } }),
    prisma.signature.findMany({ where: { versionId: version.id }, orderBy: { signedAt: "asc" } }),
  ]);
  const { resolved, input } = resolveFromRows({
    document: doc,
    version,
    lineItems,
    organization,
    recipients,
    signatures,
    logoUrl: organization.logoFileId ? `/d/${doc.publicToken}/logo` : null,
    imageUrl: (fileId) => `/d/${doc!.publicToken}/images/${fileId}`,
  });
  return { doc, version, organization, recipients, attachments, signatures, resolved, totals: input.totals };
}

const BOT_PATTERN = /bot|crawler|spider|preview|slurp|facebookexternalhit|slackbot|whatsapp|telegram|skypeuripreview|headlesschrome|lighthouse|pingdom|uptime|curl|wget|python-requests|go-http-client|node-fetch|monitor/i;

export function isAutomatedAgent(userAgent: string | null): boolean {
  return !userAgent || BOT_PATTERN.test(userAgent);
}

/**
 * Record a client view. Not counted: internal users of the organization,
 * bots/link previewers/monitors, PDF generation (never goes through here).
 */
export async function recordView(params: { token: string; visitorId: string; meta: RequestMeta; internalViewer: boolean }) {
  if (params.internalViewer || isAutomatedAgent(params.meta.userAgent)) return { counted: false };
  const doc = await findPublishedDocument(params.token);
  if (!doc) return { counted: false };
  const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.publishedVersionId! }, select: { versionNumber: true } });
  const visitorHash = hmac(params.visitorId, "visitor");
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    const seenBefore = await tx.documentView.findFirst({ where: { documentId: doc.id, visitorHash }, orderBy: { viewedAt: "desc" } });
    await tx.documentView.create({
      data: { organizationId: doc.organizationId, documentId: doc.id, versionNumber: version.versionNumber, visitorHash, ip: params.meta.ip, userAgent: params.meta.userAgent },
    });
    const firstView = !fresh.firstViewedAt;
    const nextStatus = isForwardProgress(fresh.status, "VIEWED") ? "VIEWED" : fresh.status;
    await changeStatus(tx, fresh, nextStatus, { type: "RECIPIENT", label: "Client", ip: params.meta.ip, userAgent: params.meta.userAgent }, version.versionNumber, {
      viewCount: { increment: 1 },
      uniqueViewCount: seenBefore ? undefined : { increment: 1 },
      firstViewedAt: fresh.firstViewedAt ?? now,
      lastViewedAt: now,
    });
    // One history entry per visitor per hour keeps the timeline readable.
    if (!seenBefore || now.getTime() - seenBefore.viewedAt.getTime() > 60 * 60 * 1000) {
      await recordEvent(tx, fresh, "VIEWED", { type: "RECIPIENT", label: "Client", ip: params.meta.ip, userAgent: params.meta.userAgent }, version.versionNumber, { uniqueVisitor: !seenBefore });
    }
    if (firstView) {
      await notifyUser(
        { organizationId: doc.organizationId, userId: doc.ownerId, type: "DOCUMENT_FIRST_VIEWED", title: `${doc.number} was viewed for the first time`, body: `${doc.clientName ?? "Your client"} opened ${doc.title} (${doc.number}).`, documentId: doc.id },
        tx,
      );
    }
    return { firstView, statusChanged: nextStatus !== fresh.status };
  });
  if (result.firstView || result.statusChanged) {
    await scheduleHubSpotSync(doc.id, doc.organizationId, result.statusChanged ? automationEvent(doc.type, "VIEWED") : null);
  }
  return { counted: true };
}
