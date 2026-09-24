import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { NotFoundError } from "../errors";
import { assertWritable, type OrgContext } from "../auth/context";
import { detectAndValidate, saveFile, sanitizeFilename } from "../storage/files";
import { assertWithinLimit, recordUsage } from "./billing";
import { loadDocumentForEdit, loadDocumentForView } from "../documents/access";
import { recordEvent, userActor } from "../documents/events";

export const attachmentVisibilitySchema = z.enum(["INTERNAL", "CLIENT"]);

export async function addAttachment(ctx: OrgContext, documentId: string, file: { name: string; data: Buffer }, visibility: "INTERNAL" | "CLIENT") {
  assertWritable(ctx);
  const doc = await loadDocumentForEdit(ctx, documentId);
  const contentType = detectAndValidate(file.data, file.name, "attachment");
  await assertWithinLimit(ctx.organizationId, "storage", file.data.length);
  const stored = await saveFile({ organizationId: ctx.organizationId, kind: "ATTACHMENT", filename: file.name, contentType, data: file.data, createdById: ctx.user.id });
  const attachment = await prisma.$transaction(async (tx) => {
    const a = await tx.attachment.create({
      data: { organizationId: ctx.organizationId, documentId: doc.id, fileId: stored.id, name: sanitizeFilename(file.name), visibility, uploadedById: ctx.user.id },
    });
    await recordEvent(tx, doc, "ATTACHMENT_ADDED", userActor(ctx), null, { name: a.name, visibility });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "ATTACHMENT_ADDED", entityType: "Attachment", entityId: a.id, metadata: { documentId: doc.id, name: a.name, visibility, size: stored.size } }, tx);
    await recordUsage(ctx.organizationId, "STORAGE_BYTES", stored.size, { fileId: stored.id }, tx);
    return a;
  });
  return attachment;
}

export async function setAttachmentVisibility(ctx: OrgContext, attachmentId: string, visibility: "INTERNAL" | "CLIENT") {
  assertWritable(ctx);
  const a = await prisma.attachment.findFirst({ where: { id: attachmentId, organizationId: ctx.organizationId, archivedAt: null } });
  if (!a) throw new NotFoundError("Attachment");
  await loadDocumentForEdit(ctx, a.documentId);
  await prisma.attachment.update({ where: { id: a.id }, data: { visibility } });
}

export async function archiveAttachment(ctx: OrgContext, attachmentId: string) {
  assertWritable(ctx);
  const a = await prisma.attachment.findFirst({ where: { id: attachmentId, organizationId: ctx.organizationId, archivedAt: null } });
  if (!a) throw new NotFoundError("Attachment");
  const doc = await loadDocumentForEdit(ctx, a.documentId);
  await prisma.$transaction(async (tx) => {
    await tx.attachment.update({ where: { id: a.id }, data: { archivedAt: new Date() } });
    await recordEvent(tx, doc, "ATTACHMENT_REMOVED", userActor(ctx), null, { name: a.name });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "ATTACHMENT_ARCHIVED", entityType: "Attachment", entityId: a.id, metadata: { documentId: doc.id } }, tx);
  });
}

/** Resolve a file for an authenticated user, enforcing tenant + document access. */
export async function fileForUser(ctx: OrgContext, fileId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new NotFoundError("File");
  const file = await prisma.storedFile.findFirst({ where: { id: fileId, organizationId: ctx.organizationId } });
  if (!file) throw new NotFoundError("File");
  if (file.kind === "ATTACHMENT") {
    const attachment = await prisma.attachment.findFirst({ where: { fileId, organizationId: ctx.organizationId } });
    if (!attachment) throw new NotFoundError("File");
    await loadDocumentForView(ctx, attachment.documentId);
  } else if (file.kind === "PDF" || file.kind === "SIGNED_PDF") {
    const version = await prisma.documentVersion.findFirst({ where: { organizationId: ctx.organizationId, OR: [{ pdfFileId: fileId }, { signedPdfFileId: fileId }] } });
    if (!version) throw new NotFoundError("File");
    await loadDocumentForView(ctx, version.documentId);
  }
  return file;
}
