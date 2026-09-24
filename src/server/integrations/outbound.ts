import crypto from "node:crypto";
import type { Document, Prisma, SyncEvent } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { appUrl } from "../env";
import { audit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import { decrypt } from "../security/crypto";
import { enqueue } from "../jobs/queue";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { loadDocumentForEdit } from "../documents/access";
import { effectiveDealPropertyNames, effectiveStatusLabels, getIntegration, isConfigured, objectTypeIdFor } from "./config";
import { computeDealPropertyValues, renameDealProperties } from "./deal-properties";
import { PERMISSIONS } from "@/domain/permissions";

/**
 * Outbound events DealDocs → Zapier → HubSpot.
 *
 * Every event is persisted (sync_events) before delivery and retried until it
 * succeeds. The HubSpot record key is `dealdocs_document_id`, so Zapier can
 * "find or create" and retries never create duplicate custom object records.
 */
export const DOCUMENT_EVENTS = [
  "DOCUMENT_CREATED",
  "DOCUMENT_UPDATED",
  "DOCUMENT_PUBLISHED",
  "DOCUMENT_SENT",
  "DOCUMENT_VIEWED",
  "DOCUMENT_ACCEPTED",
  "DOCUMENT_REJECTED",
  "DOCUMENT_SIGNED",
  "DOCUMENT_EXPIRED",
  "DOCUMENT_CANCELLED",
  "DOCUMENT_REVISED",
] as const;
export type DocumentEventName = (typeof DOCUMENT_EVENTS)[number];
export type OutboundEventName = DocumentEventName | "DEAL_DATA_REQUESTED" | "DEAL_DATA_REFRESH_REQUESTED" | "TEST_EVENT";

/** Events whose payload should carry the generated PDF — delivery waits briefly for it. */
const NEEDS_PDF: OutboundEventName[] = ["DOCUMENT_PUBLISHED", "DOCUMENT_SIGNED", "DOCUMENT_ACCEPTED"];
const PDF_WAIT_MS = 10_000;
const PDF_MAX_WAIT_MS = 3 * 60_000;
const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Test hook: replace the HTTP transport (fake Zapier). */
export function setZapierFetch(fn: FetchLike | null) {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
}

export function publicDocumentUrl(token: string) {
  return appUrl(`/d/${token}`);
}

export function fileUrl(token: string, versionNumber: number) {
  return appUrl(`/files/${token}/v${versionNumber}.pdf`);
}

/** Record an event and schedule delivery. Safe inside a transaction. */
export async function emitEvent(
  params: { organizationId: string; documentId?: string | null; event: OutboundEventName; details?: Record<string, unknown> },
  tx: Tx = prisma,
): Promise<SyncEvent> {
  const integration = await tx.zapierIntegration.findUnique({ where: { organizationId: params.organizationId } });
  const configured = isConfigured(integration);
  const event = await tx.syncEvent.create({
    data: {
      organizationId: params.organizationId,
      documentId: params.documentId ?? null,
      eventType: params.event,
      payload: (params.details ?? {}) as Prisma.InputJsonValue,
      status: configured ? "PENDING" : "FAILED",
      lastError: configured ? null : "HubSpot via Zapier is not configured (or disabled) for this organization.",
    },
  });
  if (configured) await enqueue("zapier.deliver", { syncEventId: event.id }, { organizationId: params.organizationId, maxAttempts: MAX_ATTEMPTS }, tx);
  return event;
}

/** Shorthand for document lifecycle events. */
export async function emitDocumentEvent(doc: Pick<Document, "id" | "organizationId">, event: DocumentEventName, details: Record<string, unknown> = {}, tx: Tx = prisma) {
  return emitEvent({ organizationId: doc.organizationId, documentId: doc.id, event, details }, tx);
}

/** Current document state as mirrored on the HubSpot custom object record. */
export async function buildDocumentRecord(documentId: string, tx: Tx = prisma) {
  const doc = await tx.document.findUniqueOrThrow({ where: { id: documentId }, include: { owner: { select: { name: true, email: true } } } });
  const integration = await tx.zapierIntegration.findUnique({ where: { organizationId: doc.organizationId } });
  const labels = effectiveStatusLabels(integration);
  const published = doc.publishedVersionId ? await tx.documentVersion.findUnique({ where: { id: doc.publishedVersionId }, select: { versionNumber: true, pdfFileId: true, signedPdfFileId: true } }) : null;
  const recipient = await tx.documentRecipient.findFirst({ where: { documentId: doc.id, removedAt: null }, orderBy: [{ isPrimary: "desc" }, { signingOrder: "asc" }] });
  let recipientName = recipient?.name ?? null;
  let recipientEmail = recipient?.email ?? null;
  if (!recipient) {
    const draft = doc.draftVersionId ? await tx.documentVersion.findUnique({ where: { id: doc.draftVersionId }, select: { data: true } }) : null;
    const first = ((draft?.data as { recipients?: { name: string; email: string }[] } | undefined)?.recipients ?? [])[0];
    recipientName = first?.name ?? null;
    recipientEmail = first?.email ?? null;
  }
  const typeLabel = doc.type === "QUOTE" ? "Quote" : "Contract";
  return {
    dealdocs_document_id: doc.id,
    document_name: `${typeLabel} ${doc.number}`,
    document_title: doc.title,
    document_number: doc.number,
    document_type: doc.type === "QUOTE" ? "quote" : "contract",
    document_status: labels[doc.status] ?? doc.status.toLowerCase(),
    hubspot_deal_id: doc.hubspotDealId,
    hubspot_object_record_id: doc.hubspotObjectRecordId,
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
    published_at: doc.publishedAt?.toISOString() ?? null,
    accepted_at: doc.acceptedAt?.toISOString() ?? null,
    signed_at: doc.signedAt?.toISOString() ?? null,
    document_url: published ? publicDocumentUrl(doc.publicToken) : null,
    file_url: published ? fileUrl(doc.publicToken, published.versionNumber) : null,
    app_url: appUrl(`/documents/${doc.id}`),
    current_version: published?.versionNumber ?? doc.latestVersionNumber,
    amount: doc.grandTotal.toString(),
    currency: doc.currency,
    recipient_name: recipientName,
    recipient_email: recipientEmail,
    document_owner: doc.owner.name,
    document_owner_email: doc.owner.email,
    is_primary: doc.isPrimary,
    is_archived: Boolean(doc.archivedAt),
    last_sync_at: new Date().toISOString(),
    pdf_ready: Boolean(published && (published.signedPdfFileId || published.pdfFileId)),
  };
}

export async function buildPayload(event: SyncEvent) {
  const integration = await getIntegration(event.organizationId);
  const base = {
    event: event.eventType,
    event_id: event.id,
    occurred_at: event.createdAt.toISOString(),
    hubspot_object_type_id: objectTypeIdFor(integration),
    details: event.payload,
  };
  if (!event.documentId) return base;
  const document = await buildDocumentRecord(event.documentId);
  if (event.eventType === "DEAL_DATA_REQUESTED" || event.eventType === "DEAL_DATA_REFRESH_REQUESTED") {
    return {
      ...base,
      deal_id: document.hubspot_deal_id,
      document_id: document.dealdocs_document_id,
      request_id: event.id,
      callback_url: appUrl("/api/integrations/zapier/deal-snapshot"),
      document,
    };
  }
  let dealProperties: Record<string, string> = {};
  if (document.hubspot_deal_id) {
    const docs = await prisma.document.findMany({ where: { organizationId: event.organizationId, hubspotDealId: document.hubspot_deal_id } });
    const labels = effectiveStatusLabels(integration);
    dealProperties = renameDealProperties(computeDealPropertyValues(docs, labels, publicDocumentUrl), effectiveDealPropertyNames(integration));
  }
  return {
    ...base,
    // Zapier: search the custom object by dealdocs_document_id, update if found, create otherwise.
    idempotency_key: document.dealdocs_document_id,
    dealdocs_document_id: document.dealdocs_document_id,
    hubspot_deal_id: document.hubspot_deal_id,
    hubspot_object_record_id: document.hubspot_object_record_id,
    link_callback_url: appUrl("/api/integrations/zapier/hubspot-document-linked"),
    document,
    deal_properties: dealProperties,
  };
}

export function signBody(secret: string, timestamp: string, body: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

async function log(tx: Tx, entry: { organizationId: string; eventType: string; documentId: string | null; syncEventId: string; success: boolean; message: string; details?: Record<string, unknown> }) {
  await tx.syncLog.create({
    data: {
      organizationId: entry.organizationId,
      direction: "OUTBOUND",
      eventType: entry.eventType,
      documentId: entry.documentId,
      syncEventId: entry.syncEventId,
      success: entry.success,
      message: entry.message.slice(0, 1000),
      details: (entry.details ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export class DeliveryError extends Error {}

/** Job handler: deliver one sync event. Throws on retryable failure so the queue retries with backoff. */
export async function deliverSyncEvent(syncEventId: string) {
  const event = await prisma.syncEvent.findUnique({ where: { id: syncEventId } });
  if (!event || event.status === "SUCCESS") return;
  const integration = await getIntegration(event.organizationId);
  if (!isConfigured(integration)) {
    await prisma.syncEvent.update({ where: { id: event.id }, data: { status: "FAILED", lastError: "HubSpot via Zapier is not configured (or disabled)." } });
    return;
  }

  if (event.documentId && NEEDS_PDF.includes(event.eventType as OutboundEventName)) {
    const record = await buildDocumentRecord(event.documentId);
    if (!record.pdf_ready && Date.now() - event.createdAt.getTime() < PDF_MAX_WAIT_MS) {
      // PDF generation is asynchronous — wait for it so file_url works when HubSpot receives it.
      await enqueue("zapier.deliver", { syncEventId: event.id }, { organizationId: event.organizationId, runAt: new Date(Date.now() + PDF_WAIT_MS), maxAttempts: MAX_ATTEMPTS });
      return;
    }
  }

  await prisma.syncEvent.update({ where: { id: event.id }, data: { status: "PROCESSING", attempts: { increment: 1 } } });
  const payload = await buildPayload(event);
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const secret = decrypt(integration.secretEnc);
  let status = 0;
  let error: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(integration.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "DealDocs-Webhooks/1.0",
          "X-DealDocs-Event": event.eventType,
          "X-DealDocs-Event-Id": event.id,
          "X-DealDocs-Timestamp": timestamp,
          "X-DealDocs-Signature": signBody(secret, timestamp, body),
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      status = res.status;
      if (!res.ok) error = `Zapier responded with HTTP ${res.status}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    error = e instanceof Error ? (e.name === "AbortError" ? "Timed out waiting for Zapier" : e.message) : String(e);
  }

  const now = new Date();
  if (!error) {
    await prisma.$transaction(async (tx) => {
      await tx.syncEvent.update({ where: { id: event.id }, data: { status: "SUCCESS", responseStatus: status, deliveredAt: now, lastError: null, nextAttemptAt: null } });
      await tx.zapierIntegration.update({ where: { id: integration.id }, data: { lastSuccessAt: now } });
      if (event.documentId) await tx.document.update({ where: { id: event.documentId }, data: { lastSyncAt: now } });
      await log(tx, { organizationId: event.organizationId, eventType: event.eventType, documentId: event.documentId, syncEventId: event.id, success: true, message: `${event.eventType} sent to Zapier`, details: { httpStatus: status } });
    });
    return;
  }
  const fresh = await prisma.syncEvent.findUniqueOrThrow({ where: { id: event.id } });
  const willRetry = fresh.attempts < MAX_ATTEMPTS;
  await prisma.$transaction(async (tx) => {
    await tx.syncEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", responseStatus: status || null, lastError: error!.slice(0, 1000), nextAttemptAt: willRetry ? new Date(Date.now() + 30_000 * 4 ** Math.max(0, fresh.attempts - 1)) : null },
    });
    await tx.zapierIntegration.update({ where: { id: integration.id }, data: { lastErrorAt: now, lastError: `${event.eventType}: ${error}`.slice(0, 500) } });
    await log(tx, { organizationId: event.organizationId, eventType: event.eventType, documentId: event.documentId, syncEventId: event.id, success: false, message: `${event.eventType} failed: ${error}${willRetry ? " — will retry" : " — giving up"}`, details: { httpStatus: status, attempt: fresh.attempts } });
  });
  if (willRetry) throw new DeliveryError(error);
}

/** Manual retry from the synchronization log. */
export async function retrySyncEvent(ctx: OrgContext, syncEventId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.INTEGRATIONS_MANAGE);
  const event = await prisma.syncEvent.findFirst({ where: { id: syncEventId, organizationId: ctx.organizationId } });
  if (!event) throw new NotFoundError("Sync event");
  if (event.status === "SUCCESS") throw new ValidationError("This event was already delivered.");
  if (!isConfigured(await getIntegration(ctx.organizationId))) throw new ValidationError("Configure the Zapier webhook URL and secret first.");
  await prisma.syncEvent.update({ where: { id: event.id }, data: { status: "PENDING", attempts: 0, nextAttemptAt: null } });
  await enqueue("zapier.deliver", { syncEventId: event.id }, { organizationId: ctx.organizationId, maxAttempts: MAX_ATTEMPTS });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "INTEGRATION_EVENT_RETRIED", entityType: "SyncEvent", entityId: event.id, metadata: { event: event.eventType } });
}

export async function sendTestEvent(ctx: OrgContext) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!isConfigured(await getIntegration(ctx.organizationId))) throw new ValidationError("Configure the Zapier webhook URL and secret first.");
  return emitEvent({ organizationId: ctx.organizationId, event: "TEST_EVENT", details: { message: "Test event from DealDocs", organization: ctx.organization.name } });
}

/** Ask Zapier for (fresh) HubSpot deal data for a document. */
export async function requestDealData(ctx: OrgContext, documentId: string, kind: "initial" | "refresh", tx?: Tx) {
  const doc = tx ? await tx.document.findFirstOrThrow({ where: { id: documentId, organizationId: ctx.organizationId } }) : await loadDocumentForEdit(ctx, documentId);
  if (!doc.hubspotDealId) throw new ValidationError("This document is not linked to a HubSpot deal.");
  const run = async (t: Tx) => {
    const event = await emitEvent({ organizationId: ctx.organizationId, documentId: doc.id, event: kind === "initial" ? "DEAL_DATA_REQUESTED" : "DEAL_DATA_REFRESH_REQUESTED", details: { deal_id: doc.hubspotDealId } }, t);
    // Without a configured integration nothing will answer — don't leave the editor waiting.
    if (event.status !== "FAILED") {
      await t.document.update({ where: { id: doc.id }, data: { dealDataStatus: kind === "initial" ? "REQUESTED" : doc.dealDataStatus === "NOT_REQUESTED" ? "REQUESTED" : doc.dealDataStatus, dealDataRequestedAt: new Date() } });
    }
    if (kind === "refresh") await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DEAL_DATA_REQUESTED", entityType: "Document", entityId: doc.id }, t);
  };
  if (tx) await run(tx);
  else await prisma.$transaction(run);
}
