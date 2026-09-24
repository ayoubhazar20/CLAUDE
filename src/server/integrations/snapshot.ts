import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { audit } from "../audit";
import { assertWritable, type OrgContext } from "../auth/context";
import { loadDocumentForEdit } from "../documents/access";
import { recordEvent, userActor } from "../documents/events";
import { parsePricingConfig, toPricingLines } from "../documents/render-input";
import { parseTemplateSettings } from "../services/templates";
import { calculatePricing } from "@/domain/pricing";
import { dec } from "@/domain/money";
import { isCurrencyCode } from "@/domain/currencies";
import { parseDocumentData, recipientSchema, type DocumentData } from "@/domain/document-data";

/**
 * HubSpot deal snapshots delivered by Zapier.
 *
 * HubSpot is authoritative for CRM data; DealDocs is authoritative for document
 * content. An initial snapshot is applied automatically only while the document
 * is an untouched draft. Every other snapshot waits for the user to choose, per
 * section, what to replace — manual document edits are never silently overwritten.
 */

type Raw = Record<string, unknown>;

export interface NormalizedLineItem {
  hubspotLineItemId: string | null;
  hubspotProductId: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  category: string | null;
  quantity: string;
  unitPrice: string;
  discountType: "NONE" | "PERCENT" | "AMOUNT";
  discountValue: string;
  taxRate: string | null;
}

export interface NormalizedContact {
  hubspotId: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
}

export interface NormalizedSnapshot {
  dealId: string | null;
  deal: { name: string; amount: string; pipeline: string; stage: string; closeDate: string; ownerName: string; ownerEmail: string; currency: string | null } | null;
  contact: NormalizedContact | null;
  contacts: NormalizedContact[];
  company: { hubspotId: string | null; name: string; address: string; city: string; zip: string; country: string; phone: string; domain: string } | null;
  lineItems: NormalizedLineItem[] | null;
  customProperties: Record<string, string>;
}

const str = (v: unknown, max = 500): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
};

const pick = (o: Raw | null | undefined, ...keys: string[]): string => {
  if (!o) return "";
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
  }
  return "";
};

/** Zapier often flattens arrays/objects into JSON strings — accept both. */
function objectish(v: unknown): Raw | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Raw;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Raw) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function arrayish(v: unknown): Raw[] | null {
  if (Array.isArray(v)) return v.filter((x): x is Raw => Boolean(x) && typeof x === "object");
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is Raw => Boolean(x) && typeof x === "object") : null;
    } catch {
      return null;
    }
  }
  return null;
}

function decimalString(v: unknown, fallback: string): string {
  const s = str(v, 64).replace(/,/g, "");
  if (!s) return fallback;
  try {
    const d = dec(s);
    return d.isNegative() ? fallback : d.toString();
  } catch {
    return fallback;
  }
}

function normalizeContact(c: Raw | null): NormalizedContact | null {
  if (!c) return null;
  const contact = {
    hubspotId: pick(c, "id", "hs_object_id", "contact_id") || null,
    firstName: pick(c, "first_name", "firstname", "firstName"),
    lastName: pick(c, "last_name", "lastname", "lastName"),
    email: pick(c, "email").toLowerCase(),
    phone: pick(c, "phone", "mobilephone"),
    jobTitle: pick(c, "job_title", "jobtitle", "jobTitle"),
  };
  return contact.firstName || contact.lastName || contact.email ? contact : null;
}

export function normalizeLineItem(li: Raw): NormalizedLineItem {
  const quantity = decimalString(li.quantity, "1");
  const pct = decimalString(li.discount_percentage ?? li.hs_discount_percentage, "0");
  const lineAmount = decimalString(li.discount_amount, "0");
  const unitDiscount = decimalString(li.discount ?? li.unit_discount, "0");
  let discountType: NormalizedLineItem["discountType"] = "NONE";
  let discountValue = "0";
  if (!dec(pct).isZero()) {
    discountType = "PERCENT";
    discountValue = dec(pct).greaterThan(100) ? "100" : pct;
  } else if (!dec(lineAmount).isZero()) {
    discountType = "AMOUNT";
    discountValue = lineAmount;
  } else if (!dec(unitDiscount).isZero()) {
    // HubSpot's "discount" is per unit; DealDocs stores the line amount.
    discountType = "AMOUNT";
    discountValue = dec(unitDiscount).times(dec(quantity)).toString();
  }
  const tax = decimalString(li.tax_rate ?? li.hs_tax_rate, "0");
  return {
    hubspotLineItemId: pick(li, "id", "hs_object_id", "line_item_id") || null,
    hubspotProductId: pick(li, "product_id", "hs_product_id") || null,
    sku: pick(li, "sku", "hs_sku") || null,
    name: (pick(li, "name", "product_name") || "Item").slice(0, 500),
    description: str(li.description, 5000) || null,
    category: pick(li, "category", "product_category") || null,
    quantity,
    unitPrice: decimalString(li.price ?? li.unit_price ?? li.amount_per_unit, "0"),
    discountType,
    discountValue,
    taxRate: dec(tax).isZero() || dec(tax).greaterThan(100) ? null : tax,
  };
}

export function normalizeSnapshot(body: Raw): NormalizedSnapshot {
  const deal = objectish(body.deal);
  const company = objectish(body.company);
  const contacts = (arrayish(body.contacts) ?? []).map(normalizeContact).filter((c): c is NormalizedContact => c !== null).slice(0, 20);
  const contact = normalizeContact(objectish(body.contact)) ?? contacts.find((c) => c.email) ?? contacts[0] ?? null;
  const lineItemsRaw = arrayish(body.line_items ?? body.lineItems);
  const custom = objectish(body.custom_properties ?? body.customProperties) ?? {};
  const currency = pick(deal, "currency", "deal_currency_code").toUpperCase();
  return {
    dealId: str(body.deal_id ?? deal?.id, 30) || null,
    deal: deal
      ? {
          name: pick(deal, "name", "dealname", "deal_name"),
          amount: decimalString(deal.amount, ""),
          pipeline: pick(deal, "pipeline_label", "pipeline"),
          stage: pick(deal, "stage_label", "stage", "dealstage"),
          closeDate: pick(deal, "close_date", "closedate"),
          ownerName: pick(deal, "owner_name", "owner"),
          ownerEmail: pick(deal, "owner_email"),
          currency: isCurrencyCode(currency) ? currency : null,
        }
      : null,
    contact,
    contacts: contacts.length ? contacts : contact ? [contact] : [],
    company: company
      ? {
          hubspotId: pick(company, "id", "hs_object_id") || null,
          name: pick(company, "name"),
          address: pick(company, "address"),
          city: pick(company, "city"),
          zip: pick(company, "zip", "postal_code"),
          country: pick(company, "country"),
          phone: pick(company, "phone"),
          domain: pick(company, "domain", "website"),
        }
      : null,
    lineItems: lineItemsRaw ? lineItemsRaw.slice(0, 300).map(normalizeLineItem) : null,
    customProperties: Object.fromEntries(
      Object.entries(custom)
        .filter(([k]) => /^[A-Za-z0-9_]{1,100}$/.test(k))
        .map(([k, v]) => [k, str(v, 5000)])
        .slice(0, 200),
    ),
  };
}

export type SnapshotSection = "contact" | "company" | "deal" | "customProperties" | "recipient";
export type LineItemMode = "keep" | "replace" | "append";
export interface ApplySelection {
  sections: SnapshotSection[];
  lineItems: LineItemMode;
}

/** Variable keys for HubSpot custom properties (configurable map, default `hubspot.<name>`). */
export function customPropertyVariables(custom: Record<string, string>, map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(custom)) out[map[name] || `hubspot.${name}`] = value;
  return out;
}

/** Pure merge of snapshot sections into document data. */
export function mergeSnapshotIntoData(data: DocumentData, snap: NormalizedSnapshot, sections: SnapshotSection[], propertyMap: Record<string, string>): DocumentData {
  const next = structuredClone(data);
  if (sections.includes("contact") && snap.contact) next.contact = { ...snap.contact };
  if (sections.includes("company") && snap.company) next.company = { ...snap.company };
  if (sections.includes("deal") && snap.deal) {
    next.deal = {
      ...next.deal,
      hubspotId: snap.dealId ?? next.deal.hubspotId,
      name: snap.deal.name,
      amount: snap.deal.amount,
      pipeline: snap.deal.pipeline,
      stage: snap.deal.stage,
      closeDate: snap.deal.closeDate,
      owner: { hubspotId: null, name: snap.deal.ownerName, email: snap.deal.ownerEmail },
    };
  }
  if (sections.includes("customProperties")) next.hubspotProperties = { ...next.hubspotProperties, ...customPropertyVariables(snap.customProperties, propertyMap) };
  if (sections.includes("recipient") && snap.contact?.email) {
    const name = [snap.contact.firstName, snap.contact.lastName].filter(Boolean).join(" ") || snap.contact.email;
    const existing = next.recipients.find((r) => r.email === snap.contact!.email);
    if (!existing) {
      next.recipients = [
        recipientSchema.parse({ id: crypto.randomUUID(), name, email: snap.contact.email, role: "SIGNER", signingOrder: 1, required: true, hubspotContactId: snap.contact.hubspotId }),
        ...next.recipients.map((r) => ({ ...r, signingOrder: r.signingOrder + (r.role === "SIGNER" ? 1 : 0) })),
      ];
    }
  }
  return next;
}

async function applyToDraft(tx: Tx, params: { organizationId: string; documentId: string; snapshot: NormalizedSnapshot; selection: ApplySelection; initial: boolean }) {
  const doc = await tx.document.findFirstOrThrow({ where: { id: params.documentId, organizationId: params.organizationId } });
  if (!doc.draftVersionId) throw new ConflictError("Create a revision first — published and signed versions are never modified.", "NO_DRAFT");
  const draft = await tx.documentVersion.findFirstOrThrow({ where: { id: doc.draftVersionId, organizationId: params.organizationId, status: "DRAFT" } });
  if (draft.lockedAt) throw new ConflictError("This version is locked.", "NO_DRAFT");
  const integration = await tx.zapierIntegration.findUnique({ where: { organizationId: params.organizationId } });
  const propertyMap = (integration?.propertyVariableMap ?? {}) as Record<string, string>;

  const data = mergeSnapshotIntoData(parseDocumentData(draft.data), params.snapshot, params.selection.sections, propertyMap);
  let pricing = parsePricingConfig(draft.pricingConfig);
  let currency = draft.currency;

  const incoming = params.snapshot.lineItems ?? [];
  if (params.selection.lineItems !== "keep" && incoming.length) {
    const templateVersion = draft.templateVersionId ? await tx.templateVersion.findUnique({ where: { id: draft.templateVersionId } }) : null;
    const settings = parseTemplateSettings(templateVersion?.settings ?? {}, doc.type);
    const taxes = [...pricing.taxes];
    for (const t of settings.defaultTaxes) if (!taxes.some((x) => x.key === t.key)) taxes.push(t);
    const defaultKeys = settings.applyDefaultTaxes ? settings.defaultTaxes.map((t) => t.key) : [];
    const lines = incoming.map((li) => {
      let taxKeys = [...defaultKeys];
      if (li.taxRate) {
        let tax = taxes.find((t) => dec(t.rate).equals(dec(li.taxRate!)));
        if (!tax) {
          tax = { key: `hs_tax_${taxes.length + 1}`, name: "Tax", rate: dec(li.taxRate).toString() };
          taxes.push(tax);
        }
        taxKeys = [tax.key];
      }
      return { ...li, taxKeys };
    });
    pricing = { ...pricing, taxes };
    const existingCount = await tx.documentLineItem.count({ where: { versionId: draft.id } });
    if (params.selection.lineItems === "replace") await tx.documentLineItem.deleteMany({ where: { versionId: draft.id, organizationId: params.organizationId } });
    const offset = params.selection.lineItems === "append" ? existingCount : 0;
    await tx.documentLineItem.createMany({
      data: lines.map((l, i) => ({
        organizationId: params.organizationId,
        versionId: draft.id,
        position: offset + i,
        source: "HUBSPOT_LINE_ITEM" as const,
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
      })),
    });
    // The deal currency only applies to a fresh import (existing prices are never converted).
    if (params.initial && existingCount === 0 && params.snapshot.deal?.currency) currency = params.snapshot.deal.currency;
  }

  const allLines = await tx.documentLineItem.findMany({ where: { versionId: draft.id } });
  const totals = calculatePricing(toPricingLines(allLines), pricing, currency);
  await tx.documentVersion.update({
    where: { id: draft.id },
    data: {
      data: data as unknown as Prisma.InputJsonValue,
      pricingConfig: pricing as unknown as Prisma.InputJsonValue,
      totals: totals as unknown as Prisma.InputJsonValue,
      currency,
    },
  });
  await tx.document.update({
    where: { id: doc.id },
    data: {
      hubspotDealName: params.snapshot.deal?.name || doc.hubspotDealName,
      ...(doc.publishedVersionId
        ? {}
        : {
            currency,
            grandTotal: totals.grandTotal,
            clientName: [data.contact.firstName, data.contact.lastName].filter(Boolean).join(" ") || data.recipients[0]?.name || null,
            clientCompany: data.company.name || null,
          }),
      ...(params.initial && !doc.title.includes("—") && data.deal.name ? { title: `${doc.type === "QUOTE" ? "Quote" : "Contract"} — ${data.deal.name}`.slice(0, 200) } : {}),
    },
  });
}

/** Has anyone edited this document since it was created? */
async function userHasEdited(tx: Tx, documentId: string) {
  return (await tx.documentEvent.count({ where: { documentId, type: "EDITED" } })) > 0;
}

/**
 * Store an incoming snapshot. The initial snapshot of an untouched draft is
 * applied automatically; anything else waits for review.
 */
export async function receiveSnapshot(organizationId: string, documentId: string, body: Raw) {
  const snapshot = normalizeSnapshot(body);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "documents" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
    const doc = await tx.document.findFirst({ where: { id: documentId, organizationId } });
    if (!doc) throw new NotFoundError("Document");
    if (snapshot.dealId && doc.hubspotDealId && snapshot.dealId !== doc.hubspotDealId) {
      throw new ValidationError("The snapshot's deal_id does not match the document's HubSpot deal.");
    }
    const initial = doc.dealDataStatus === "REQUESTED" && !doc.publishedVersionId && !(await tx.dealSnapshot.count({ where: { documentId, status: "APPLIED" } }));
    const autoApply = initial && Boolean(doc.draftVersionId) && !(await userHasEdited(tx, documentId));
    const record = await tx.dealSnapshot.create({
      data: {
        organizationId,
        documentId,
        dealId: snapshot.dealId ?? doc.hubspotDealId,
        kind: initial ? "INITIAL" : "REFRESH",
        status: autoApply ? "APPLIED" : "PENDING_REVIEW",
        payload: snapshot as unknown as Prisma.InputJsonValue,
        resolvedAt: autoApply ? new Date() : null,
      },
    });
    if (autoApply) {
      await applyToDraft(tx, { organizationId, documentId, snapshot, selection: { sections: ["contact", "company", "deal", "customProperties", "recipient"], lineItems: "replace" }, initial: true });
    }
    // Older pending snapshots are superseded by the newest one.
    await tx.dealSnapshot.updateMany({ where: { documentId, status: "PENDING_REVIEW", id: { not: record.id } }, data: { status: "DISMISSED", resolvedAt: new Date() } });
    await tx.document.update({ where: { id: documentId }, data: { dealDataStatus: autoApply ? "APPLIED" : "PENDING_REVIEW" } });
    await recordEvent(tx, doc, "HUBSPOT_DATA_RECEIVED", { type: "SYSTEM", label: "Zapier" }, null, { snapshotId: record.id, applied: autoApply, lineItems: snapshot.lineItems?.length ?? 0 });
    return { snapshotId: record.id, applied: autoApply, status: record.status };
  });
}

/** User decision on a pending snapshot (explicit, per section). */
export async function resolveSnapshot(ctx: OrgContext, documentId: string, snapshotId: string, selection: ApplySelection | "dismiss") {
  assertWritable(ctx);
  const doc = await loadDocumentForEdit(ctx, documentId);
  await prisma.$transaction(async (tx) => {
    const snap = await tx.dealSnapshot.findFirst({ where: { id: snapshotId, documentId: doc.id, organizationId: ctx.organizationId } });
    if (!snap) throw new NotFoundError("HubSpot data");
    if (snap.status !== "PENDING_REVIEW") throw new ConflictError("This HubSpot data was already handled.");
    if (selection !== "dismiss") {
      await applyToDraft(tx, { organizationId: ctx.organizationId, documentId: doc.id, snapshot: snap.payload as unknown as NormalizedSnapshot, selection, initial: snap.kind === "INITIAL" });
    }
    await tx.dealSnapshot.update({ where: { id: snap.id }, data: { status: selection === "dismiss" ? "DISMISSED" : "APPLIED", resolvedAt: new Date(), resolvedById: ctx.user.id } });
    await tx.document.update({ where: { id: doc.id }, data: { dealDataStatus: "APPLIED" } });
    await recordEvent(tx, doc, selection === "dismiss" ? "HUBSPOT_DATA_DISMISSED" : "HUBSPOT_DATA_APPLIED", userActor(ctx), null, selection === "dismiss" ? {} : { sections: selection.sections, lineItems: selection.lineItems });
    await audit(
      {
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        action: selection === "dismiss" ? "DEAL_SNAPSHOT_DISMISSED" : "DEAL_SNAPSHOT_APPLIED",
        entityType: "Document",
        entityId: doc.id,
        metadata: selection === "dismiss" ? { snapshotId } : { snapshotId, ...selection },
      },
      tx,
    );
  });
}

/** Differences between a snapshot and the current draft, for the review screen. */
export function diffSnapshot(data: DocumentData, snap: NormalizedSnapshot, propertyMap: Record<string, string>) {
  const rows: { section: SnapshotSection; field: string; current: string; incoming: string }[] = [];
  const add = (section: SnapshotSection, field: string, current: string, incoming: string) => {
    if ((current ?? "") !== (incoming ?? "")) rows.push({ section, field, current: current ?? "", incoming: incoming ?? "" });
  };
  if (snap.contact) {
    add("contact", "First name", data.contact.firstName, snap.contact.firstName);
    add("contact", "Last name", data.contact.lastName, snap.contact.lastName);
    add("contact", "Email", data.contact.email, snap.contact.email);
    add("contact", "Phone", data.contact.phone, snap.contact.phone);
    add("contact", "Job title", data.contact.jobTitle, snap.contact.jobTitle);
  }
  if (snap.company) {
    add("company", "Company", data.company.name, snap.company.name);
    add("company", "Address", data.company.address, snap.company.address);
    add("company", "City", data.company.city, snap.company.city);
    add("company", "Postal code", data.company.zip, snap.company.zip);
    add("company", "Country", data.company.country, snap.company.country);
  }
  if (snap.deal) {
    add("deal", "Deal name", data.deal.name, snap.deal.name);
    add("deal", "Amount", data.deal.amount, snap.deal.amount);
    add("deal", "Stage", data.deal.stage, snap.deal.stage);
    add("deal", "Close date", data.deal.closeDate, snap.deal.closeDate);
    add("deal", "Owner", data.deal.owner.name, snap.deal.ownerName);
  }
  for (const [key, value] of Object.entries(customPropertyVariables(snap.customProperties, propertyMap))) add("customProperties", key, data.hubspotProperties[key] ?? "", value);
  return rows;
}
