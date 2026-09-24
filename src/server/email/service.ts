import type { EmailDelivery } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { env } from "../env";
import { enqueue } from "../jobs/queue";
import { readFile } from "../storage/files";
import { emailProvider } from "./provider";
import { htmlToText } from "./layout";

export interface QueueEmailParams {
  organizationId?: string | null;
  documentId?: string | null;
  versionNumber?: number | null;
  kind: string;
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text?: string;
  sentById?: string | null;
  replyTo?: string | null;
  fromName?: string | null;
  /** StoredFile ids to attach (e.g. the published PDF). */
  attachmentFileIds?: string[];
}

/** Record the delivery attempt and enqueue it. Delivery happens asynchronously. */
export async function queueEmail(params: QueueEmailParams, tx: Tx = prisma): Promise<EmailDelivery> {
  const delivery = await tx.emailDelivery.create({
    data: {
      organizationId: params.organizationId ?? null,
      documentId: params.documentId ?? null,
      versionNumber: params.versionNumber ?? null,
      kind: params.kind,
      to: params.to,
      cc: params.cc ?? [],
      subject: params.subject.slice(0, 500),
      bodyHtml: params.html,
      bodyText: params.text ?? htmlToText(params.html),
      sentById: params.sentById ?? null,
      provider: emailProvider().name,
    },
  });
  await enqueue(
    "email.send",
    {
      deliveryId: delivery.id,
      replyTo: params.replyTo ?? null,
      fromName: params.fromName ?? null,
      attachmentFileIds: params.attachmentFileIds ?? [],
    },
    { organizationId: params.organizationId ?? null, maxAttempts: 4 },
    tx,
  );
  return delivery;
}

function fromAddress(fromName: string | null): string {
  const configured = env().EMAIL_FROM;
  if (!fromName) return configured;
  const address = configured.match(/<([^>]+)>/)?.[1] ?? configured;
  return `"${fromName.replace(/["<>\r\n]/g, "")} via DealDocs" <${address}>`;
}

/** Job handler: actually send a queued email. */
export async function deliverEmail(payload: { deliveryId: string; replyTo?: string | null; fromName?: string | null; attachmentFileIds?: string[] }) {
  const delivery = await prisma.emailDelivery.findUnique({ where: { id: payload.deliveryId } });
  if (!delivery || delivery.status === "SENT" || delivery.status === "DELIVERED") return;
  const files = payload.attachmentFileIds?.length
    ? await prisma.storedFile.findMany({ where: { id: { in: payload.attachmentFileIds }, organizationId: delivery.organizationId } })
    : [];
  const attachments = await Promise.all(files.map(async (f) => ({ filename: f.filename, contentType: f.contentType, content: await readFile(f) })));
  try {
    const messageId = await emailProvider().send({
      from: fromAddress(payload.fromName ?? null),
      replyTo: payload.replyTo ?? undefined,
      to: delivery.to,
      cc: delivery.cc,
      subject: delivery.subject,
      html: delivery.bodyHtml,
      text: delivery.bodyText ?? htmlToText(delivery.bodyHtml),
      attachments,
    });
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: "SENT", sentAt: new Date(), providerMessageId: messageId, attempts: { increment: 1 }, error: null, provider: emailProvider().name },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: "FAILED", failedAt: new Date(), error: message.slice(0, 1000), attempts: { increment: 1 } },
    });
    throw error;
  }
}
