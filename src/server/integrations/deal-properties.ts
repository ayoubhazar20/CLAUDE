import type { Document, DocumentStatus } from "@prisma/client";

/**
 * Values DealDocs suggests for HubSpot Deal properties, computed from all
 * documents of a deal. Zapier maps them onto the deal (pipeline changes stay in
 * Zapier / HubSpot workflows, outside DealDocs).
 */
export const DEFAULT_STATUS_LABELS: Record<DocumentStatus, string> = {
  DRAFT: "draft",
  PUBLISHED: "published",
  SENT: "sent",
  VIEWED: "viewed",
  AWAITING_SIGNATURE: "awaiting_signature",
  ACCEPTED: "accepted",
  SIGNED: "signed",
  REJECTED: "rejected",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
};

export const DEAL_PROPERTY_KEYS = [
  "latest_quote_status",
  "latest_quote_id",
  "latest_quote_url",
  "latest_quote_amount",
  "latest_contract_status",
  "latest_contract_id",
  "latest_contract_url",
  "document_signed",
  "latest_document_updated_at",
] as const;
export type DealPropertyKey = (typeof DEAL_PROPERTY_KEYS)[number];

/** Default HubSpot deal property names (overridable per organization). */
export const DEFAULT_DEAL_PROPERTY_NAMES: Record<DealPropertyKey, string> = Object.fromEntries(DEAL_PROPERTY_KEYS.map((k) => [k, k])) as Record<DealPropertyKey, string>;

type DocLike = Pick<Document, "type" | "number" | "status" | "publicToken" | "grandTotal" | "createdAt" | "updatedAt" | "archivedAt" | "publishedVersionId" | "signedAt">;

export function computeDealPropertyValues(docs: DocLike[], labels: Record<string, string>, publicUrl: (token: string) => string): Partial<Record<DealPropertyKey, string>> {
  const active = docs.filter((d) => !d.archivedAt);
  const newest = (type: "QUOTE" | "CONTRACT") => active.filter((d) => d.type === type).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const out: Partial<Record<DealPropertyKey, string>> = {};
  const q = newest("QUOTE");
  if (q) {
    out.latest_quote_status = labels[q.status] ?? q.status;
    out.latest_quote_id = q.number;
    out.latest_quote_url = q.publishedVersionId ? publicUrl(q.publicToken) : "";
    out.latest_quote_amount = q.grandTotal.toString();
  }
  const c = newest("CONTRACT");
  if (c) {
    out.latest_contract_status = labels[c.status] ?? c.status;
    out.latest_contract_id = c.number;
    out.latest_contract_url = c.publishedVersionId ? publicUrl(c.publicToken) : "";
  }
  out.document_signed = active.some((d) => d.status === "SIGNED" || (d.type === "CONTRACT" && d.signedAt)) ? "true" : "false";
  const latest = [...active].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  if (latest) out.latest_document_updated_at = latest.updatedAt.toISOString();
  return out;
}

/** Rename keys to the organization's HubSpot property names. */
export function renameDealProperties(values: Partial<Record<DealPropertyKey, string>>, names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined && names[k]) out[names[k]] = v;
  return out;
}
