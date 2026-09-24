import { prisma } from "../db";
import type { OrgContext } from "../auth/context";
import { HubSpotClient, requireConnection, type HubSpotObject } from "./client";
import { applyImportMappings, requestedProperties } from "./mapping";
import { emptyDocumentData, type DocumentData } from "@/domain/document-data";
import { dec } from "@/domain/money";
import { isCurrencyCode } from "@/domain/currencies";

/**
 * Deal import. Reads the deal and its associations from HubSpot and produces a
 * document-specific snapshot. Nothing here writes to HubSpot.
 */

export interface ImportedContact {
  hubspotId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
}

export interface ImportedLineItem {
  hubspotLineItemId: string | null;
  hubspotProductId: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  discountType: "NONE" | "PERCENT" | "AMOUNT";
  discountValue: string;
  taxRate: string | null;
}

export interface DealImport {
  connectionId: string;
  portalId: string;
  dealId: string;
  dealName: string;
  currency: string | null;
  data: DocumentData;
  contacts: ImportedContact[];
  lineItems: ImportedLineItem[];
}

const s = (v: string | null | undefined) => (v ?? "").trim();

function toDecimalString(value: string | null | undefined, fallback = "0"): string {
  const raw = s(value);
  if (!raw) return fallback;
  try {
    return dec(raw).toString();
  } catch {
    return fallback;
  }
}

export function mapLineItem(li: HubSpotObject): ImportedLineItem {
  const p = li.properties;
  const quantity = toDecimalString(p.quantity, "1");
  const pct = toDecimalString(p.hs_discount_percentage);
  const unitDiscount = toDecimalString(p.discount);
  let discountType: ImportedLineItem["discountType"] = "NONE";
  let discountValue = "0";
  if (!dec(pct).isZero()) {
    discountType = "PERCENT";
    discountValue = pct;
  } else if (!dec(unitDiscount).isZero()) {
    // HubSpot "discount" is per unit; DealDocs stores the line discount amount.
    discountType = "AMOUNT";
    discountValue = dec(unitDiscount).times(dec(quantity)).toString();
  }
  const taxRate = s(p.hs_tax_rate);
  return {
    hubspotLineItemId: li.id,
    hubspotProductId: s(p.hs_product_id) || null,
    sku: s(p.hs_sku) || null,
    name: s(p.name) || "Item",
    description: s(p.description) || null,
    quantity,
    unitPrice: toDecimalString(p.price),
    discountType,
    discountValue,
    taxRate: taxRate && !dec(toDecimalString(taxRate)).isZero() ? toDecimalString(taxRate) : null,
  };
}

function mapContact(c: HubSpotObject): ImportedContact {
  return {
    hubspotId: c.id,
    firstName: s(c.properties.firstname),
    lastName: s(c.properties.lastname),
    email: s(c.properties.email),
    phone: s(c.properties.phone),
    jobTitle: s(c.properties.jobtitle),
  };
}

export async function importDeal(ctx: OrgContext, dealId: string, options: { contactId?: string | null } = {}): Promise<DealImport> {
  const connection = await requireConnection(ctx.organizationId);
  const client = new HubSpotClient(connection.id);
  const mappings = await prisma.hubSpotPropertyMapping.findMany({ where: { organizationId: ctx.organizationId, direction: "IMPORT", enabled: true } });
  const props = requestedProperties(mappings);

  const deal = await client.getObject("deals", dealId, props.deals ?? [], ["contacts", "companies", "line_items"]);
  const assoc = (key: string) => [...new Set((deal.associations?.[key]?.results ?? []).map((r) => r.id))];

  const [contacts, companies, lineItems, pipelines] = await Promise.all([
    client.batchRead("contacts", assoc("contacts"), props.contacts ?? []),
    client.batchRead("companies", assoc("companies").slice(0, 1), props.companies ?? []),
    client.batchRead("line_items", assoc("line items").length ? assoc("line items") : assoc("line_items"), props.line_items ?? []),
    client.getPipelines("deals").catch(() => ({ results: [] })),
  ]);
  const ownerId = s(deal.properties.hubspot_owner_id);
  const owner = ownerId ? await client.getOwner(ownerId).catch(() => null) : null;

  const pipeline = pipelines.results.find((p) => p.id === deal.properties.pipeline);
  const stage = pipeline?.stages.find((st) => st.id === deal.properties.dealstage);

  const mappedContacts = contacts.map(mapContact);
  const selected = mappedContacts.find((c) => c.hubspotId === options.contactId) ?? mappedContacts.find((c) => c.email) ?? mappedContacts[0] ?? null;
  const selectedRaw = contacts.find((c) => c.id === selected?.hubspotId) ?? null;
  const company = companies[0] ?? null;

  const data = emptyDocumentData();
  data.deal = {
    hubspotId: deal.id,
    name: s(deal.properties.dealname),
    amount: toDecimalString(deal.properties.amount, ""),
    pipeline: pipeline?.label ?? s(deal.properties.pipeline),
    pipelineId: s(deal.properties.pipeline),
    stage: stage?.label ?? s(deal.properties.dealstage),
    stageId: s(deal.properties.dealstage),
    closeDate: s(deal.properties.closedate),
    owner: {
      hubspotId: ownerId || null,
      name: owner ? [owner.firstName, owner.lastName].filter(Boolean).join(" ") : "",
      email: owner?.email ?? "",
    },
  };
  if (selected) data.contact = { ...selected, hubspotId: selected.hubspotId };
  if (company) {
    const cp = company.properties;
    data.company = {
      hubspotId: company.id,
      name: s(cp.name),
      address: s(cp.address),
      city: s(cp.city),
      zip: s(cp.zip),
      country: s(cp.country),
      phone: s(cp.phone),
      domain: s(cp.domain),
    };
  } else if (selectedRaw?.properties.company) {
    data.company.name = s(selectedRaw.properties.company);
  }

  const withMappings = applyImportMappings(data, mappings, {
    deal: deal.properties,
    contact: selectedRaw?.properties ?? null,
    company: company?.properties ?? null,
    owner: owner ? { firstName: owner.firstName ?? null, lastName: owner.lastName ?? null, email: owner.email ?? null } : null,
  });

  const sortedItems = [...lineItems].sort((a, b) => Number(a.properties.hs_position_on_quote ?? 0) - Number(b.properties.hs_position_on_quote ?? 0));
  const currency = s(deal.properties.deal_currency_code);
  return {
    connectionId: connection.id,
    portalId: connection.portalId,
    dealId: deal.id,
    dealName: s(deal.properties.dealname),
    currency: currency && isCurrencyCode(currency) ? currency : null,
    data: withMappings,
    contacts: mappedContacts,
    lineItems: sortedItems.map(mapLineItem),
  };
}

/** Deal search for creating documents directly from DealDocs. */
export async function searchDeals(ctx: OrgContext, query: string) {
  const connection = await requireConnection(ctx.organizationId);
  const client = new HubSpotClient(connection.id);
  const body: Record<string, unknown> = {
    limit: 20,
    properties: ["dealname", "amount", "dealstage", "pipeline", "closedate", "deal_currency_code"],
    sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
  };
  const q = query.trim();
  if (q) body.query = q.slice(0, 100);
  const res = await client.search("deals", body);
  return res.results.map((d) => ({
    id: d.id,
    name: s(d.properties.dealname) || `Deal ${d.id}`,
    amount: s(d.properties.amount),
    stage: s(d.properties.dealstage),
    closeDate: s(d.properties.closedate),
    currency: s(d.properties.deal_currency_code),
  }));
}

export async function searchProducts(ctx: OrgContext, query: string) {
  const connection = await requireConnection(ctx.organizationId);
  const client = new HubSpotClient(connection.id);
  const body: Record<string, unknown> = { limit: 20, properties: ["name", "description", "price", "hs_sku"] };
  if (query.trim()) body.query = query.trim().slice(0, 100);
  const res = await client.search("products", body);
  return res.results.map((p) => ({
    id: p.id,
    name: s(p.properties.name) || `Product ${p.id}`,
    description: s(p.properties.description),
    price: toDecimalString(p.properties.price),
    sku: s(p.properties.hs_sku),
  }));
}

export async function listDealContacts(ctx: OrgContext, dealId: string) {
  const connection = await requireConnection(ctx.organizationId);
  const client = new HubSpotClient(connection.id);
  const deal = await client.getObject("deals", dealId, ["dealname"], ["contacts"]);
  const ids = [...new Set((deal.associations?.contacts?.results ?? []).map((r) => r.id))];
  const contacts = await client.batchRead("contacts", ids, ["firstname", "lastname", "email", "phone", "jobtitle"]);
  return contacts.map(mapContact);
}
