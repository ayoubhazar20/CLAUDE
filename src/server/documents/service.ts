import crypto from "node:crypto";
import type { Document, DocumentType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "../db";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { canonicalJson, publicToken as newPublicToken, sha256Hex } from "../security/crypto";
import { enqueue } from "../jobs/queue";
import { assertWithinLimit, recordUsage } from "../services/billing";
import { parseTemplateSettings, sanitizeBlocks } from "../services/templates";
import { emitDocumentEvent, requestDealData } from "../integrations/outbound";
import { changeStatus, recordEvent, userActor } from "./events";
import { loadDocumentForEdit, loadDocumentForView } from "./access";
import { allocateDocumentNumber } from "./numbering";
import { parsePricingConfig, pricingConfigSchema, resolveFromRows, toPricingLines } from "./render-input";
import { invalidateOpenChallenges } from "./otp";
import { parseBlocks, validateLockedBlocks, type Block } from "@/domain/blocks";
import { documentDataSchema, parseDocumentData, recipientSchema, type DocumentData, type RecipientData } from "@/domain/document-data";
import { calculatePricing, PricingError, type PricingConfig } from "@/domain/pricing";
import { renderStandaloneHtml } from "@/domain/render-html";
import { CURRENCY_CODES, isCurrencyCode } from "@/domain/currencies";
import { OPEN_STATUSES, isForwardProgress } from "@/domain/status";
import { PERMISSIONS } from "@/domain/permissions";
import { dec } from "@/domain/money";

const EDIT_EVENT_THROTTLE_MS = 10 * 60 * 1000;



function defaultTitle(type: DocumentType, dealName: string | null) {
  const base = type === "QUOTE" ? "Quote" : "Contract";
  return dealName ? `${base} — ${dealName}`.slice(0, 200) : base;
}

function clientNameOf(data: DocumentData) {
  return [data.contact.firstName, data.contact.lastName].filter(Boolean).join(" ") || data.recipients[0]?.name || null;
}

async function userTeamId(ctx: OrgContext, tx: Tx): Promise<string | null> {
  if (!ctx.membershipId) return null;
  const tm = await tx.teamMembership.findFirst({ where: { membershipId: ctx.membershipId, organizationId: ctx.organizationId }, orderBy: { createdAt: "asc" } });
  return tm?.teamId ?? null;
}

async function uniquePublicToken(tx: Tx): Promise<string> {
  for (;;) {
    const token = newPublicToken(32);
    const exists = await tx.document.findUnique({ where: { publicToken: token }, select: { id: true } });
    if (!exists) return token;
  }
}

// ───────────────────────── Creation ─────────────────────────

export const createDocumentSchema = z.object({
  type: z.enum(["QUOTE", "CONTRACT"]),
  templateId: z.string().uuid(),
  /** HubSpot Deal record id (from the HubSpot card link). Stored permanently; CRM data arrives via Zapier. */
  hubspotDealId: z.string().trim().regex(/^\d{1,30}$/, "HubSpot deal ids are numeric").optional().nullable(),
  title: z.string().trim().max(200).optional(),
  currency: z.enum(CURRENCY_CODES as [string, ...string[]]).optional(),
});

export interface LineItemSeed {
  source: "HUBSPOT_LINE_ITEM" | "HUBSPOT_PRODUCT" | "CUSTOM";
  hubspotLineItemId?: string | null;
  hubspotProductId?: string | null;
  sku?: string | null;
  name: string;
  description?: string | null;
  category?: string | null;
  quantity: string;
  unitPrice: string;
  discountType: "NONE" | "PERCENT" | "AMOUNT";
  discountValue: string;
  taxKeys: string[];
  optional?: boolean;
}

/** Template default taxes (line items arrive later through the HubSpot snapshot). */
export function initialPricing(settings: ReturnType<typeof parseTemplateSettings>): PricingConfig {
  return { globalDiscountType: "NONE", globalDiscountValue: "0", taxes: [...settings.defaultTaxes], fees: [] };
}

async function customFieldDefaults(tx: Tx, organizationId: string, type: DocumentType): Promise<Record<string, string>> {
  const defs = await tx.customFieldDefinition.findMany({ where: { organizationId, archivedAt: null, appliesTo: { has: type } } });
  const out: Record<string, string> = {};
  for (const d of defs) if (d.defaultValue) out[d.key] = d.defaultValue;
  return out;
}

interface NewDocumentParams {
  type: DocumentType;
  template: { id: string; versionId: string; content: unknown; settings: unknown };
  title: string;
  currency: string;
  data: DocumentData;
  lines: LineItemSeed[];
  pricing: PricingConfig;
  hubspot: { dealId: string | null; dealName: string | null; objectRecordId?: null };
  sourceQuoteId?: string | null;
}

async function insertDocument(ctx: OrgContext, tx: Tx, p: NewDocumentParams): Promise<Document> {
  const settings = parseTemplateSettings(p.template.settings, p.type);
  const number = await allocateDocumentNumber(tx, ctx.organizationId, p.type);
  const blocks = parseBlocks(p.template.content);
  const expiresAt = settings.expirationDays > 0 ? new Date(Date.now() + settings.expirationDays * 86400_000) : null;
  const totals = calculatePricing(
    p.lines.map((l, i) => ({ key: String(i), quantity: l.quantity, unitPrice: l.unitPrice, discountType: l.discountType, discountValue: l.discountValue, taxKeys: l.taxKeys, optional: l.optional })),
    p.pricing,
    p.currency,
  );
  const data: DocumentData = { ...p.data, sender: { name: ctx.user.name, email: ctx.user.email } };

  const document = await tx.document.create({
    data: {
      organizationId: ctx.organizationId,
      type: p.type,
      number,
      title: p.title,
      ownerId: ctx.user.id,
      createdById: ctx.user.id,
      teamId: await userTeamId(ctx, tx),
      templateId: p.template.id,
      templateVersionId: p.template.versionId,
      hubspotDealId: p.hubspot.dealId,
      hubspotDealName: p.hubspot.dealName,
      currency: p.currency,
      acceptanceMode: settings.acceptanceMode,
      signingOrder: settings.signingOrder,
      publicToken: await uniquePublicToken(tx),
      clientName: clientNameOf(data),
      clientCompany: data.company.name || null,
      grandTotal: totals.grandTotal,
      expiresAt,
      latestVersionNumber: 1,
      sourceQuoteId: p.sourceQuoteId ?? null,
    },
  });
  const version = await tx.documentVersion.create({
    data: {
      organizationId: ctx.organizationId,
      documentId: document.id,
      versionNumber: 1,
      status: "DRAFT",
      templateVersionId: p.template.versionId,
      content: blocks as unknown as Prisma.InputJsonValue,
      data: data as unknown as Prisma.InputJsonValue,
      pricingConfig: p.pricing as unknown as Prisma.InputJsonValue,
      totals: totals as unknown as Prisma.InputJsonValue,
      currency: p.currency,
      expiresAt,
      createdById: ctx.user.id,
    },
  });
  if (p.lines.length) {
    await tx.documentLineItem.createMany({
      data: p.lines.map((l, i) => ({
        organizationId: ctx.organizationId,
        versionId: version.id,
        position: i,
        source: l.source,
        hubspotLineItemId: l.hubspotLineItemId ?? null,
        hubspotProductId: l.hubspotProductId ?? null,
        sku: l.sku ?? null,
        name: l.name.slice(0, 500),
        description: l.description ?? null,
        category: l.category ?? null,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountType: l.discountType,
        discountValue: l.discountValue,
        taxKeys: l.taxKeys,
        optional: Boolean(l.optional),
      })),
    });
  }
  await syncCustomFieldValues(tx, ctx.organizationId, document.id, data.customFields);
  await tx.document.update({ where: { id: document.id }, data: { draftVersionId: version.id } });
  return { ...document, draftVersionId: version.id };
}

export async function createDocument(ctx: OrgContext, input: z.input<typeof createDocumentSchema>) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.DOCUMENTS_CREATE);
  const data = createDocumentSchema.parse(input);
  await assertWithinLimit(ctx.organizationId, "documents");

  const template = await prisma.template.findFirst({
    where: { id: data.templateId, organizationId: ctx.organizationId, status: "ACTIVE", documentType: data.type },
  });
  if (!template?.publishedVersionId) throw new ValidationError("Select a published template for this document type.");
  const templateVersion = await prisma.templateVersion.findFirstOrThrow({ where: { id: template.publishedVersionId, organizationId: ctx.organizationId } });
  const settings = parseTemplateSettings(templateVersion.settings, data.type);

  const currency = data.currency ?? settings.currency ?? (isCurrencyCode(ctx.organization.defaultCurrency) ? ctx.organization.defaultCurrency : "MAD");
  const dealId = data.hubspotDealId || null;

  const document = await prisma.$transaction(async (tx) => {
    const docData = parseDocumentData({});
    docData.customFields = await customFieldDefaults(tx, ctx.organizationId, data.type);
    const doc = await insertDocument(ctx, tx, {
      type: data.type,
      template: { id: template.id, versionId: templateVersion.id, content: templateVersion.content, settings: templateVersion.settings },
      title: data.title || defaultTitle(data.type, null),
      currency,
      data: docData,
      lines: [],
      pricing: initialPricing(settings),
      hubspot: { dealId, dealName: null },
    });
    await recordEvent(tx, doc, "CREATED", userActor(ctx), 1, { templateId: template.id, templateVersion: templateVersion.version, hubspotDealId: dealId });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_CREATED", entityType: "Document", entityId: doc.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, newValue: { number: doc.number, type: doc.type, hubspotDealId: dealId } }, tx);
    await recordUsage(ctx.organizationId, "DOCUMENT_CREATED", 1, { documentId: doc.id }, tx);
    // HubSpot mirror: Zapier creates (find-or-create) the custom object record and associates it to the deal,
    // and — separately — sends back a snapshot of the deal, contact, company and line items.
    await emitDocumentEvent(doc, "DOCUMENT_CREATED", {}, tx);
    if (dealId) {
      await requestDealData(ctx, doc.id, "initial", tx);
      await recordEvent(tx, doc, "HUBSPOT_DATA_REQUESTED", userActor(ctx), 1, { dealId });
    }
    return doc;
  });
  return document;
}

// ───────────────────────── Editing (autosave) ─────────────────────────

const decimalString = z.string().trim().regex(/^\d{1,14}(\.\d{1,6})?$/, "Enter a positive number");

export const lineItemInputSchema = z.object({
  id: z.string().uuid(),
  source: z.enum(["HUBSPOT_LINE_ITEM", "HUBSPOT_PRODUCT", "CUSTOM"]).default("CUSTOM"),
  hubspotLineItemId: z.string().max(64).nullable().optional(),
  hubspotProductId: z.string().max(64).nullable().optional(),
  sku: z.string().trim().max(120).nullable().optional(),
  name: z.string().trim().min(1, "Item name is required").max(500),
  description: z.string().max(5000).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
  quantity: decimalString,
  unitPrice: decimalString,
  discountType: z.enum(["NONE", "PERCENT", "AMOUNT"]).default("NONE"),
  discountValue: decimalString.default("0"),
  taxKeys: z.array(z.string().max(40)).max(10).default([]),
  optional: z.boolean().default(false),
});

export const saveDraftSchema = z.object({
  /** Optimistic concurrency token: the draft's updatedAt the client last saw. */
  baseUpdatedAt: z.string().datetime(),
  title: z.string().trim().min(1).max(200).optional(),
  blocks: z.unknown().optional(),
  data: z.unknown().optional(),
  pricingConfig: pricingConfigSchema.optional(),
  lineItems: z.array(lineItemInputSchema).max(300).optional(),
  currency: z.enum(CURRENCY_CODES as [string, ...string[]]).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

async function syncCustomFieldValues(tx: Tx, organizationId: string, documentId: string, values: Record<string, string>) {
  const defs = await tx.customFieldDefinition.findMany({ where: { organizationId, key: { in: Object.keys(values) } } });
  for (const def of defs) {
    await tx.customFieldValue.upsert({
      where: { documentId_definitionId: { documentId, definitionId: def.id } },
      create: { organizationId, documentId, definitionId: def.id, value: values[def.key] ?? null },
      update: { value: values[def.key] ?? null },
    });
  }
}

export async function saveDraft(ctx: OrgContext, documentId: string, input: z.input<typeof saveDraftSchema>) {
  assertWritable(ctx);
  const payload = saveDraftSchema.parse(input);
  const doc = await loadDocumentForEdit(ctx, documentId);
  if (doc.archivedAt) throw new ConflictError("Archived documents cannot be edited.");
  if (!doc.draftVersionId) throw new ConflictError("This version is published. Create a revision to make changes.", "NO_DRAFT");

  return prisma.$transaction(async (tx) => {
    const draft = await tx.documentVersion.findFirst({ where: { id: doc.draftVersionId!, documentId: doc.id, organizationId: ctx.organizationId, status: "DRAFT" } });
    if (!draft || draft.lockedAt) throw new ConflictError("This version can no longer be edited.", "NO_DRAFT");
    if (draft.updatedAt.toISOString() !== payload.baseUpdatedAt) {
      throw new ConflictError("This document was changed elsewhere (another tab or user). Reload to continue editing.", "STALE_DRAFT");
    }

    const update: Prisma.DocumentVersionUpdateInput = {};
    let blocks: Block[] | null = null;
    if (payload.blocks !== undefined) {
      blocks = sanitizeBlocks(parseBlocks(payload.blocks));
      // Locked template content must stay intact.
      const baseline = draft.templateVersionId ? await tx.templateVersion.findUnique({ where: { id: draft.templateVersionId } }) : null;
      if (baseline) {
        const violations = validateLockedBlocks(parseBlocks(baseline.content), blocks);
        if (violations.length) throw new ValidationError("Locked content cannot be modified.", { violations });
      }
      update.content = blocks as unknown as Prisma.InputJsonValue;
    }

    let data = parseDocumentData(draft.data);
    if (payload.data !== undefined) {
      const incoming = documentDataSchema.parse(payload.data);
      // Sender is managed by the system.
      data = { ...incoming, sender: data.sender };
      const emails = new Set<string>();
      for (const r of data.recipients) {
        if (emails.has(r.email)) throw new ValidationError(`Recipient ${r.email} is listed twice.`);
        emails.add(r.email);
      }
      update.data = data as unknown as Prisma.InputJsonValue;
    }

    const currency = payload.currency ?? draft.currency;
    const pricingConfig = payload.pricingConfig ? parsePricingConfig(payload.pricingConfig) : parsePricingConfig(draft.pricingConfig);
    if (payload.pricingConfig) update.pricingConfig = pricingConfig as unknown as Prisma.InputJsonValue;
    if (payload.currency) update.currency = currency;
    if (payload.expiresAt !== undefined) update.expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;

    if (payload.lineItems) {
      const taxKeys = new Set(pricingConfig.taxes.map((t) => t.key));
      for (const li of payload.lineItems) {
        if (li.discountType === "PERCENT" && dec(li.discountValue).greaterThan(100)) throw new ValidationError(`Discount on "${li.name}" cannot exceed 100%.`);
        if (li.taxKeys.some((k) => !taxKeys.has(k))) throw new ValidationError(`"${li.name}" references an unknown tax.`);
      }
      await tx.documentLineItem.deleteMany({ where: { versionId: draft.id, organizationId: ctx.organizationId } });
      if (payload.lineItems.length) {
        await tx.documentLineItem.createMany({
          data: payload.lineItems.map((li, i) => ({
            id: li.id,
            organizationId: ctx.organizationId,
            versionId: draft.id,
            position: i,
            source: li.source,
            hubspotLineItemId: li.hubspotLineItemId ?? null,
            hubspotProductId: li.hubspotProductId ?? null,
            sku: li.sku || null,
            name: li.name,
            description: li.description || null,
            category: li.category || null,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            discountType: li.discountType,
            discountValue: li.discountType === "NONE" ? "0" : li.discountValue,
            taxKeys: li.taxKeys,
            optional: li.optional,
          })),
        });
      }
    }

    const lines = await tx.documentLineItem.findMany({ where: { versionId: draft.id } });
    let totals;
    try {
      totals = calculatePricing(toPricingLines(lines), pricingConfig, currency);
    } catch (error) {
      if (error instanceof PricingError) throw new ValidationError(error.message);
      throw error;
    }
    update.totals = totals as unknown as Prisma.InputJsonValue;
    const saved = await tx.documentVersion.update({ where: { id: draft.id }, data: update });

    if (payload.data !== undefined) await syncCustomFieldValues(tx, ctx.organizationId, doc.id, data.customFields);
    await tx.document.update({
      where: { id: doc.id },
      data: {
        ...(payload.title ? { title: payload.title } : {}),
        // Denormalised listing fields only follow the draft while never published.
        ...(doc.publishedVersionId
          ? {}
          : { currency, grandTotal: totals.grandTotal, clientName: clientNameOf(data), clientCompany: data.company.name || null, expiresAt: saved.expiresAt }),
      },
    });

    const lastEdit = await tx.documentEvent.findFirst({
      where: { documentId: doc.id, type: "EDITED", versionNumber: draft.versionNumber, actorUserId: ctx.user.id },
      orderBy: { createdAt: "desc" },
    });
    if (!lastEdit || Date.now() - lastEdit.createdAt.getTime() > EDIT_EVENT_THROTTLE_MS) {
      await recordEvent(tx, doc, "EDITED", userActor(ctx), draft.versionNumber);
      await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_UPDATED", entityType: "Document", entityId: doc.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, metadata: { version: draft.versionNumber } }, tx);
    }
    return { updatedAt: saved.updatedAt.toISOString(), totals };
  });
}

// ───────────────────────── Publishing ─────────────────────────

export class PublishValidationError extends ValidationError {}

function validateForPublish(type: DocumentType, data: DocumentData, lineCount: number, expiresAt: Date | null, acceptanceMode: string): string[] {
  const problems: string[] = [];
  const signers = data.recipients.filter((r) => r.role === "SIGNER");
  if (!data.recipients.length) problems.push("Add at least one recipient.");
  if ((type === "CONTRACT" || acceptanceMode === "SIGNATURE_REQUIRED") && !signers.length) problems.push("Add at least one signatory.");
  if (type === "QUOTE" && lineCount === 0) problems.push("Add at least one product or service.");
  if (expiresAt && expiresAt.getTime() < Date.now()) problems.push("The expiration date is in the past.");
  return problems;
}

export async function publishDocument(ctx: OrgContext, documentId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.DOCUMENTS_PUBLISH);
  const doc = await loadDocumentForEdit(ctx, documentId);
  if (doc.archivedAt) throw new ConflictError("Archived documents cannot be published.");
  if (!doc.draftVersionId) throw new ConflictError("There is no draft to publish.", "NO_DRAFT");
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });

  const result = await prisma.$transaction(async (tx) => {
    // Serialise concurrent publications of the same document.
    await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    if (fresh.draftVersionId !== doc.draftVersionId) throw new ConflictError("The document changed while publishing. Please retry.");
    const draft = await tx.documentVersion.findFirstOrThrow({ where: { id: doc.draftVersionId!, organizationId: ctx.organizationId, status: "DRAFT" } });
    const lines = await tx.documentLineItem.findMany({ where: { versionId: draft.id }, orderBy: { position: "asc" } });
    const data = parseDocumentData(draft.data);
    const problems = validateForPublish(doc.type, data, lines.length, draft.expiresAt, doc.acceptanceMode);
    if (problems.length) throw new PublishValidationError(problems.join(" "), { problems });

    const now = new Date();
    // Snapshot: recipients, custom fields and sender are frozen with the version.
    const cfValues = await tx.customFieldValue.findMany({ where: { documentId: doc.id }, include: { definition: true } });
    const customFields = { ...data.customFields };
    for (const v of cfValues) if (!(v.definition.key in customFields) && v.value) customFields[v.definition.key] = v.value;
    const owner = await tx.user.findUniqueOrThrow({ where: { id: doc.ownerId } });
    const snapshotData: DocumentData = { ...data, customFields, sender: { name: owner.name, email: owner.email } };

    // Materialise recipients (stable ids across versions); statuses reset for the new version.
    const existing = await tx.documentRecipient.findMany({ where: { documentId: doc.id } });
    const keepIds = new Set(snapshotData.recipients.map((r) => r.id));
    for (const r of existing) {
      if (!keepIds.has(r.id) && !r.removedAt) await tx.documentRecipient.update({ where: { id: r.id }, data: { removedAt: now } });
    }
    for (const [i, r] of snapshotData.recipients.entries()) {
      const fields = {
        name: r.name,
        email: r.email,
        role: r.role,
        signingOrder: doc.signingOrder === "SEQUENTIAL" ? r.signingOrder : 1,
        required: r.required,
        hubspotContactId: r.hubspotContactId,
        status: "PENDING" as const,
        isPrimary: i === 0,
        removedAt: null,
      };
      const current = existing.find((e) => e.id === r.id);
      if (current) await tx.documentRecipient.update({ where: { id: current.id }, data: fields });
      else await tx.documentRecipient.create({ data: { id: r.id, organizationId: ctx.organizationId, documentId: doc.id, ...fields } });
    }
    const recipients = await tx.documentRecipient.findMany({ where: { documentId: doc.id, removedAt: null } });

    const publishedVersionView = { ...draft, data: snapshotData as unknown as Prisma.JsonValue, publishedAt: now };
    const { input, resolved } = resolveFromRows({
      document: doc,
      version: publishedVersionView,
      lineItems: lines,
      organization,
      recipients,
      signatures: [],
      data: snapshotData,
      logoUrl: organization.logoFileId ? `/d/${doc.publicToken}/logo` : null,
      imageUrl: (fileId) => `/d/${doc.publicToken}/images/${fileId}`,
    });
    const renderedHtml = renderStandaloneHtml(resolved, `${doc.number} v${draft.versionNumber}`);
    const contentHash = sha256Hex(
      canonicalJson({
        documentId: doc.id,
        number: doc.number,
        versionNumber: draft.versionNumber,
        content: draft.content,
        data: snapshotData,
        pricingConfig: input.pricingConfig,
        totals: input.totals,
        currency: draft.currency,
        expiresAt: draft.expiresAt,
        lineItems: lines.map((l) => ({ ...l, createdAt: undefined, updatedAt: undefined })),
        renderedHtml,
      }),
    );

    // Previous live version (if merely published) is superseded; accepted/signed ones stay as they are.
    if (fresh.publishedVersionId) {
      await tx.documentVersion.updateMany({ where: { id: fresh.publishedVersionId, status: "PUBLISHED" }, data: { status: "SUPERSEDED" } });
    }
    await tx.documentVersion.update({
      where: { id: draft.id },
      data: {
        status: "PUBLISHED",
        data: snapshotData as unknown as Prisma.InputJsonValue,
        totals: input.totals as unknown as Prisma.InputJsonValue,
        renderedHtml,
        contentHash,
        publishedAt: now,
        publishedById: ctx.user.id,
        lockedAt: now,
      },
    });
    const isRevision = Boolean(fresh.firstPublishedAt);
    await changeStatus(
      tx,
      fresh,
      "PUBLISHED",
      userActor(ctx),
      draft.versionNumber,
      {
        publishedVersionId: draft.id,
        draftVersionId: null,
        publishedAt: now,
        firstPublishedAt: fresh.firstPublishedAt ?? now,
        currency: draft.currency,
        grandTotal: input.totals.grandTotal,
        clientName: clientNameOf(snapshotData),
        clientCompany: snapshotData.company.name || null,
        expiresAt: draft.expiresAt,
        revisionCount: isRevision ? { increment: 1 } : undefined,
        acceptedAt: null,
        signedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        expiredAt: null,
        cancelledAt: null,
      },
    );
    await invalidateOpenChallenges(tx, doc.id);
    await recordEvent(tx, doc, "PUBLISHED", userActor(ctx), draft.versionNumber, { contentHash, total: input.totals.grandTotal, currency: draft.currency, revision: isRevision });
    await audit({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      action: "DOCUMENT_PUBLISHED",
      entityType: "Document",
      entityId: doc.id,
      ip: ctx.meta.ip,
      userAgent: ctx.meta.userAgent,
      newValue: { version: draft.versionNumber, contentHash, total: input.totals.grandTotal },
    }, tx);
    await recordUsage(ctx.organizationId, "DOCUMENT_PUBLISHED", 1, { documentId: doc.id }, tx);
    await enqueue("pdf.generate", { versionId: draft.id }, { organizationId: ctx.organizationId, dedupeKey: `pdf:${draft.id}` }, tx);
    await emitDocumentEvent(doc, "DOCUMENT_PUBLISHED", { version: draft.versionNumber, revision: isRevision }, tx);
    return { versionId: draft.id, versionNumber: draft.versionNumber };
  });
  return result;
}

// ───────────────────────── Revisions ─────────────────────────

export async function createRevision(ctx: OrgContext, documentId: string, options: { fromLatestTemplate?: boolean } = {}) {
  assertWritable(ctx);
  const doc = await loadDocumentForEdit(ctx, documentId);
  if (doc.archivedAt) throw new ConflictError("Archived documents cannot be revised.");
  if (doc.draftVersionId) return { versionId: doc.draftVersionId, created: false };
  if (!doc.publishedVersionId) throw new ConflictError("Nothing to revise yet.");
  if (["ACCEPTED", "SIGNED"].includes(doc.status)) assertPermission(ctx, PERMISSIONS.DOCUMENTS_REVISE_COMPLETED);
  if (options.fromLatestTemplate) assertPermission(ctx, PERMISSIONS.TEMPLATES_MANAGE);

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;
    const fresh = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    if (fresh.draftVersionId) return { versionId: fresh.draftVersionId, created: false };
    const source = await tx.documentVersion.findFirstOrThrow({ where: { id: fresh.publishedVersionId!, organizationId: ctx.organizationId } });
    const lines = await tx.documentLineItem.findMany({ where: { versionId: source.id }, orderBy: { position: "asc" } });

    let content = source.content as Prisma.InputJsonValue;
    let templateVersionId = source.templateVersionId;
    if (options.fromLatestTemplate && fresh.templateId) {
      const template = await tx.template.findFirst({ where: { id: fresh.templateId, organizationId: ctx.organizationId } });
      if (!template?.publishedVersionId) throw new ConflictError("The template has no published version.");
      const tv = await tx.templateVersion.findUniqueOrThrow({ where: { id: template.publishedVersionId } });
      content = tv.content as Prisma.InputJsonValue;
      templateVersionId = tv.id;
    }
    const versionNumber = fresh.latestVersionNumber + 1;
    const version = await tx.documentVersion.create({
      data: {
        organizationId: ctx.organizationId,
        documentId: doc.id,
        versionNumber,
        status: "DRAFT",
        templateVersionId,
        content,
        data: source.data as Prisma.InputJsonValue,
        pricingConfig: source.pricingConfig as Prisma.InputJsonValue,
        totals: source.totals as Prisma.InputJsonValue,
        currency: source.currency,
        expiresAt: source.expiresAt && source.expiresAt > new Date() ? source.expiresAt : null,
        createdById: ctx.user.id,
      },
    });
    if (lines.length) {
      await tx.documentLineItem.createMany({
        data: lines.map((l) => ({
          organizationId: ctx.organizationId,
          versionId: version.id,
          position: l.position,
          source: l.source,
          hubspotLineItemId: l.hubspotLineItemId,
          hubspotProductId: l.hubspotProductId,
          sku: l.sku,
          name: l.name,
          description: l.description,
          category: l.category,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountType: l.discountType,
          discountValue: l.discountValue,
          taxKeys: l.taxKeys,
          optional: l.optional,
        })),
      });
    }
    await tx.document.update({
      where: { id: doc.id },
      data: { draftVersionId: version.id, latestVersionNumber: versionNumber, ...(options.fromLatestTemplate ? { templateVersionId } : {}) },
    });
    await recordEvent(tx, doc, "REVISION_CREATED", userActor(ctx), versionNumber, { fromVersion: source.versionNumber, fromLatestTemplate: Boolean(options.fromLatestTemplate) });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_REVISED", entityType: "Document", entityId: doc.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent, metadata: { fromVersion: source.versionNumber, newVersion: versionNumber } }, tx);
    await emitDocumentEvent(doc, "DOCUMENT_REVISED", { fromVersion: source.versionNumber, newVersion: versionNumber }, tx);
    return { versionId: version.id, created: true };
  });
}

export async function discardDraft(ctx: OrgContext, documentId: string) {
  assertWritable(ctx);
  const doc = await loadDocumentForEdit(ctx, documentId);
  if (!doc.draftVersionId) throw new ConflictError("There is no draft.");
  if (!doc.publishedVersionId) throw new ConflictError("This document has never been published — archive it instead.");
  await prisma.$transaction(async (tx) => {
    const draft = await tx.documentVersion.findUniqueOrThrow({ where: { id: doc.draftVersionId! } });
    await tx.documentVersion.update({ where: { id: draft.id }, data: { status: "DISCARDED" } });
    await tx.document.update({ where: { id: doc.id }, data: { draftVersionId: null } });
    await recordEvent(tx, doc, "DRAFT_DISCARDED", userActor(ctx), draft.versionNumber);
  });
}

// ───────────────────────── Duplication & conversion ─────────────────────────

async function latestVersionOf(tx: Tx, doc: Pick<Document, "draftVersionId" | "publishedVersionId" | "organizationId">) {
  const id = doc.draftVersionId ?? doc.publishedVersionId;
  if (!id) throw new NotFoundError("Document version");
  const version = await tx.documentVersion.findFirstOrThrow({ where: { id, organizationId: doc.organizationId } });
  const lines = await tx.documentLineItem.findMany({ where: { versionId: version.id }, orderBy: { position: "asc" } });
  return { version, lines };
}

function linesToSeeds(lines: Awaited<ReturnType<typeof latestVersionOf>>["lines"]): LineItemSeed[] {
  return lines.map((l) => ({
    source: l.source,
    hubspotLineItemId: l.hubspotLineItemId,
    hubspotProductId: l.hubspotProductId,
    sku: l.sku,
    name: l.name,
    description: l.description,
    category: l.category,
    quantity: l.quantity.toString(),
    unitPrice: l.unitPrice.toString(),
    discountType: l.discountType,
    discountValue: l.discountValue.toString(),
    taxKeys: l.taxKeys,
    optional: l.optional,
  }));
}

/** Fresh recipient ids so nothing (signatures, OTPs) can ever be shared between documents. */
function cloneRecipients(recipients: RecipientData[]): RecipientData[] {
  return recipients.map((r) => recipientSchema.parse({ ...r, id: crypto.randomUUID() }));
}

export async function duplicateDocument(ctx: OrgContext, documentId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.DOCUMENTS_CREATE);
  const source = await loadDocumentForView(ctx, documentId);
  await assertWithinLimit(ctx.organizationId, "documents");
  return prisma.$transaction(async (tx) => {
    const { version, lines } = await latestVersionOf(tx, source);
    const data = parseDocumentData(version.data);
    data.recipients = cloneRecipients(data.recipients);
    const doc = await insertDocument(ctx, tx, {
      type: source.type,
      template: {
        id: source.templateId!,
        versionId: version.templateVersionId ?? source.templateVersionId!,
        content: version.content,
        settings: (await tx.templateVersion.findUnique({ where: { id: version.templateVersionId ?? source.templateVersionId! } }))?.settings ?? {},
      },
      title: `${source.title} (copy)`.slice(0, 200),
      currency: version.currency,
      data,
      lines: linesToSeeds(lines),
      pricing: parsePricingConfig(version.pricingConfig),
      hubspot: { dealId: source.hubspotDealId, dealName: source.hubspotDealName },
    });
    await tx.documentRelationship.create({ data: { organizationId: ctx.organizationId, sourceDocumentId: source.id, targetDocumentId: doc.id, type: "DUPLICATED_FROM" } });
    await recordEvent(tx, doc, "CREATED", userActor(ctx), 1, { duplicatedFrom: source.number });
    await recordEvent(tx, source, "DUPLICATED", userActor(ctx), null, { newDocument: doc.number });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_DUPLICATED", entityType: "Document", entityId: doc.id, metadata: { sourceDocumentId: source.id, sourceNumber: source.number } }, tx);
    await emitDocumentEvent(doc, "DOCUMENT_CREATED", { duplicatedFrom: source.id }, tx);
    await recordUsage(ctx.organizationId, "DOCUMENT_CREATED", 1, { documentId: doc.id }, tx);
    return doc;
  });
}

export async function convertQuoteToContract(ctx: OrgContext, quoteId: string, templateId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.DOCUMENTS_CREATE);
  const quote = await loadDocumentForView(ctx, quoteId);
  if (quote.type !== "QUOTE") throw new ValidationError("Only quotes can be converted to contracts.");
  await assertWithinLimit(ctx.organizationId, "documents");
  const template = await prisma.template.findFirst({ where: { id: templateId, organizationId: ctx.organizationId, documentType: "CONTRACT", status: "ACTIVE" } });
  if (!template?.publishedVersionId) throw new ValidationError("Select a published contract template.");
  const tv = await prisma.templateVersion.findUniqueOrThrow({ where: { id: template.publishedVersionId } });

  return prisma.$transaction(async (tx) => {
    // Use the accepted/published version when available (what the client agreed to).
    const src = quote.publishedVersionId
      ? {
          version: await tx.documentVersion.findUniqueOrThrow({ where: { id: quote.publishedVersionId } }),
          lines: await tx.documentLineItem.findMany({ where: { versionId: quote.publishedVersionId }, orderBy: { position: "asc" } }),
        }
      : await latestVersionOf(tx, quote);
    const data = parseDocumentData(src.version.data);
    data.recipients = cloneRecipients(data.recipients).map((r) => ({ ...r, role: r.role === "CC" ? "CC" : "SIGNER" }));
    const contractDefaults = await customFieldDefaults(tx, ctx.organizationId, "CONTRACT");
    const contractKeys = new Set((await tx.customFieldDefinition.findMany({ where: { organizationId: ctx.organizationId, appliesTo: { has: "CONTRACT" } } })).map((d) => d.key));
    data.customFields = { ...contractDefaults, ...Object.fromEntries(Object.entries(data.customFields).filter(([k]) => contractKeys.has(k) || !k.includes("."))) };

    const contract = await insertDocument(ctx, tx, {
      type: "CONTRACT",
      template: { id: template.id, versionId: tv.id, content: tv.content, settings: tv.settings },
      title: quote.hubspotDealName ? `Contract — ${quote.hubspotDealName}`.slice(0, 200) : `Contract for ${quote.number}`,
      currency: src.version.currency,
      data,
      lines: linesToSeeds(src.lines),
      pricing: parsePricingConfig(src.version.pricingConfig),
      hubspot: { dealId: quote.hubspotDealId, dealName: quote.hubspotDealName },
      sourceQuoteId: quote.id,
    });
    await tx.documentRelationship.create({ data: { organizationId: ctx.organizationId, sourceDocumentId: quote.id, targetDocumentId: contract.id, type: "CONVERTED_FROM_QUOTE" } });
    await recordEvent(tx, contract, "CREATED", userActor(ctx), 1, { convertedFrom: quote.number });
    await recordEvent(tx, quote, "CONVERTED", userActor(ctx), null, { contract: contract.number });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_CONVERTED", entityType: "Document", entityId: contract.id, metadata: { sourceQuoteId: quote.id, sourceNumber: quote.number } }, tx);
    await emitDocumentEvent(contract, "DOCUMENT_CREATED", { convertedFromQuote: quote.id }, tx);
    await recordUsage(ctx.organizationId, "DOCUMENT_CREATED", 1, { documentId: contract.id }, tx);
    return contract;
  });
}

// ───────────────────────── Lifecycle actions ─────────────────────────

export async function setArchived(ctx: OrgContext, documentId: string, archived: boolean) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.DOCUMENTS_ARCHIVE);
  const doc = await loadDocumentForEdit(ctx, documentId);
  await prisma.$transaction(async (tx) => {
    await tx.document.update({ where: { id: doc.id }, data: { archivedAt: archived ? new Date() : null, ...(archived ? { isPrimary: false } : {}) } });
    await recordEvent(tx, doc, archived ? "ARCHIVED" : "RESTORED", userActor(ctx), null);
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: archived ? "DOCUMENT_ARCHIVED" : "DOCUMENT_RESTORED", entityType: "Document", entityId: doc.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent }, tx);
  });
  await emitDocumentEvent(doc, "DOCUMENT_UPDATED", { change: archived ? "archived" : "restored" });
}

export async function cancelDocument(ctx: OrgContext, documentId: string, reason?: string) {
  assertWritable(ctx);
  const doc = await loadDocumentForEdit(ctx, documentId);
  if (![...OPEN_STATUSES, "DRAFT"].includes(doc.status)) throw new ConflictError("Only open documents can be cancelled.");
  await prisma.$transaction(async (tx) => {
    await changeStatus(tx, doc, "CANCELLED", userActor(ctx), null, { cancelledAt: new Date() }, reason);
    await invalidateOpenChallenges(tx, doc.id);
    await recordEvent(tx, doc, "CANCELLED", userActor(ctx), null, { reason: reason ?? null });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_CANCELLED", entityType: "Document", entityId: doc.id, metadata: { reason } }, tx);
    await emitDocumentEvent(doc, "DOCUMENT_CANCELLED", { reason: reason ?? null }, tx);
  });
}

export async function setPrimaryDocument(ctx: OrgContext, documentId: string) {
  assertWritable(ctx);
  const doc = await loadDocumentForEdit(ctx, documentId);
  if (!doc.hubspotDealId) throw new ValidationError("Only documents linked to a HubSpot deal can be primary.");
  await prisma.$transaction(async (tx) => {
    await tx.document.updateMany({ where: { organizationId: ctx.organizationId, hubspotDealId: doc.hubspotDealId }, data: { isPrimary: false } });
    await tx.document.update({ where: { id: doc.id }, data: { isPrimary: true } });
    await recordEvent(tx, doc, "PRIMARY_SET", userActor(ctx), null);
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_PRIMARY_SET", entityType: "Document", entityId: doc.id }, tx);
  });
  await emitDocumentEvent(doc, "DOCUMENT_UPDATED", { change: "primary" });
}

export async function changeOwner(ctx: OrgContext, documentId: string, newOwnerId: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.DOCUMENTS_REASSIGN);
  const doc = await loadDocumentForEdit(ctx, documentId);
  const member = await prisma.organizationMembership.findFirst({ where: { organizationId: ctx.organizationId, userId: newOwnerId, status: "ACTIVE" } });
  if (!member) throw new ValidationError("The new owner must be an active member of your organization.");
  await prisma.$transaction(async (tx) => {
    await tx.document.update({ where: { id: doc.id }, data: { ownerId: newOwnerId } });
    await recordEvent(tx, doc, "OWNER_CHANGED", userActor(ctx), null, { from: doc.ownerId, to: newOwnerId });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "DOCUMENT_OWNER_CHANGED", entityType: "Document", entityId: doc.id, previousValue: { ownerId: doc.ownerId }, newValue: { ownerId: newOwnerId } }, tx);
    await emitDocumentEvent(doc, "DOCUMENT_UPDATED", { change: "owner" }, tx);
  });
}

export { isForwardProgress };
