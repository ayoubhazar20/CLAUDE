import type { AcceptanceMode, DocumentType } from "@prisma/client";
import type { Block, BlockProps } from "./blocks";
import { evaluateCondition, type ConditionContext } from "./conditions";
import type { DocumentData } from "./document-data";
import { dec, formatMoney } from "./money";
import type { PricingConfig, PricingTotals } from "./pricing";
import { sanitizeRichText } from "./richtext";
import { escapeHtml, interpolate } from "./variables";

/**
 * Shared resolution step: template/document blocks + data → render-ready tree.
 * Consumed by the React renderer (editor preview + public page) AND the PDF
 * renderer, so all three outputs show the same content.
 */

export interface ResolveLineItem {
  key: string;
  name: string;
  description: string | null;
  sku: string | null;
  category: string | null;
  quantity: string;
  unitPrice: string;
  discountType: "NONE" | "PERCENT" | "AMOUNT";
  discountValue: string;
  taxKeys: string[];
  optional: boolean;
}

export interface ResolveOrganization {
  name: string;
  legalName: string | null;
  addressLines: string[];
  phone: string | null;
  website: string | null;
  vatNumber: string | null;
  registrationNumber: string | null;
  brandColor: string;
  logoUrl: string | null;
}

export interface ResolveSignature {
  recipientId: string;
  name: string;
  email: string;
  kind: "ACCEPTANCE" | "SIGNATURE";
  method: "CLICK_ACCEPT" | "TYPED" | "DRAWN";
  signatureData: string | null;
  signedAt: Date;
}

export interface ResolveRecipient {
  id: string;
  name: string;
  email: string;
  role: string;
  signingOrder: number;
}

export interface ResolveInput {
  blocks: Block[];
  data: DocumentData;
  lineItems: ResolveLineItem[];
  pricingConfig: PricingConfig;
  totals: PricingTotals;
  currency: string;
  organization: ResolveOrganization;
  document: {
    type: DocumentType;
    number: string;
    title: string;
    versionNumber: number;
    date: Date;
    expiresAt: Date | null;
    url: string;
    acceptanceMode: AcceptanceMode;
  };
  recipients: ResolveRecipient[];
  signatures: ResolveSignature[];
  timezone: string;
  imageUrl: (fileId: string) => string;
  /** In the editor, unresolved variables are shown as a chip instead of blank. */
  showMissingVariables?: boolean;
}

export type ResolvedBlock =
  | { id: string; type: "heading"; text: string; level: 1 | 2 | 3; align: string }
  | { id: string; type: "paragraph"; text: string; align: string }
  | { id: string; type: "richText"; html: string }
  | { id: string; type: "logo"; url: string | null; alt: string; align: string; maxHeight: number }
  | { id: string; type: "image"; url: string | null; alt: string; width: string; align: string }
  | { id: string; type: "divider" }
  | { id: string; type: "spacer"; size: "sm" | "md" | "lg" }
  | { id: string; type: "infoCard"; variant: "company" | "client" | "deal"; title: string; lines: { label?: string; value: string }[] }
  | { id: string; type: "dynamicProperty"; label: string; value: string }
  | {
      id: string;
      type: "productTable";
      title: string;
      columns: { key: "name" | "sku" | "quantity" | "unitPrice" | "discount" | "taxes" | "total"; label: string; align: "left" | "right" }[];
      rows: { name: string; description: string | null; sku: string; quantity: string; unitPrice: string; discount: string; taxes: string; total: string; optional: boolean }[];
    }
  | { id: string; type: "pricingSummary"; title: string; rows: { label: string; value: string; emphasis?: boolean }[] }
  | { id: string; type: "simpleTable"; title: string; columns: string[]; rows: string[][]; alignLastRight?: boolean }
  | { id: string; type: "section"; title: string; html: string; variant: "terms" | "clause" }
  | { id: string; type: "container"; title: string; children: ResolvedBlock[] }
  | {
      id: string;
      type: "signatureArea";
      title: string;
      text: string;
      signers: { recipientId: string; name: string; email: string; role: string; order: number; signature: ResolveSignature | null; signedAtLabel: string | null }[];
    }
  | { id: string; type: "acceptanceArea"; title: string; text: string; acceptance: (ResolveSignature & { signedAtLabel: string }) | null }
  | { id: string; type: "pageBreak" };

export interface ResolvedDocument {
  blocks: ResolvedBlock[];
  variables: Record<string, string>;
  brandColor: string;
}

export function formatDate(date: Date | null | undefined, timezone: string): string {
  if (!date) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(date);
  }
}

export function formatDateTime(date: Date | null | undefined, timezone: string): string {
  if (!date) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: timezone, timeZoneName: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatIsoDateString(value: string, timezone: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  // Date-only strings are calendar dates; keep them in UTC to avoid shifting a day.
  return formatDate(d, /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : timezone);
}

/** Display-formatted variable values (used for interpolation). */
export function buildVariables(input: Pick<ResolveInput, "data" | "totals" | "currency" | "organization" | "document" | "timezone">): {
  display: Record<string, string>;
  raw: Record<string, string>;
} {
  const { data, totals, currency, organization, document, timezone } = input;
  const c = data.contact;
  const co = data.company;
  const deal = data.deal;
  const raw: Record<string, string> = {
    "contact.firstName": c.firstName,
    "contact.lastName": c.lastName,
    "contact.fullName": [c.firstName, c.lastName].filter(Boolean).join(" "),
    "contact.email": c.email,
    "contact.phone": c.phone,
    "contact.jobTitle": c.jobTitle,
    "company.name": co.name,
    "company.address": co.address,
    "company.city": co.city,
    "company.zip": co.zip,
    "company.country": co.country,
    "company.phone": co.phone,
    "company.domain": co.domain,
    "deal.name": deal.name,
    "deal.amount": deal.amount,
    "deal.pipeline": deal.pipeline,
    "deal.stage": deal.stage,
    "deal.closeDate": deal.closeDate,
    "deal.owner.name": deal.owner.name,
    "deal.owner.email": deal.owner.email,
    "document.number": document.number,
    "document.title": document.title,
    "document.type": document.type === "QUOTE" ? "Quote" : "Contract",
    "document.date": document.date.toISOString(),
    "document.version": String(document.versionNumber),
    "document.currency": currency,
    "document.subtotal": totals.subtotal,
    "document.discountTotal": totals.discountTotal,
    "document.taxTotal": totals.taxTotal,
    "document.total": totals.grandTotal,
    "document.expirationDate": document.expiresAt ? document.expiresAt.toISOString() : "",
    "document.url": document.url,
    "sender.name": data.sender.name,
    "sender.email": data.sender.email,
    "organization.name": organization.name,
    "organization.legalName": organization.legalName ?? organization.name,
    "organization.address": organization.addressLines.join(", "),
    "organization.vatNumber": organization.vatNumber ?? "",
    "organization.registrationNumber": organization.registrationNumber ?? "",
  };
  for (const [key, value] of Object.entries(data.hubspotProperties)) raw[key] = value;
  for (const [key, value] of Object.entries(data.customFields)) raw[key] = value;

  const display: Record<string, string> = { ...raw };
  for (const key of ["document.subtotal", "document.discountTotal", "document.taxTotal", "document.total"]) {
    display[key] = formatMoney(raw[key] ?? "0", currency);
  }
  if (deal.amount && /^-?\d+(\.\d+)?$/.test(deal.amount)) display["deal.amount"] = formatMoney(deal.amount, currency);
  display["document.date"] = formatDate(document.date, timezone);
  display["document.expirationDate"] = formatDate(document.expiresAt, timezone);
  display["deal.closeDate"] = formatIsoDateString(deal.closeDate, timezone);
  return { display, raw };
}

function percent(value: string): string {
  return `${dec(value).toDecimalPlaces(4).toString()}%`;
}

export function resolveDocument(input: ResolveInput): ResolvedDocument {
  const { display, raw } = buildVariables(input);
  const { currency, timezone } = input;
  const missing = input.showMissingVariables ? (key: string) => `[${key}]` : () => "";
  const text = (value: string) => interpolate(value, display, (v) => v, missing);
  const html = (value: string) =>
    interpolate(sanitizeRichText(value), display, escapeHtml, (key) => (input.showMissingVariables ? `<span data-variable="${escapeHtml(key)}">[${escapeHtml(key)}]</span>` : ""));

  const conditionCtx: ConditionContext = {
    values: raw,
    lineItems: input.lineItems.map((li) => ({
      name: li.name,
      category: li.category ?? "",
      sku: li.sku ?? "",
      description: li.description ?? "",
    })),
  };

  const taxNames = new Map(input.pricingConfig.taxes.map((t) => [t.key, `${t.name} ${percent(t.rate)}`]));
  const lineTotals = new Map(input.totals.lines.map((l) => [l.key, l]));
  const signaturesByRecipient = new Map<string, ResolveSignature>();
  for (const s of input.signatures) signaturesByRecipient.set(`${s.recipientId}:${s.kind}`, s);

  const resolveBlock = (block: Block): ResolvedBlock | null => {
    if (!evaluateCondition(block.condition, conditionCtx)) return null;
    const id = block.id;
    switch (block.type) {
      case "heading": {
        const p = block.props as BlockProps<"heading">;
        return { id, type: "heading", text: text(p.text), level: p.level, align: p.align };
      }
      case "paragraph": {
        const p = block.props as BlockProps<"paragraph">;
        return { id, type: "paragraph", text: text(p.text), align: p.align };
      }
      case "richText": {
        const p = block.props as BlockProps<"richText">;
        return { id, type: "richText", html: html(p.html) };
      }
      case "logo": {
        const p = block.props as BlockProps<"logo">;
        return { id, type: "logo", url: input.organization.logoUrl, alt: input.organization.name, align: p.align, maxHeight: p.maxHeight };
      }
      case "image": {
        const p = block.props as BlockProps<"image">;
        return { id, type: "image", url: p.fileId ? input.imageUrl(p.fileId) : null, alt: p.alt, width: p.width, align: p.align };
      }
      case "divider":
        return { id, type: "divider" };
      case "spacer":
        return { id, type: "spacer", size: (block.props as BlockProps<"spacer">).size };
      case "pageBreak":
        return { id, type: "pageBreak" };
      case "companyInfo": {
        const p = block.props as BlockProps<"companyInfo">;
        const org = input.organization;
        const lines: { label?: string; value: string }[] = [{ value: org.legalName || org.name }];
        if (p.showAddress) org.addressLines.forEach((l) => lines.push({ value: l }));
        if (p.showContact) {
          if (org.phone) lines.push({ value: org.phone });
          if (org.website) lines.push({ value: org.website });
          if (input.data.sender.name) lines.push({ label: "Contact", value: [input.data.sender.name, input.data.sender.email].filter(Boolean).join(" · ") });
        }
        if (p.showTaxIds) {
          if (org.registrationNumber) lines.push({ label: "Reg. no.", value: org.registrationNumber });
          if (org.vatNumber) lines.push({ label: "VAT", value: org.vatNumber });
        }
        return { id, type: "infoCard", variant: "company", title: text(p.title), lines };
      }
      case "clientInfo": {
        const p = block.props as BlockProps<"clientInfo">;
        const c = input.data.contact;
        const co = input.data.company;
        const lines: { label?: string; value: string }[] = [];
        const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ");
        if (fullName) lines.push({ value: fullName + (c.jobTitle ? `, ${c.jobTitle}` : "") });
        if (co.name) lines.push({ value: co.name });
        if (p.showAddress) {
          if (co.address) lines.push({ value: co.address });
          const cityLine = [co.zip, co.city].filter(Boolean).join(" ");
          if (cityLine || co.country) lines.push({ value: [cityLine, co.country].filter(Boolean).join(", ") });
        }
        if (p.showEmail && c.email) lines.push({ value: c.email });
        if (p.showPhone && (c.phone || co.phone)) lines.push({ value: c.phone || co.phone });
        return { id, type: "infoCard", variant: "client", title: text(p.title), lines };
      }
      case "dealInfo": {
        const p = block.props as BlockProps<"dealInfo">;
        const labels: Record<string, string> = {
          "document.number": "Number",
          "document.date": "Date",
          "document.expirationDate": "Valid until",
          "document.version": "Version",
          "deal.name": "Deal",
          "deal.owner.name": "Prepared by",
          "deal.closeDate": "Expected close",
          "deal.amount": "Deal amount",
          "document.total": "Total",
        };
        const lines = p.fields
          .map((key) => ({ label: labels[key] ?? key.split(".").pop() ?? key, value: display[key] ?? "" }))
          .filter((l) => l.value !== "");
        return { id, type: "infoCard", variant: "deal", title: text(p.title), lines };
      }
      case "dynamicProperty": {
        const p = block.props as BlockProps<"dynamicProperty">;
        const value = p.variable ? display[p.variable] ?? "" : "";
        return { id, type: "dynamicProperty", label: text(p.label), value: value || missing(p.variable) };
      }
      case "productTable": {
        const p = block.props as BlockProps<"productTable">;
        const hasDiscount = p.showDiscount && input.lineItems.some((li) => li.discountType !== "NONE" && !dec(li.discountValue).isZero());
        const columns: Extract<ResolvedBlock, { type: "productTable" }>["columns"] = [{ key: "name", label: "Item", align: "left" }];
        if (p.showSku) columns.push({ key: "sku", label: "SKU", align: "left" });
        columns.push({ key: "quantity", label: "Qty", align: "right" }, { key: "unitPrice", label: "Unit price", align: "right" });
        if (hasDiscount) columns.push({ key: "discount", label: "Discount", align: "right" });
        if (p.showTaxes) columns.push({ key: "taxes", label: "Tax", align: "left" });
        columns.push({ key: "total", label: "Total", align: "right" });
        const rows = input.lineItems.map((li) => {
          const t = lineTotals.get(li.key);
          const discount =
            li.discountType === "PERCENT" && !dec(li.discountValue).isZero()
              ? `${percent(li.discountValue)}`
              : li.discountType === "AMOUNT" && !dec(li.discountValue).isZero()
                ? formatMoney(li.discountValue, currency)
                : "";
          return {
            name: text(li.name),
            description: p.showDescription && li.description ? text(li.description) : null,
            sku: li.sku ?? "",
            quantity: dec(li.quantity).toDecimalPlaces(6).toString(),
            unitPrice: formatMoney(li.unitPrice, currency),
            discount,
            taxes: li.taxKeys.map((k) => taxNames.get(k)).filter(Boolean).join(", "),
            total: formatMoney(t?.net ?? "0", currency),
            optional: li.optional,
          };
        });
        return { id, type: "productTable", title: text(p.title), columns, rows };
      }
      case "pricingSummary": {
        const p = block.props as BlockProps<"pricingSummary">;
        const t = input.totals;
        const rows: { label: string; value: string; emphasis?: boolean }[] = [{ label: "Subtotal", value: formatMoney(t.subtotal, currency) }];
        if (!dec(t.globalDiscount).isZero()) {
          const cfg = input.pricingConfig;
          const label = cfg.globalDiscountType === "PERCENT" ? `Discount (${percent(cfg.globalDiscountValue)})` : "Discount";
          rows.push({ label, value: `-${formatMoney(t.globalDiscount, currency)}` });
        }
        for (const fee of t.fees) rows.push({ label: fee.name, value: formatMoney(fee.amount, currency) });
        if (p.showTaxBreakdown) {
          for (const tax of t.taxes) rows.push({ label: `${tax.name} (${percent(tax.rate)})`, value: formatMoney(tax.amount, currency) });
        } else if (!dec(t.taxTotal).isZero()) {
          rows.push({ label: "Taxes", value: formatMoney(t.taxTotal, currency) });
        }
        rows.push({ label: "Total", value: formatMoney(t.grandTotal, currency), emphasis: true });
        return { id, type: "pricingSummary", title: text(p.title), rows };
      }
      case "taxes": {
        const p = block.props as BlockProps<"taxes">;
        return {
          id,
          type: "simpleTable",
          title: text(p.title),
          columns: ["Tax", "Rate", "Taxable amount", "Tax amount"],
          rows: input.totals.taxes.map((t) => [t.name, percent(t.rate), formatMoney(t.base, currency), formatMoney(t.amount, currency)]),
          alignLastRight: true,
        };
      }
      case "discount": {
        const p = block.props as BlockProps<"discount">;
        const rows: string[][] = [];
        if (!dec(input.totals.lineDiscountTotal).isZero()) rows.push(["Line item discounts", `-${formatMoney(input.totals.lineDiscountTotal, currency)}`]);
        if (!dec(input.totals.globalDiscount).isZero()) rows.push(["Global discount", `-${formatMoney(input.totals.globalDiscount, currency)}`]);
        rows.push(["Total discount", `-${formatMoney(input.totals.discountTotal, currency)}`]);
        return { id, type: "simpleTable", title: text(p.title), columns: ["Discount", "Amount"], rows, alignLastRight: true };
      }
      case "fees": {
        const p = block.props as BlockProps<"fees">;
        return {
          id,
          type: "simpleTable",
          title: text(p.title),
          columns: ["Fee", "Amount"],
          rows: input.totals.fees.map((f) => [f.name, formatMoney(f.amount, currency)]),
          alignLastRight: true,
        };
      }
      case "customTable": {
        const p = block.props as BlockProps<"customTable">;
        return { id, type: "simpleTable", title: text(p.title), columns: p.columns.map(text), rows: p.rows.map((r) => r.map(text)) };
      }
      case "terms":
      case "clause": {
        const p = block.props as BlockProps<"terms">;
        return { id, type: "section", title: text(p.title), html: html(p.html), variant: block.type };
      }
      case "conditionalSection":
      case "customSection": {
        const p = block.props as BlockProps<"customSection">;
        const children = (block.children ?? []).map(resolveBlock).filter((b): b is ResolvedBlock => b !== null);
        return { id, type: "container", title: text(p.title), children };
      }
      case "signatureArea": {
        const p = block.props as BlockProps<"signatureArea">;
        const signers = input.recipients
          .filter((r) => r.role === "SIGNER")
          .sort((a, b) => a.signingOrder - b.signingOrder)
          .map((r) => {
            const sig = signaturesByRecipient.get(`${r.id}:SIGNATURE`) ?? null;
            return {
              recipientId: r.id,
              name: r.name,
              email: r.email,
              role: r.role,
              order: r.signingOrder,
              signature: sig,
              signedAtLabel: sig ? formatDateTime(sig.signedAt, timezone) : null,
            };
          });
        return { id, type: "signatureArea", title: text(p.title), text: text(p.text), signers };
      }
      case "acceptanceArea": {
        const p = block.props as BlockProps<"acceptanceArea">;
        const acc = input.signatures.find((s) => s.kind === "ACCEPTANCE") ?? null;
        return {
          id,
          type: "acceptanceArea",
          title: text(p.title),
          text: text(p.text),
          acceptance: acc ? { ...acc, signedAtLabel: formatDateTime(acc.signedAt, timezone) } : null,
        };
      }
    }
  };

  const blocks = input.blocks.map(resolveBlock).filter((b): b is ResolvedBlock => b !== null);
  return { blocks, variables: display, brandColor: input.organization.brandColor };
}
