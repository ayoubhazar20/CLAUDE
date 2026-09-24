import { prisma } from "../db";
import { readFile, saveFile } from "../storage/files";
import { recordUsage } from "../services/billing";
import { recordEvent } from "../documents/events";
import { resolveFromRows } from "../documents/render-input";
import { formatDateTime } from "@/domain/resolve";
import { renderPdf, type CertificateEntry, type ImageLoader } from "./renderer";

/**
 * PDF generation for published versions (and final signed/accepted versions).
 * Generated asynchronously; each PDF is stored once per version with its checksum
 * and linked to that version forever (DB trigger prevents replacing it).
 */

function fileLoader(organizationId: string): ImageLoader {
  return async (url) => {
    const id = url.startsWith("file:") ? url.slice(5) : null;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const file = await prisma.storedFile.findFirst({ where: { id, organizationId } });
    if (!file) return null;
    const type = file.contentType === "image/png" ? "png" : file.contentType === "image/jpeg" ? "jpeg" : null;
    if (!type) return null;
    return { bytes: await readFile(file), type };
  };
}

const EVENT_LABELS: Record<string, string> = {
  PUBLISHED: "Document published",
  EMAIL_SENT: "Sent by email",
  REMINDER_SENT: "Reminder sent",
  VIEWED: "Viewed by client",
  OTP_REQUESTED: "Verification code requested",
  OTP_VERIFIED: "Email verified with one-time code",
  OTP_FAILED: "Incorrect verification code",
  CONSENT_GIVEN: "Consent to sign electronically",
  ACCEPTED: "Quote accepted",
  SIGNED: "Signed",
  SIGNATURE_COMPLETED: "All signatures completed",
};

export async function generateVersionPdf(versionId: string, options: { signed: boolean }) {
  const version = await prisma.documentVersion.findUnique({ where: { id: versionId } });
  if (!version || !version.lockedAt) return null;
  if (!options.signed && version.pdfFileId) return version.pdfFileId;
  if (options.signed && version.signedPdfFileId) return version.signedPdfFileId;

  const doc = await prisma.document.findUniqueOrThrow({ where: { id: version.documentId } });
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: doc.organizationId } });
  const [lineItems, recipients, signatures] = await Promise.all([
    prisma.documentLineItem.findMany({ where: { versionId }, orderBy: { position: "asc" } }),
    prisma.documentRecipient.findMany({ where: { documentId: doc.id } }),
    options.signed ? prisma.signature.findMany({ where: { versionId }, include: { otpChallenge: true }, orderBy: { signedAt: "asc" } }) : Promise.resolve([]),
  ]);
  // Recipients as snapshotted at publication (a later revision may have changed the live list).
  const snapshotIds = new Set(((version.data as { recipients?: { id: string }[] }).recipients ?? []).map((r) => r.id));
  const versionRecipients = recipients.filter((r) => snapshotIds.has(r.id));

  const { resolved } = resolveFromRows({
    document: doc,
    version,
    lineItems,
    organization,
    recipients: versionRecipients,
    signatures,
    logoUrl: organization.logoFileId ? `file:${organization.logoFileId}` : null,
    imageUrl: (fileId) => `file:${fileId}`,
  });

  let certificate;
  if (options.signed) {
    const events = await prisma.documentEvent.findMany({
      where: { documentId: doc.id, versionNumber: version.versionNumber, type: { in: Object.keys(EVENT_LABELS) } },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    const tz = organization.timezone;
    certificate = {
      completedAt: formatDateTime(version.completedAt ?? new Date(), tz),
      entries: signatures.map<CertificateEntry>((s) => ({
        signerName: s.signerName,
        signerEmail: s.signerEmail,
        kind: s.kind,
        method: s.method,
        signedAt: formatDateTime(s.signedAt, tz),
        otpVerifiedAt: s.otpChallenge.verifiedAt ? formatDateTime(s.otpChallenge.verifiedAt, tz) : null,
        ip: s.ip,
        userAgent: s.userAgent,
        consentText: s.consentText,
      })),
      events: events.map((e) => ({
        at: formatDateTime(e.createdAt, tz),
        label: `${EVENT_LABELS[e.type] ?? e.type}${e.actorLabel ? ` — ${e.actorLabel}` : ""}${e.ip ? ` (${e.ip})` : ""}`,
      })),
    };
  }

  const bytes = await renderPdf(
    resolved,
    {
      title: doc.title,
      number: doc.number,
      versionNumber: version.versionNumber,
      organizationName: organization.name,
      contentHash: version.contentHash,
      footerNote: options.signed ? (doc.type === "QUOTE" && doc.acceptanceMode === "ACCEPTANCE_ONLY" ? "Accepted" : "Signed") : undefined,
      certificate,
    },
    fileLoader(organization.id),
  );

  const kind = options.signed ? "SIGNED_PDF" : "PDF";
  const suffix = options.signed ? (doc.type === "QUOTE" && doc.acceptanceMode === "ACCEPTANCE_ONLY" ? "-accepted" : "-signed") : "";
  const file = await saveFile({
    organizationId: doc.organizationId,
    kind,
    filename: `${doc.number}-v${version.versionNumber}${suffix}.pdf`,
    contentType: "application/pdf",
    data: Buffer.from(bytes),
  });
  // Attach only if still empty (idempotent under retries; trigger forbids replacement).
  const updated = await prisma.documentVersion.updateMany({
    where: { id: versionId, ...(options.signed ? { signedPdfFileId: null } : { pdfFileId: null }) },
    data: options.signed ? { signedPdfFileId: file.id } : { pdfFileId: file.id, pdfGeneratedAt: new Date() },
  });
  if (updated.count === 1) {
    await recordEvent(prisma, doc, "PDF_GENERATED", { type: "SYSTEM" }, version.versionNumber, { fileId: file.id, checksum: file.checksum, signed: options.signed });
    await recordUsage(doc.organizationId, "PDF_GENERATED", 1, { documentId: doc.id });
    await recordUsage(doc.organizationId, "STORAGE_BYTES", file.size, { fileId: file.id });
    return file.id;
  }
  const again = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
  return options.signed ? again.signedPdfFileId : again.pdfFileId;
}
