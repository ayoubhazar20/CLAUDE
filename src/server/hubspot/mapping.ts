import type { Document, DocumentStatus, HubSpotObjectType, HubSpotPropertyMapping } from "@prisma/client";
import type { DocumentData } from "@/domain/document-data";
import { VARIABLE_KEY_PATTERN } from "@/domain/variables";

/**
 * Pure mapping logic (no I/O) — HubSpot properties ⇄ DealDocs variables.
 */

/** Standard properties always requested when importing a deal. */
export const STANDARD_PROPERTIES: Record<"deals" | "contacts" | "companies" | "line_items" | "products", string[]> = {
  deals: ["dealname", "amount", "pipeline", "dealstage", "closedate", "hubspot_owner_id", "deal_currency_code"],
  contacts: ["firstname", "lastname", "email", "phone", "jobtitle", "company"],
  companies: ["name", "address", "city", "zip", "country", "phone", "domain"],
  line_items: ["name", "description", "quantity", "price", "hs_sku", "discount", "hs_discount_percentage", "hs_product_id", "hs_tax_rate", "hs_line_item_currency_code", "hs_position_on_quote"],
  products: ["name", "description", "price", "hs_sku", "hs_product_type"],
};

export const OBJECT_TYPE_API: Record<HubSpotObjectType, string> = {
  DEAL: "deals",
  CONTACT: "contacts",
  COMPANY: "companies",
  LINE_ITEM: "line_items",
  PRODUCT: "products",
  OWNER: "owners",
};

/** Built-in DealDocs data paths that a mapping may target (overrides the standard import). */
const DATA_PATHS: Record<string, (data: DocumentData, value: string) => void> = {
  "contact.firstName": (d, v) => (d.contact.firstName = v),
  "contact.lastName": (d, v) => (d.contact.lastName = v),
  "contact.email": (d, v) => (d.contact.email = v),
  "contact.phone": (d, v) => (d.contact.phone = v),
  "contact.jobTitle": (d, v) => (d.contact.jobTitle = v),
  "company.name": (d, v) => (d.company.name = v),
  "company.address": (d, v) => (d.company.address = v),
  "company.city": (d, v) => (d.company.city = v),
  "company.zip": (d, v) => (d.company.zip = v),
  "company.country": (d, v) => (d.company.country = v),
  "company.phone": (d, v) => (d.company.phone = v),
  "company.domain": (d, v) => (d.company.domain = v),
  "deal.name": (d, v) => (d.deal.name = v),
  "deal.amount": (d, v) => (d.deal.amount = v),
  "deal.closeDate": (d, v) => (d.deal.closeDate = v),
};

export function isValidVariableKey(key: string): boolean {
  return VARIABLE_KEY_PATTERN.test(key) && key.length <= 120;
}

export function isValidHubSpotPropertyName(name: string): boolean {
  return /^[a-z0-9_]{1,100}$/i.test(name);
}

/** Extra property names to request per object type, from import mappings. */
export function requestedProperties(mappings: Pick<HubSpotPropertyMapping, "objectType" | "hubspotProperty" | "direction" | "enabled">[]) {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(STANDARD_PROPERTIES)) out[k] = [...v];
  for (const m of mappings) {
    if (m.direction !== "IMPORT" || !m.enabled) continue;
    const api = OBJECT_TYPE_API[m.objectType];
    out[api] ??= [];
    if (!out[api]!.includes(m.hubspotProperty)) out[api]!.push(m.hubspotProperty);
  }
  return out;
}

export interface ImportedObjects {
  deal: Record<string, string | null>;
  contact: Record<string, string | null> | null;
  company: Record<string, string | null> | null;
  owner: Record<string, string | null> | null;
}

/** Apply configured import mappings onto document data (mutates a copy and returns it). */
export function applyImportMappings(
  data: DocumentData,
  mappings: Pick<HubSpotPropertyMapping, "objectType" | "hubspotProperty" | "variableKey" | "direction" | "enabled">[],
  objects: ImportedObjects,
): DocumentData {
  const next: DocumentData = structuredClone(data);
  for (const m of mappings) {
    if (m.direction !== "IMPORT" || !m.enabled) continue;
    const source =
      m.objectType === "DEAL" ? objects.deal : m.objectType === "CONTACT" ? objects.contact : m.objectType === "COMPANY" ? objects.company : m.objectType === "OWNER" ? objects.owner : null;
    if (!source) continue;
    const raw = source[m.hubspotProperty];
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    const setter = DATA_PATHS[m.variableKey];
    if (setter) setter(next, value);
    else next.hubspotProperties[m.variableKey] = value;
  }
  return next;
}

// ───────────────────────── Writeback ─────────────────────────

export const WRITEBACK_SOURCES = [
  { key: "latestQuote.number", label: "Latest Quote ID", suggestedProperty: "dealdocs_latest_quote_id", type: "string" },
  { key: "latestQuote.status", label: "Latest Quote Status", suggestedProperty: "dealdocs_latest_quote_status", type: "string" },
  { key: "latestQuote.url", label: "Latest Quote URL", suggestedProperty: "dealdocs_latest_quote_url", type: "string" },
  { key: "latestQuote.amount", label: "Latest Quote Amount", suggestedProperty: "dealdocs_latest_quote_amount", type: "number" },
  { key: "latestQuote.publishedDate", label: "Quote Published Date", suggestedProperty: "dealdocs_quote_published_date", type: "datetime" },
  { key: "latestQuote.acceptedDate", label: "Quote Accepted Date", suggestedProperty: "dealdocs_quote_accepted_date", type: "datetime" },
  { key: "latestContract.number", label: "Latest Contract ID", suggestedProperty: "dealdocs_latest_contract_id", type: "string" },
  { key: "latestContract.status", label: "Latest Contract Status", suggestedProperty: "dealdocs_latest_contract_status", type: "string" },
  { key: "latestContract.url", label: "Contract URL", suggestedProperty: "dealdocs_contract_url", type: "string" },
  { key: "latestContract.sentDate", label: "Contract Sent Date", suggestedProperty: "dealdocs_contract_sent_date", type: "datetime" },
  { key: "latestContract.signedDate", label: "Contract Signed Date", suggestedProperty: "dealdocs_contract_signed_date", type: "datetime" },
  { key: "primaryDocument.number", label: "Primary Document ID", suggestedProperty: "dealdocs_primary_document_id", type: "string" },
  { key: "primaryDocument.status", label: "Primary Document Status", suggestedProperty: "dealdocs_primary_document_status", type: "string" },
  { key: "document.owner", label: "Document Owner", suggestedProperty: "dealdocs_document_owner", type: "string" },
] as const;

export type WritebackSourceKey = (typeof WRITEBACK_SOURCES)[number]["key"];

type DocLike = Pick<
  Document,
  "type" | "number" | "status" | "publicToken" | "grandTotal" | "publishedAt" | "firstPublishedAt" | "acceptedAt" | "sentAt" | "signedAt" | "isPrimary" | "createdAt" | "archivedAt" | "publishedVersionId"
> & { ownerName: string };

const STATUS_TEXT: Record<DocumentStatus, string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  SENT: "Sent",
  VIEWED: "Viewed",
  AWAITING_SIGNATURE: "Awaiting Signature",
  ACCEPTED: "Accepted",
  SIGNED: "Signed",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
};

/**
 * Compute writeback values for a deal from all its (non-archived) documents.
 * "Latest" = most recently created document of that type that has been published.
 */
export function computeWritebackValues(docs: DocLike[], publicUrl: (token: string) => string): Partial<Record<WritebackSourceKey, string>> {
  const active = docs.filter((d) => !d.archivedAt && d.publishedVersionId);
  const latest = (type: "QUOTE" | "CONTRACT") =>
    active.filter((d) => d.type === type).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const out: Partial<Record<WritebackSourceKey, string>> = {};
  const q = latest("QUOTE");
  if (q) {
    out["latestQuote.number"] = q.number;
    out["latestQuote.status"] = STATUS_TEXT[q.status];
    out["latestQuote.url"] = publicUrl(q.publicToken);
    out["latestQuote.amount"] = q.grandTotal.toString();
    if (q.firstPublishedAt ?? q.publishedAt) out["latestQuote.publishedDate"] = (q.firstPublishedAt ?? q.publishedAt)!.toISOString();
    if (q.acceptedAt) out["latestQuote.acceptedDate"] = q.acceptedAt.toISOString();
  }
  const c = latest("CONTRACT");
  if (c) {
    out["latestContract.number"] = c.number;
    out["latestContract.status"] = STATUS_TEXT[c.status];
    out["latestContract.url"] = publicUrl(c.publicToken);
    if (c.sentAt) out["latestContract.sentDate"] = c.sentAt.toISOString();
    if (c.signedAt) out["latestContract.signedDate"] = c.signedAt.toISOString();
  }
  const primary = active.find((d) => d.isPrimary);
  if (primary) {
    out["primaryDocument.number"] = primary.number;
    out["primaryDocument.status"] = STATUS_TEXT[primary.status];
  }
  const newest = [...active].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (newest) out["document.owner"] = newest.ownerName;
  return out;
}

export function buildWritebackProperties(
  values: Partial<Record<string, string>>,
  mappings: Pick<HubSpotPropertyMapping, "hubspotProperty" | "variableKey" | "direction" | "enabled" | "objectType">[],
): Record<string, string> {
  const props: Record<string, string> = {};
  for (const m of mappings) {
    if (m.direction !== "WRITEBACK" || !m.enabled || m.objectType !== "DEAL") continue;
    const value = values[m.variableKey];
    if (value !== undefined) props[m.hubspotProperty] = value;
  }
  return props;
}
