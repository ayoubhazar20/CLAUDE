import type { ActorType, Document, DocumentStatus, Prisma } from "@prisma/client";
import type { Tx } from "../db";
import { assertTransition } from "@/domain/status";

export const DOCUMENT_EVENT_TYPES = [
  "CREATED",
  "EDITED",
  "PUBLISHED",
  "EMAIL_SENT",
  "REMINDER_SENT",
  "VIEWED",
  "OTP_REQUESTED",
  "OTP_VERIFIED",
  "OTP_FAILED",
  "CONSENT_GIVEN",
  "ACCEPTED",
  "SIGNED",
  "SIGNATURE_COMPLETED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "REVISION_CREATED",
  "DRAFT_DISCARDED",
  "DUPLICATED",
  "CONVERTED",
  "ARCHIVED",
  "RESTORED",
  "PRIMARY_SET",
  "OWNER_CHANGED",
  "PDF_GENERATED",
  "ATTACHMENT_ADDED",
  "ATTACHMENT_REMOVED",
  "HUBSPOT_RECORD_LINKED",
  "HUBSPOT_DATA_REQUESTED",
  "HUBSPOT_DATA_RECEIVED",
  "HUBSPOT_DATA_APPLIED",
  "HUBSPOT_DATA_DISMISSED",
  "HUBSPOT_UPDATE_RECEIVED",
] as const;
export type DocumentEventType = (typeof DOCUMENT_EVENT_TYPES)[number];

export interface Actor {
  type: ActorType;
  userId?: string | null;
  recipientId?: string | null;
  label?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function recordEvent(
  tx: Tx,
  doc: Pick<Document, "id" | "organizationId">,
  type: DocumentEventType,
  actor: Actor,
  versionNumber: number | null,
  metadata: Record<string, unknown> = {},
) {
  await tx.documentEvent.create({
    data: {
      organizationId: doc.organizationId,
      documentId: doc.id,
      versionNumber,
      type,
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      recipientId: actor.recipientId ?? null,
      actorLabel: actor.label ?? null,
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
}

/** Status changes are validated against the state machine and recorded in the history table. */
export async function changeStatus(
  tx: Tx,
  doc: Pick<Document, "id" | "organizationId" | "status" | "type">,
  to: DocumentStatus,
  actor: Actor,
  versionNumber: number | null,
  extra: Prisma.DocumentUpdateInput = {},
  reason?: string,
) {
  if (doc.status !== to) assertTransition(doc.type, doc.status, to);
  await tx.document.update({ where: { id: doc.id }, data: { status: to, ...extra } });
  if (doc.status !== to) {
    await tx.documentStatusChange.create({
      data: {
        organizationId: doc.organizationId,
        documentId: doc.id,
        versionNumber,
        fromStatus: doc.status,
        toStatus: to,
        actorType: actor.type,
        actorUserId: actor.userId ?? null,
        recipientId: actor.recipientId ?? null,
        reason: reason ?? null,
      },
    });
  }
}

export function userActor(ctx: { user: { id: string; name: string }; meta: { ip: string | null; userAgent: string | null } }): Actor {
  return { type: "USER", userId: ctx.user.id, label: ctx.user.name, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent };
}
