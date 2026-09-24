import type { EmailTemplateKind } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { appUrl } from "../env";
import { audit } from "../audit";
import { ConflictError, ValidationError } from "../errors";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { enforceRateLimit } from "../security/rate-limit";
import { queueEmail } from "../email/service";
import { renderEmailLayout, textToEmailHtml } from "../email/layout";
import { recordUsage } from "../services/billing";
import { scheduleHubSpotSync } from "../hubspot/sync";
import { DEFAULT_EMAIL_TEMPLATES } from "../services/starter-content";
import { loadDocumentForEdit } from "./access";
import { changeStatus, recordEvent, userActor } from "./events";
import { buildResolveInput } from "./render-input";
import { automationEvent } from "./automation";
import { buildVariables } from "@/domain/resolve";
import { interpolate } from "@/domain/variables";
import { OPEN_STATUSES, isForwardProgress } from "@/domain/status";
import { PERMISSIONS } from "@/domain/permissions";

export type SendKind = "initial" | "reminder";

async function loadPublishedContext(ctx: OrgContext, documentId: string) {
  const doc = await loadDocumentForEdit(ctx, documentId);
  if (!doc.publishedVersionId) throw new ConflictError("Publish the document before sending it.");
  const [version, lines, organization, recipients] = await Promise.all([
    prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.publishedVersionId } }),
    prisma.documentLineItem.findMany({ where: { versionId: doc.publishedVersionId } }),
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
    prisma.documentRecipient.findMany({ where: { documentId: doc.id, removedAt: null }, orderBy: { signingOrder: "asc" } }),
  ]);
  const input = buildResolveInput({ document: doc, version, lineItems: lines, organization, recipients, signatures: [], logoUrl: null, imageUrl: () => "" });
  const { display } = buildVariables(input);
  return { doc, version, organization, recipients, variables: display };
}

function templateKind(type: "QUOTE" | "CONTRACT", kind: SendKind): EmailTemplateKind {
  if (kind === "reminder") return "REMINDER";
  return type === "QUOTE" ? "QUOTE_SEND" : "CONTRACT_SEND";
}

/** Pre-filled composer values (To/CC/Subject/Message) from the organization's email templates. */
export async function getEmailDraft(ctx: OrgContext, documentId: string, kind: SendKind = "initial") {
  const { doc, recipients, variables } = await loadPublishedContext(ctx, documentId);
  const tk = templateKind(doc.type, kind);
  const template = (await prisma.emailTemplate.findFirst({ where: { organizationId: ctx.organizationId, kind: tk }, orderBy: { isDefault: "desc" } })) ?? DEFAULT_EMAIL_TEMPLATES[tk];
  const to = recipients.filter((r) => r.role !== "CC").map((r) => r.email);
  const cc = recipients.filter((r) => r.role === "CC").map((r) => r.email);
  // Sequential signing: initial email goes to the first signer(s) only.
  const firstOrder = Math.min(...recipients.filter((r) => r.role === "SIGNER").map((r) => r.signingOrder), Infinity);
  const toFinal =
    doc.signingOrder === "SEQUENTIAL" && kind === "initial" && Number.isFinite(firstOrder)
      ? recipients.filter((r) => r.role !== "CC" && (r.role !== "SIGNER" || r.signingOrder === firstOrder)).map((r) => r.email)
      : to;
  return {
    to: toFinal,
    cc,
    subject: interpolate(template.subject, variables),
    message: interpolate(template.body, variables),
    documentUrl: appUrl(`/d/${doc.publicToken}`),
  };
}

const emailList = z.array(z.string().trim().toLowerCase().email().max(320)).max(20);
export const sendSchema = z.object({
  to: emailList.min(1, "Add at least one recipient"),
  cc: emailList.default([]),
  subject: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(10000),
  kind: z.enum(["initial", "reminder"]).default("initial"),
  attachPdf: z.boolean().default(true),
});

export async function sendDocument(ctx: OrgContext, documentId: string, input: z.input<typeof sendSchema>) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.DOCUMENTS_SEND);
  const data = sendSchema.parse(input);
  const { doc, version, organization, variables } = await loadPublishedContext(ctx, documentId);
  if (doc.archivedAt) throw new ConflictError("Archived documents cannot be sent.");
  if (!OPEN_STATUSES.includes(doc.status)) throw new ConflictError("This document is no longer open for review.");
  if (data.kind === "reminder" && !doc.sentAt) throw new ValidationError("Send the document before sending reminders.");
  await enforceRateLimit(`send:${doc.id}`, 20, 3600);

  // Subject/message may contain variables; the user's edits are plain text (escaped in HTML).
  const subject = interpolate(data.subject, variables).replace(/[\r\n]+/g, " ");
  const message = interpolate(data.message, variables);
  const documentUrl = appUrl(`/d/${doc.publicToken}`);
  const html = renderEmailLayout({
    brandName: organization.name,
    brandColor: organization.brandColor,
    bodyHtml: textToEmailHtml(message),
    action: { label: doc.type === "QUOTE" ? "View quote" : "Review & sign", url: documentUrl },
    footer: `${organization.name} uses DealDocs to share documents securely.`,
  });

  const now = new Date();
  const delivery = await prisma.$transaction(async (tx) => {
    const delivery = await queueEmail(
      {
        organizationId: ctx.organizationId,
        documentId: doc.id,
        versionNumber: version.versionNumber,
        kind: data.kind === "reminder" ? "DOCUMENT_REMINDER" : "DOCUMENT_SEND",
        to: data.to,
        cc: data.cc,
        subject,
        html,
        text: `${message}\n\n${documentUrl}`,
        sentById: ctx.user.id,
        replyTo: ctx.user.email,
        fromName: ctx.user.name,
        attachmentFileIds: data.attachPdf && version.pdfFileId ? [version.pdfFileId] : [],
      },
      tx,
    );
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    const counters = data.kind === "reminder" ? { reminderCount: { increment: 1 } } : { sendCount: { increment: 1 } };
    const nextStatus = isForwardProgress(fresh.status, "SENT") ? "SENT" : fresh.status;
    await changeStatus(tx, fresh, nextStatus, userActor(ctx), version.versionNumber, { sentAt: fresh.sentAt ?? now, lastSentAt: now, ...counters });
    await recordEvent(tx, doc, data.kind === "reminder" ? "REMINDER_SENT" : "EMAIL_SENT", userActor(ctx), version.versionNumber, {
      to: data.to,
      cc: data.cc,
      subject,
      deliveryId: delivery.id,
    });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_SENT", entityType: "Document", entityId: doc.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, metadata: { to: data.to, cc: data.cc, kind: data.kind, version: version.versionNumber } }, tx);
    await recordUsage(ctx.organizationId, "EMAIL_SENT", data.to.length + data.cc.length, { documentId: doc.id }, tx);
    return delivery;
  });
  if (data.kind === "initial") await scheduleHubSpotSync(doc.id, ctx.organizationId, automationEvent(doc.type, "SENT"));
  return delivery;
}
