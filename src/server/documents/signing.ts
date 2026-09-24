import type { OtpAction } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { appUrl } from "../env";
import { audit } from "../audit";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../errors";
import type { RequestMeta } from "../request";
import { enqueue } from "../jobs/queue";
import { queueEmail } from "../email/service";
import { renderEmailLayout, textToEmailHtml } from "../email/layout";
import { notifyUser } from "../services/notifications";
import { scheduleHubSpotSync } from "../hubspot/sync";
import { automationEvent } from "./automation";
import { changeStatus, recordEvent, type Actor } from "./events";
import { consumeGrant, invalidateOpenChallenges, issueOtp, verifyOtp } from "./otp";
import { expireIfDue, findPublishedDocument } from "./public";
import { OPEN_STATUSES } from "@/domain/status";

/**
 * Client acceptance, rejection and electronic signature.
 *
 * Note: this is a simple electronic signature with email OTP verification and an
 * audit trail. It is not presented as a qualified/regulated signature.
 */
export const CONSENT_TEXT =
  "I agree to sign this document electronically. I understand that my electronic signature, together with the verification of my email address, has the same effect as my handwritten signature on this document.";
export const ACCEPTANCE_TEXT = "I have reviewed this quote and accept it, including its terms and conditions.";

export class DocumentClosedError extends AppError {
  constructor(message: string, code: string) {
    super(message, 409, code);
  }
}

async function loadOpenDocument(token: string) {
  const doc = await findPublishedDocument(token);
  if (!doc) throw new NotFoundError("Document");
  await expireIfDue(doc);
  const fresh = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
  if (fresh.archivedAt) throw new DocumentClosedError("This document is no longer available.", "DOCUMENT_ARCHIVED");
  if (fresh.status === "EXPIRED") throw new DocumentClosedError("This document has expired. Please contact the sender.", "DOCUMENT_EXPIRED");
  if (fresh.status === "CANCELLED") throw new DocumentClosedError("This document was cancelled by the sender.", "DOCUMENT_CANCELLED");
  if (fresh.status === "SIGNED") throw new DocumentClosedError("This document has already been signed.", "SIGNATURE_ALREADY_COMPLETED");
  if (fresh.status === "ACCEPTED") throw new DocumentClosedError("This quote has already been accepted.", "ALREADY_ACCEPTED");
  if (fresh.status === "REJECTED") throw new DocumentClosedError("This document was declined.", "ALREADY_REJECTED");
  if (!OPEN_STATUSES.includes(fresh.status)) throw new DocumentClosedError("This document is not open for action.", "DOCUMENT_CLOSED");
  const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: fresh.publishedVersionId! } });
  return { doc: fresh, version };
}

function signatureMode(doc: { type: string; acceptanceMode: string }): "ACCEPT" | "SIGN" {
  return doc.type === "QUOTE" && doc.acceptanceMode === "ACCEPTANCE_ONLY" ? "ACCEPT" : "SIGN";
}

async function assertSignerTurn(doc: { id: string; signingOrder: string }, versionId: string, recipient: { id: string; role: string; signingOrder: number }) {
  if (recipient.role !== "SIGNER") throw new ValidationError("This recipient is not a signatory.");
  const existing = await prisma.signature.findFirst({ where: { versionId, recipientId: recipient.id, kind: "SIGNATURE" } });
  if (existing) throw new DocumentClosedError("You have already signed this document.", "SIGNATURE_ALREADY_COMPLETED");
  if (doc.signingOrder === "SEQUENTIAL") {
    const earlier = await prisma.documentRecipient.findMany({
      where: { documentId: doc.id, removedAt: null, role: "SIGNER", required: true, signingOrder: { lt: recipient.signingOrder } },
    });
    if (earlier.length) {
      const signed = await prisma.signature.count({ where: { versionId, kind: "SIGNATURE", recipientId: { in: earlier.map((r) => r.id) } } });
      if (signed < earlier.length) throw new ConflictError("Another signatory must sign before you. You will receive an email when it is your turn.", "NOT_YOUR_TURN");
    }
  }
}

export const requestCodeSchema = z.object({
  recipientId: z.string().uuid(),
  action: z.enum(["ACCEPT_QUOTE", "SIGN_CONTRACT", "REJECT_DOCUMENT"]),
});

export async function requestActionCode(token: string, input: z.input<typeof requestCodeSchema>, meta: RequestMeta) {
  const data = requestCodeSchema.parse(input);
  const { doc, version } = await loadOpenDocument(token);
  const recipient = await prisma.documentRecipient.findFirst({ where: { id: data.recipientId, documentId: doc.id, removedAt: null } });
  if (!recipient) throw new NotFoundError("Recipient");
  const mode = signatureMode(doc);
  if (data.action === "ACCEPT_QUOTE" && mode !== "ACCEPT") throw new ValidationError("This document requires a signature.");
  if (data.action === "SIGN_CONTRACT") {
    if (mode !== "SIGN") throw new ValidationError("This quote only needs to be accepted.");
    await assertSignerTurn(doc, version.id, recipient);
  }
  if (data.action === "ACCEPT_QUOTE" && recipient.role === "CC") throw new ValidationError("This recipient cannot accept the quote.");
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: doc.organizationId } });
  return issueOtp({ document: doc, organization, versionNumber: version.versionNumber, recipient, action: data.action as OtpAction, meta });
}

export async function verifyActionCode(token: string, input: { challengeId: string; code: string }, meta: RequestMeta) {
  const { doc, version } = await loadOpenDocument(token);
  return verifyOtp({ documentId: doc.id, currentVersionNumber: version.versionNumber, challengeId: input.challengeId, code: input.code, meta });
}

function recipientActor(recipient: { id: string; name: string }, meta: RequestMeta): Actor {
  return { type: "RECIPIENT", recipientId: recipient.id, label: recipient.name, ip: meta.ip, userAgent: meta.userAgent };
}

// ───────────────────────── Quote acceptance ─────────────────────────

export async function acceptQuote(token: string, input: { grant: string }, meta: RequestMeta) {
  const { doc, version } = await loadOpenDocument(token);
  if (signatureMode(doc) !== "ACCEPT") throw new ValidationError("This document requires a signature.");
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    if (!OPEN_STATUSES.includes(fresh.status) || fresh.publishedVersionId !== version.id) throw new DocumentClosedError("This quote can no longer be accepted.", "DOCUMENT_CLOSED");
    const challenge = await consumeGrant(tx, { documentId: doc.id, versionNumber: version.versionNumber, grant: input.grant, action: "ACCEPT_QUOTE" });
    const recipient = challenge.recipient;
    const actor = recipientActor(recipient, meta);
    const now = new Date();
    const signature = await tx.signature.create({
      data: {
        organizationId: doc.organizationId,
        documentId: doc.id,
        versionId: version.id,
        recipientId: recipient.id,
        kind: "ACCEPTANCE",
        method: "CLICK_ACCEPT",
        signerName: recipient.name,
        signerEmail: challenge.email,
        documentHash: version.contentHash ?? "",
        otpChallengeId: challenge.id,
        consentText: ACCEPTANCE_TEXT,
        consentedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
        signedAt: now,
      },
    });
    await tx.documentVersion.update({ where: { id: version.id }, data: { status: "ACCEPTED", completedAt: now } });
    await tx.documentRecipient.update({ where: { id: recipient.id }, data: { status: "ACCEPTED" } });
    await changeStatus(tx, fresh, "ACCEPTED", actor, version.versionNumber, { acceptedAt: now });
    await invalidateOpenChallenges(tx, doc.id);
    await recordEvent(tx, doc, "ACCEPTED", actor, version.versionNumber, { email: challenge.email, documentHash: version.contentHash, signatureId: signature.id });
    await audit({ organizationId: doc.organizationId, actorType: "RECIPIENT", actorLabel: `${recipient.name} <${challenge.email}>`, action: "DOCUMENT_ACCEPTED", entityType: "Document", entityId: doc.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { version: version.versionNumber, documentHash: version.contentHash } }, tx);
    await notifyUser({ organizationId: doc.organizationId, userId: doc.ownerId, type: "QUOTE_ACCEPTED", title: `${doc.number} was accepted`, body: `${recipient.name} (${challenge.email}) accepted ${doc.title}.`, documentId: doc.id }, tx);
    await enqueue("pdf.generateSigned", { versionId: version.id, sendConfirmation: true }, { organizationId: doc.organizationId, dedupeKey: `signed-pdf:${version.id}` }, tx);
    return { signatureId: signature.id };
  });
  await scheduleHubSpotSync(doc.id, doc.organizationId, automationEvent(doc.type, "ACCEPTED"));
  return result;
}

// ───────────────────────── Rejection ─────────────────────────

export async function rejectDocument(token: string, input: { grant: string; reason?: string }, meta: RequestMeta) {
  const { doc, version } = await loadOpenDocument(token);
  const reason = (input.reason ?? "").trim().slice(0, 2000) || null;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    if (!OPEN_STATUSES.includes(fresh.status)) throw new DocumentClosedError("This document can no longer be declined.", "DOCUMENT_CLOSED");
    const challenge = await consumeGrant(tx, { documentId: doc.id, versionNumber: version.versionNumber, grant: input.grant, action: "REJECT_DOCUMENT" });
    const actor = recipientActor(challenge.recipient, meta);
    await tx.documentRecipient.update({ where: { id: challenge.recipientId }, data: { status: "REJECTED" } });
    await changeStatus(tx, fresh, "REJECTED", actor, version.versionNumber, { rejectedAt: new Date(), rejectionReason: reason }, reason ?? undefined);
    await invalidateOpenChallenges(tx, doc.id);
    await recordEvent(tx, doc, "REJECTED", actor, version.versionNumber, { reason, email: challenge.email });
    await audit({ organizationId: doc.organizationId, actorType: "RECIPIENT", actorLabel: `${challenge.recipient.name} <${challenge.email}>`, action: "DOCUMENT_REJECTED", entityType: "Document", entityId: doc.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { reason } }, tx);
    await notifyUser(
      {
        organizationId: doc.organizationId,
        userId: doc.ownerId,
        type: doc.type === "QUOTE" ? "QUOTE_REJECTED" : "CONTRACT_REJECTED",
        title: `${doc.number} was declined`,
        body: `${challenge.recipient.name} declined ${doc.title}.${reason ? `\n\nReason: ${reason}` : ""}`,
        documentId: doc.id,
      },
      tx,
    );
  });
  await scheduleHubSpotSync(doc.id, doc.organizationId, automationEvent(doc.type, "REJECTED"));
}

// ───────────────────────── Signature ─────────────────────────

const MAX_DRAWN_BYTES = 300 * 1024;

export const signSchema = z.object({
  grant: z.string().min(10).max(100),
  signerName: z.string().trim().min(2).max(200),
  method: z.enum(["TYPED", "DRAWN"]),
  signatureData: z.string().max(Math.ceil(MAX_DRAWN_BYTES * 1.4)),
  consent: z.literal(true, { errorMap: () => ({ message: "Consent is required to sign electronically" }) }),
});

export function validateSignatureData(method: "TYPED" | "DRAWN", data: string): string {
  if (method === "TYPED") {
    const typed = data.trim();
    if (typed.length < 2 || typed.length > 200) throw new ValidationError("Type your full name to sign.");
    return typed;
  }
  const prefix = "data:image/png;base64,";
  if (!data.startsWith(prefix)) throw new ValidationError("Invalid signature image.");
  const bytes = Buffer.from(data.slice(prefix.length), "base64");
  if (bytes.length < 100 || bytes.length > MAX_DRAWN_BYTES) throw new ValidationError("Invalid signature image.");
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new ValidationError("Invalid signature image.");
  return `${prefix}${bytes.toString("base64")}`;
}

export async function signDocument(token: string, input: z.input<typeof signSchema>, meta: RequestMeta) {
  const data = signSchema.parse(input);
  const signatureData = validateSignatureData(data.method, data.signatureData);
  const { doc, version } = await loadOpenDocument(token);
  if (signatureMode(doc) !== "SIGN") throw new ValidationError("This quote only needs to be accepted.");

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    if (!OPEN_STATUSES.includes(fresh.status) || fresh.publishedVersionId !== version.id) throw new DocumentClosedError("This document can no longer be signed.", "DOCUMENT_CLOSED");
    const challenge = await consumeGrant(tx, { documentId: doc.id, versionNumber: version.versionNumber, grant: data.grant, action: "SIGN_CONTRACT" });
    const recipient = challenge.recipient;
    await assertSignerTurn(fresh, version.id, recipient);
    const actor = recipientActor(recipient, meta);
    const now = new Date();

    await recordEvent(tx, doc, "CONSENT_GIVEN", actor, version.versionNumber, { consentText: CONSENT_TEXT, email: challenge.email });
    const signature = await tx.signature.create({
      data: {
        organizationId: doc.organizationId,
        documentId: doc.id,
        versionId: version.id,
        recipientId: recipient.id,
        kind: "SIGNATURE",
        method: data.method,
        signerName: data.signerName,
        signerEmail: challenge.email,
        signatureData,
        documentHash: version.contentHash ?? "",
        otpChallengeId: challenge.id,
        consentText: CONSENT_TEXT,
        consentedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
        signedAt: now,
      },
    });
    await tx.documentRecipient.update({ where: { id: recipient.id }, data: { status: "SIGNED" } });
    await recordEvent(tx, doc, "SIGNED", actor, version.versionNumber, { signer: data.signerName, email: challenge.email, method: data.method, documentHash: version.contentHash, signatureId: signature.id });

    const required = await tx.documentRecipient.findMany({ where: { documentId: doc.id, removedAt: null, role: "SIGNER", required: true } });
    const signedIds = new Set((await tx.signature.findMany({ where: { versionId: version.id, kind: "SIGNATURE" }, select: { recipientId: true } })).map((s) => s.recipientId));
    const complete = required.every((r) => signedIds.has(r.id));

    if (complete) {
      await tx.documentVersion.update({ where: { id: version.id }, data: { status: "SIGNED", completedAt: now } });
      await changeStatus(tx, fresh, "SIGNED", actor, version.versionNumber, { signedAt: now });
      await invalidateOpenChallenges(tx, doc.id);
      await recordEvent(tx, doc, "SIGNATURE_COMPLETED", { type: "SYSTEM" }, version.versionNumber, { signatures: signedIds.size, documentHash: version.contentHash });
      await audit({ organizationId: doc.organizationId, actorType: "RECIPIENT", actorLabel: `${recipient.name} <${challenge.email}>`, action: "DOCUMENT_SIGNED", entityType: "Document", entityId: doc.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { version: version.versionNumber, documentHash: version.contentHash, complete: true } }, tx);
      await notifyUser({ organizationId: doc.organizationId, userId: doc.ownerId, type: doc.type === "CONTRACT" ? "CONTRACT_SIGNED" : "QUOTE_ACCEPTED", title: `${doc.number} is fully signed`, body: `All signatories have signed ${doc.title}.`, documentId: doc.id }, tx);
      // Final signed PDF + confirmation emails (sent once the PDF exists).
      await enqueue("pdf.generateSigned", { versionId: version.id, sendConfirmation: true }, { organizationId: doc.organizationId, dedupeKey: `signed-pdf:${version.id}` }, tx);
    } else {
      if (fresh.status !== "AWAITING_SIGNATURE") await changeStatus(tx, fresh, "AWAITING_SIGNATURE", actor, version.versionNumber);
      await audit({ organizationId: doc.organizationId, actorType: "RECIPIENT", actorLabel: `${recipient.name} <${challenge.email}>`, action: "DOCUMENT_SIGNED", entityType: "Document", entityId: doc.id, ip: meta.ip, userAgent: meta.userAgent, metadata: { version: version.versionNumber, complete: false } }, tx);
      await notifyUser({ organizationId: doc.organizationId, userId: doc.ownerId, type: "SIGNATURE_COMPLETED", title: `${recipient.name} signed ${doc.number}`, body: `${recipient.name} signed ${doc.title}. Waiting for the remaining signatories.`, documentId: doc.id }, tx);
      if (fresh.signingOrder === "SEQUENTIAL") {
        const pending = required.filter((r) => !signedIds.has(r.id)).sort((a, b) => a.signingOrder - b.signingOrder);
        const nextOrder = pending[0]?.signingOrder;
        const organization = await tx.organization.findUniqueOrThrow({ where: { id: doc.organizationId } });
        for (const next of pending.filter((p) => p.signingOrder === nextOrder)) {
          await queueEmail(
            {
              organizationId: doc.organizationId,
              documentId: doc.id,
              versionNumber: version.versionNumber,
              kind: "SIGNATURE_TURN",
              to: [next.email],
              subject: `Your signature is requested: ${doc.title} (${doc.number})`,
              html: renderEmailLayout({
                brandName: organization.name,
                brandColor: organization.brandColor,
                bodyHtml: textToEmailHtml(`Hello ${next.name},\n\n${doc.title} (${doc.number}) is ready for your signature.`),
                action: { label: "Review & sign", url: appUrl(`/d/${doc.publicToken}`) },
              }),
            },
            tx,
          );
        }
      }
    }
    return { complete, signatureId: signature.id };
  });
  if (outcome.complete) await scheduleHubSpotSync(doc.id, doc.organizationId, automationEvent(doc.type, "SIGNED"));
  return outcome;
}

/** Confirmation email with the final PDF, sent after the signed PDF is generated. */
export async function sendCompletionEmails(versionId: string) {
  const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
  const doc = await prisma.document.findUniqueOrThrow({ where: { id: version.documentId } });
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: doc.organizationId } });
  const signatures = await prisma.signature.findMany({ where: { versionId }, include: { recipient: true } });
  const template = await prisma.emailTemplate.findFirst({ where: { organizationId: doc.organizationId, kind: "SIGNED_DOCUMENT" } });
  const emails = [...new Set(signatures.map((s) => s.signerEmail))];
  const { interpolate } = await import("@/domain/variables");
  for (const email of emails) {
    const sig = signatures.find((s) => s.signerEmail === email)!;
    const vars: Record<string, string> = {
      "contact.firstName": sig.signerName.split(" ")[0] ?? sig.signerName,
      "document.title": doc.title,
      "document.number": doc.number,
      "organization.name": organization.name,
      "document.url": appUrl(`/d/${doc.publicToken}`),
    };
    const subject = interpolate(template?.subject ?? "{{document.title}} {{document.number}} — completed", vars);
    const body = interpolate(template?.body ?? "Thank you. {{document.number}} has been completed. A copy is attached.", vars);
    await queueEmail({
      organizationId: doc.organizationId,
      documentId: doc.id,
      versionNumber: version.versionNumber,
      kind: "DOCUMENT_COMPLETED",
      to: [email],
      subject,
      html: renderEmailLayout({ brandName: organization.name, brandColor: organization.brandColor, bodyHtml: textToEmailHtml(body), action: { label: "View document", url: appUrl(`/d/${doc.publicToken}`) } }),
      attachmentFileIds: version.signedPdfFileId ? [version.signedPdfFileId] : [],
    });
  }
}
