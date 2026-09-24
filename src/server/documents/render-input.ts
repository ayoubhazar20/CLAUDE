import type { Document, DocumentLineItem, DocumentRecipient, DocumentVersion, Organization, Signature } from "@prisma/client";
import { z } from "zod";
import { appUrl } from "../env";
import { parseBlocks } from "@/domain/blocks";
import { parseDocumentData, type DocumentData } from "@/domain/document-data";
import { calculatePricing, EMPTY_PRICING_CONFIG, type PricingConfig, type PricingLineInput } from "@/domain/pricing";
import { resolveDocument, type ResolveInput, type ResolveLineItem } from "@/domain/resolve";

export const pricingConfigSchema = z.object({
  globalDiscountType: z.enum(["NONE", "PERCENT", "AMOUNT"]).default("NONE"),
  globalDiscountValue: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/).default("0"),
  taxes: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        name: z.string().trim().min(1).max(60),
        rate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
      }),
    )
    .max(10)
    .default([]),
  fees: z
    .array(
      z.object({
        key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
        name: z.string().trim().min(1).max(120),
        amount: z.string().regex(/^\d{1,14}(\.\d{1,6})?$/),
        taxKeys: z.array(z.string().max(40)).max(10).default([]),
      }),
    )
    .max(20)
    .default([]),
});

export function parsePricingConfig(value: unknown): PricingConfig {
  return pricingConfigSchema.parse(value ?? EMPTY_PRICING_CONFIG);
}

type LineRow = Pick<DocumentLineItem, "id" | "name" | "description" | "sku" | "category" | "quantity" | "unitPrice" | "discountType" | "discountValue" | "taxKeys" | "optional" | "position">;

export function toPricingLines(lines: LineRow[]): PricingLineInput[] {
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      key: l.id,
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      discountType: l.discountType,
      discountValue: l.discountValue.toString(),
      taxKeys: l.taxKeys,
      optional: l.optional,
    }));
}

export function toResolveLines(lines: LineRow[]): ResolveLineItem[] {
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      key: l.id,
      name: l.name,
      description: l.description,
      sku: l.sku,
      category: l.category,
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      discountType: l.discountType,
      discountValue: l.discountValue.toString(),
      taxKeys: l.taxKeys,
      optional: l.optional,
    }));
}

export function organizationForRender(org: Organization, logoUrl: string | null): ResolveInput["organization"] {
  const cityLine = [org.postalCode, org.city].filter(Boolean).join(" ");
  const addressLines = [org.addressLine1, org.addressLine2, [cityLine, org.region].filter(Boolean).join(", "), org.country].filter(
    (l): l is string => Boolean(l && l.trim()),
  );
  return {
    name: org.name,
    legalName: org.legalName,
    addressLines,
    phone: org.phone,
    website: org.website,
    vatNumber: org.vatNumber,
    registrationNumber: org.registrationNumber,
    brandColor: org.brandColor,
    logoUrl,
  };
}

export interface BuildParams {
  document: Pick<Document, "type" | "number" | "title" | "publicToken" | "acceptanceMode" | "createdAt">;
  version: Pick<DocumentVersion, "content" | "data" | "pricingConfig" | "currency" | "versionNumber" | "expiresAt" | "publishedAt" | "createdAt">;
  lineItems: LineRow[];
  organization: Organization;
  recipients: Pick<DocumentRecipient, "id" | "name" | "email" | "role" | "signingOrder">[] | null;
  signatures: Pick<Signature, "recipientId" | "signerName" | "signerEmail" | "kind" | "method" | "signatureData" | "signedAt">[];
  logoUrl: string | null;
  imageUrl: (fileId: string) => string;
  showMissingVariables?: boolean;
  data?: DocumentData;
}

export function buildResolveInput(p: BuildParams): ResolveInput {
  const data = p.data ?? parseDocumentData(p.version.data);
  const pricingConfig = parsePricingConfig(p.version.pricingConfig);
  const totals = calculatePricing(toPricingLines(p.lineItems), pricingConfig, p.version.currency);
  // Draft versions take recipients from the draft data; published ones from the materialised rows.
  const recipients = p.recipients
    ? p.recipients.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, signingOrder: r.signingOrder }))
    : data.recipients.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, signingOrder: r.signingOrder }));
  return {
    blocks: parseBlocks(p.version.content),
    data,
    lineItems: toResolveLines(p.lineItems),
    pricingConfig,
    totals,
    currency: p.version.currency,
    organization: organizationForRender(p.organization, p.logoUrl),
    document: {
      type: p.document.type,
      number: p.document.number,
      title: p.document.title,
      versionNumber: p.version.versionNumber,
      date: p.version.publishedAt ?? p.version.createdAt,
      expiresAt: p.version.expiresAt,
      url: appUrl(`/d/${p.document.publicToken}`),
      acceptanceMode: p.document.acceptanceMode,
    },
    recipients,
    signatures: p.signatures.map((s) => ({
      recipientId: s.recipientId,
      name: s.signerName,
      email: s.signerEmail,
      kind: s.kind,
      method: s.method,
      signatureData: s.signatureData,
      signedAt: s.signedAt,
    })),
    timezone: p.organization.timezone,
    imageUrl: p.imageUrl,
    showMissingVariables: p.showMissingVariables,
  };
}

export function resolveFromRows(p: BuildParams) {
  const input = buildResolveInput(p);
  return { input, resolved: resolveDocument(input) };
}
