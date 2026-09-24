import { prisma } from "../db";
import { NotFoundError } from "../errors";
import { walkBlocks, parseBlocks } from "@/domain/blocks";
import { findPublishedDocument } from "./public";

/** Files reachable from a public document link — only what the client is meant to see. */
export async function publicPdf(token: string) {
  const doc = await findPublishedDocument(token);
  if (!doc) throw new NotFoundError("Document");
  const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.publishedVersionId! } });
  const fileId = version.signedPdfFileId ?? version.pdfFileId;
  if (!fileId) return null;
  return prisma.storedFile.findFirstOrThrow({ where: { id: fileId, organizationId: doc.organizationId } });
}

export async function publicLogo(token: string) {
  const doc = await findPublishedDocument(token);
  if (!doc) throw new NotFoundError("Document");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: doc.organizationId } });
  if (!org.logoFileId) throw new NotFoundError("Logo");
  return prisma.storedFile.findFirstOrThrow({ where: { id: org.logoFileId, organizationId: org.id } });
}

export async function publicImage(token: string, fileId: string) {
  const doc = await findPublishedDocument(token);
  if (!doc || !/^[0-9a-f-]{36}$/i.test(fileId)) throw new NotFoundError("Image");
  const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.publishedVersionId! } });
  let referenced = false;
  walkBlocks(parseBlocks(version.content), (b) => {
    if (b.type === "image" && (b.props as { fileId?: string | null }).fileId === fileId) referenced = true;
  });
  if (!referenced) throw new NotFoundError("Image");
  return prisma.storedFile.findFirstOrThrow({ where: { id: fileId, organizationId: doc.organizationId } });
}

export async function publicAttachment(token: string, attachmentId: string) {
  const doc = await findPublishedDocument(token);
  if (!doc || !/^[0-9a-f-]{36}$/i.test(attachmentId)) throw new NotFoundError("Attachment");
  const attachment = await prisma.attachment.findFirst({ where: { id: attachmentId, documentId: doc.id, visibility: "CLIENT", archivedAt: null }, include: { file: true } });
  if (!attachment) throw new NotFoundError("Attachment");
  return { ...attachment.file, filename: attachment.name };
}
