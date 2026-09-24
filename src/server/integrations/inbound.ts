import type { Prisma, ZapierIntegration } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "../db";
import { audit } from "../audit";
import { AppError, NotFoundError, ValidationError } from "../errors";
import { enforceRateLimit } from "../security/rate-limit";
import type { RequestMeta } from "../request";
import { recordEvent } from "../documents/events";
import { hashIntegrationSecret, SECRET_PREFIX } from "./config";
import { emitDocumentEvent } from "./outbound";
import { receiveSnapshot } from "./snapshot";

/**
 * Inbound Zapier → DealDocs calls. Every request must carry the organization's
 * integration secret (`Authorization: Bearer ddz_…`). The secret identifies the
 * organization; ids in the body (deal id, document id, record id) are only ever
 * looked up inside that organization — a deal id is never an authorization.
 */

export class IntegrationAuthError extends AppError {
  constructor(message = "Invalid or missing integration credentials") {
    super(message, 401, "INTEGRATION_UNAUTHORIZED");
  }
}

export async function authenticateZapier(req: Request, meta: RequestMeta): Promise<ZapierIntegration> {
  await enforceRateLimit(`zapier:ip:${meta.ip ?? "unknown"}`, 300, 60);
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  const secret = match?.[1] ?? req.headers.get("x-dealdocs-secret") ?? "";
  if (!secret.startsWith(SECRET_PREFIX) || secret.length > 200) {
    await logInbound(null, { eventType: "AUTH", success: false, message: "Rejected: missing or malformed credentials", ip: meta.ip });
    throw new IntegrationAuthError();
  }
  const integration = await prisma.zapierIntegration.findUnique({ where: { secretHash: hashIntegrationSecret(secret) }, include: { organization: { select: { status: true } } } });
  if (!integration) {
    await logInbound(null, { eventType: "AUTH", success: false, message: "Rejected: unknown integration secret", ip: meta.ip });
    throw new IntegrationAuthError();
  }
  if (!integration.enabled || integration.organization.status !== "ACTIVE") {
    await logInbound(integration.organizationId, { eventType: "AUTH", success: false, message: "Rejected: integration disabled or organization inactive", ip: meta.ip });
    throw new AppError("The integration is disabled", 403, "INTEGRATION_DISABLED");
  }
  await enforceRateLimit(`zapier:org:${integration.organizationId}`, 600, 60);
  return integration;
}

export async function logInbound(
  organizationId: string | null,
  entry: { eventType: string; success: boolean; message: string; documentId?: string | null; externalId?: string | null; details?: Record<string, unknown>; ip?: string | null },
  tx: Tx = prisma,
) {
  await tx.syncLog.create({
    data: {
      organizationId,
      direction: "INBOUND",
      eventType: entry.eventType,
      documentId: entry.documentId ?? null,
      success: entry.success,
      message: entry.message.slice(0, 1000),
      externalId: entry.externalId ?? null,
      details: (entry.details ?? {}) as Prisma.InputJsonValue,
      ip: entry.ip ?? null,
    },
  });
}

/** Optional idempotency: Zapier may send an `event_id`; duplicates are acknowledged without effect. */
async function alreadyProcessed(organizationId: string, externalId: string | null) {
  if (!externalId) return false;
  return (await prisma.syncLog.count({ where: { organizationId, direction: "INBOUND", externalId, success: true } })) > 0;
}

const uuid = z.string().uuid();
const externalIdSchema = z.string().trim().min(1).max(200).optional().nullable();

async function findDocument(organizationId: string, documentId: string) {
  const doc = await prisma.document.findFirst({ where: { id: documentId, organizationId } });
  if (!doc) throw new NotFoundError("Document");
  return doc;
}

// ───────────────────────── Custom object record linked ─────────────────────────

export const linkSchema = z.object({
  dealdocs_document_id: uuid,
  hubspot_object_record_id: z.coerce.string().trim().regex(/^\d{1,30}$/, "HubSpot record ids are numeric"),
  event_id: externalIdSchema,
});

export async function linkHubSpotRecord(integration: ZapierIntegration, body: unknown, meta: RequestMeta) {
  const data = linkSchema.parse(body);
  const organizationId = integration.organizationId;
  if (await alreadyProcessed(organizationId, data.event_id ?? null)) return { ok: true, duplicate: true };
  const doc = await findDocument(organizationId, data.dealdocs_document_id);
  if (doc.hubspotObjectRecordId && doc.hubspotObjectRecordId !== data.hubspot_object_record_id) {
    // A different record id for the same document means Zapier created a duplicate — keep the first link.
    await logInbound(organizationId, { eventType: "HUBSPOT_DOCUMENT_LINKED", success: false, documentId: doc.id, externalId: null, message: `Ignored: document already linked to HubSpot record ${doc.hubspotObjectRecordId} (received ${data.hubspot_object_record_id})`, ip: meta.ip });
    return { ok: false, linkedRecordId: doc.hubspotObjectRecordId, conflict: true };
  }
  const unchanged = doc.hubspotObjectRecordId === data.hubspot_object_record_id;
  await prisma.$transaction(async (tx) => {
    if (!unchanged) {
      await tx.document.update({ where: { id: doc.id }, data: { hubspotObjectRecordId: data.hubspot_object_record_id, hubspotLinkedAt: new Date(), lastSyncAt: new Date() } });
      await recordEvent(tx, doc, "HUBSPOT_RECORD_LINKED", { type: "SYSTEM", label: "Zapier" }, null, { recordId: data.hubspot_object_record_id });
      await audit({ organizationId, actorType: "SYSTEM", actorLabel: "Zapier", action: "HUBSPOT_RECORD_LINKED", entityType: "Document", entityId: doc.id, ip: meta.ip, newValue: { hubspotObjectRecordId: data.hubspot_object_record_id } }, tx);
    }
    await logInbound(organizationId, { eventType: "HUBSPOT_DOCUMENT_LINKED", success: true, documentId: doc.id, externalId: data.event_id ?? null, message: `HubSpot object linked: record ${data.hubspot_object_record_id}`, ip: meta.ip }, tx);
  });
  return { ok: true, dealdocs_document_id: doc.id, hubspot_object_record_id: data.hubspot_object_record_id };
}

// ───────────────────────── Deal snapshot ─────────────────────────

export async function receiveDealSnapshot(integration: ZapierIntegration, body: unknown, meta: RequestMeta) {
  if (!body || typeof body !== "object") throw new ValidationError("Expected a JSON object");
  const raw = body as Record<string, unknown>;
  const documentId = uuid.safeParse(raw.document_id ?? raw.dealdocs_document_id);
  if (!documentId.success) throw new ValidationError("document_id is required");
  const externalId = externalIdSchema.parse(raw.event_id ?? raw.request_id ?? null) ?? null;
  const organizationId = integration.organizationId;
  if (await alreadyProcessed(organizationId, externalId)) return { ok: true, duplicate: true };
  await findDocument(organizationId, documentId.data);
  const result = await receiveSnapshot(organizationId, documentId.data, raw);
  await logInbound(organizationId, {
    eventType: "DEAL_SNAPSHOT",
    success: true,
    documentId: documentId.data,
    externalId,
    message: result.applied ? "HubSpot deal snapshot received and imported" : "HubSpot deal snapshot received — waiting for user review",
    details: { snapshotId: result.snapshotId },
    ip: meta.ip,
  });
  return { ok: true, ...result };
}

// ───────────────────────── HubSpot → DealDocs updates ─────────────────────────

export const hubspotUpdateSchema = z
  .object({
    deal_id: z.coerce.string().trim().regex(/^\d{1,30}$/).optional().nullable(),
    hubspot_object_record_id: z.coerce.string().trim().regex(/^\d{1,30}$/).optional().nullable(),
    dealdocs_document_id: uuid.optional().nullable(),
    changed_property: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.]+$/),
    new_value: z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]).optional(),
    updated_at: z.string().max(64).optional().nullable(),
    event_id: externalIdSchema,
  })
  .refine((d) => d.deal_id || d.hubspot_object_record_id || d.dealdocs_document_id, "Provide dealdocs_document_id, hubspot_object_record_id or deal_id");

const DEAL_NAME_PROPERTIES = ["dealname", "deal_name"];
const PRIMARY_PROPERTIES = ["is_primary", "dealdocs_is_primary"];
const truthy = (v: unknown) => v === true || v === "true" || v === "1" || v === 1 || v === "yes";

/**
 * Apply a HubSpot-side change. Only metadata can change directly; any other
 * CRM change becomes HubSpot data for the user to review. Versions, signed
 * content, signatures, PDFs and audit events are never touched.
 */
export async function applyHubSpotUpdate(integration: ZapierIntegration, body: unknown, meta: RequestMeta) {
  const data = hubspotUpdateSchema.parse(body);
  const organizationId = integration.organizationId;
  if (await alreadyProcessed(organizationId, data.event_id ?? null)) return { ok: true, duplicate: true };
  const docs = await prisma.document.findMany({
    where: {
      organizationId,
      ...(data.dealdocs_document_id ? { id: data.dealdocs_document_id } : data.hubspot_object_record_id ? { hubspotObjectRecordId: data.hubspot_object_record_id } : { hubspotDealId: data.deal_id! }),
    },
  });
  if (!docs.length) throw new NotFoundError("Document");
  const property = data.changed_property;
  const value = data.new_value === null || data.new_value === undefined ? "" : String(data.new_value);
  let outcome: string;
  let changedPrimary = false;

  if (DEAL_NAME_PROPERTIES.includes(property)) {
    await prisma.document.updateMany({ where: { organizationId, id: { in: docs.map((d) => d.id) } }, data: { hubspotDealName: value.slice(0, 500) || null } });
    outcome = `Deal name updated on ${docs.length} document(s)`;
  } else if (PRIMARY_PROPERTIES.includes(property)) {
    if (docs.length !== 1) throw new ValidationError("is_primary must target a single document");
    const doc = docs[0]!;
    changedPrimary = doc.isPrimary !== truthy(value);
    await prisma.$transaction(async (tx) => {
      if (truthy(value) && doc.hubspotDealId) {
        await tx.document.updateMany({ where: { organizationId, hubspotDealId: doc.hubspotDealId }, data: { isPrimary: false } });
      }
      await tx.document.update({ where: { id: doc.id }, data: { isPrimary: truthy(value) } });
    });
    outcome = `Primary flag set to ${truthy(value)}`;
  } else {
    // CRM data change → pending HubSpot data for review on each document (never auto-applied).
    const partial: Record<string, unknown> = { deal_id: docs[0]!.hubspotDealId, custom_properties: { [property.replace(/\./g, "_")]: value } };
    for (const doc of docs) await receiveSnapshot(organizationId, doc.id, partial);
    outcome = `Property ${property} queued for review on ${docs.length} document(s)`;
  }

  await prisma.$transaction(async (tx) => {
    for (const doc of docs) {
      await recordEvent(tx, doc, "HUBSPOT_UPDATE_RECEIVED", { type: "SYSTEM", label: "Zapier" }, null, { property, value: value.slice(0, 200) });
    }
    await audit({ organizationId, actorType: "SYSTEM", actorLabel: "Zapier", action: "HUBSPOT_UPDATE_APPLIED", entityType: "Document", entityId: docs[0]!.id, ip: meta.ip, metadata: { property, documents: docs.length, outcome } }, tx);
    await logInbound(organizationId, { eventType: "HUBSPOT_UPDATE", success: true, documentId: docs.length === 1 ? docs[0]!.id : null, externalId: data.event_id ?? null, message: outcome, details: { property }, ip: meta.ip }, tx);
  });
  // Primary changes affect the deal-level properties mirrored back to HubSpot.
  // Only real changes are echoed, so a HubSpot ↔ Zapier round trip cannot loop.
  if (changedPrimary) await emitDocumentEvent(docs[0]!, "DOCUMENT_UPDATED", { change: "primary" });
  return { ok: true, outcome };
}
