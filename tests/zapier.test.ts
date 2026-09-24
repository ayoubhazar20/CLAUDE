import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import type { OrgContext } from "@/server/auth/context";
import { createDocument, publishDocument, saveDraft } from "@/server/documents/service";
import { rotateIntegrationSecret, saveIntegrationSettings, validateWebhookUrl } from "@/server/integrations/config";
import { emitDocumentEvent, requestDealData, retrySyncEvent, setZapierFetch } from "@/server/integrations/outbound";
import { normalizeSnapshot, resolveSnapshot } from "@/server/integrations/snapshot";
import { computeDealPropertyValues } from "@/server/integrations/deal-properties";
import { GET as meRoute } from "@/app/api/integrations/zapier/me/route";
import { GET as versionPdfRoute } from "@/app/files/[token]/[file]/route";
import { parseDocumentData } from "@/domain/document-data";
import { Prisma } from "@prisma/client";
import { FakeZapier } from "./fake-zapier";
import { createActiveOrg, processJobs, resetDatabase, templateId, useOutbox } from "./helpers";

async function configure(ctx: OrgContext, zapier: FakeZapier) {
  zapier.secret = await rotateIntegrationSecret(ctx);
  await saveIntegrationSettings(ctx, { enabled: true, hubspotObjectTypeId: "2-12345678", webhookUrl: zapier.webhookUrl, dealPropertyNames: {}, statusMapping: {}, propertyVariableMap: {} });
}

describe("HubSpot via Zapier", () => {
  useOutbox();
  const zapier = new FakeZapier();
  let a: Awaited<ReturnType<typeof createActiveOrg>>;
  let b: Awaited<ReturnType<typeof createActiveOrg>>;
  let secretA = "";
  let secretB = "";

  beforeAll(async () => {
    await resetDatabase();
    zapier.seedDeal();
    setZapierFetch(zapier.fetch);
    a = await createActiveOrg("Org A");
    b = await createActiveOrg("Org B");
    await configure(b.adminCtx, zapier);
    secretB = zapier.secret;
    await configure(a.adminCtx, zapier);
    secretA = zapier.secret;
  });
  beforeEach(() => {
    zapier.secret = secretA;
    zapier.failNext = 0;
  });

  const newQuote = async (ctx: OrgContext, dealId: string | null = "9001") => createDocument(ctx, { type: "QUOTE", templateId: await templateId(ctx.organizationId, "QUOTE"), hubspotDealId: dealId });

  it("rejects missing, invalid and other-organization credentials", async () => {
    const doc = await newQuote(a.adminCtx);
    expect((await zapier.link({ dealdocs_document_id: doc.id, hubspot_object_record_id: "1" }, "")).status).toBe(401);
    expect((await zapier.link({ dealdocs_document_id: doc.id, hubspot_object_record_id: "1" }, "ddz_not-a-real-secret")).status).toBe(401);
    // Organization B's secret cannot reach organization A's document, even with the right ids.
    const cross = await zapier.link({ dealdocs_document_id: doc.id, hubspot_object_record_id: "1" }, secretB);
    expect(cross.status).toBe(404);
    const crossUpdate = await zapier.update({ deal_id: "9001", changed_property: "dealname", new_value: "Hijacked" }, secretB);
    expect(crossUpdate.status).toBe(404);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).hubspotDealName).not.toBe("Hijacked");
    const me = await meRoute(new Request("http://localhost/api/integrations/zapier/me", { headers: { Authorization: `Bearer ${secretA}` } }), { params: Promise.resolve({}) });
    expect(await me.json()).toMatchObject({ ok: true, organization: "Org A", hubspot_object_type_id: "2-12345678" });
    const rejected = await prisma.syncLog.count({ where: { direction: "INBOUND", success: false } });
    expect(rejected).toBeGreaterThanOrEqual(3);
  });

  it("disabled integrations are refused and do not deliver", async () => {
    await saveIntegrationSettings(b.adminCtx, { enabled: false, hubspotObjectTypeId: "", webhookUrl: zapier.webhookUrl, dealPropertyNames: {}, statusMapping: {}, propertyVariableMap: {} });
    const res = await zapier.link({ dealdocs_document_id: crypto.randomUUID(), hubspot_object_record_id: "1" }, secretB);
    expect(res.status).toBe(403);
    const doc = await newQuote(b.adminCtx, null);
    const event = await prisma.syncEvent.findFirstOrThrow({ where: { documentId: doc.id } });
    expect(event.status).toBe("FAILED");
    expect(event.lastError).toMatch(/not configured/);
  });

  it("retries failed deliveries without ever duplicating the HubSpot record", async () => {
    await processJobs(); // drain events left over from earlier tests
    const before = zapier.createCalls;
    zapier.failNext = 2; // Zapier down twice
    const doc = await newQuote(a.adminCtx);
    await processJobs(12);
    // Creation emits DOCUMENT_CREATED and DEAL_DATA_REQUESTED; both eventually succeed.
    const events = await prisma.syncEvent.findMany({ where: { documentId: doc.id } });
    expect(events.map((e) => e.eventType).sort()).toEqual(["DEAL_DATA_REQUESTED", "DOCUMENT_CREATED"]);
    expect(events.every((e) => e.status === "SUCCESS")).toBe(true);
    expect(events.reduce((n, e) => n + e.attempts, 0)).toBe(events.length + 2);
    expect(zapier.createCalls).toBe(before + 1);
    // Re-sending the same event (manual retry of an already-created document) updates, never creates.
    await emitDocumentEvent(doc, "DOCUMENT_UPDATED", {});
    await processJobs();
    expect(zapier.createCalls).toBe(before + 1);
    const logs = await prisma.syncLog.findMany({ where: { documentId: doc.id, direction: "OUTBOUND" }, orderBy: { createdAt: "asc" } });
    expect(logs.filter((l) => !l.success).length).toBe(2);
    expect(logs.some((l) => l.success && l.eventType === "DOCUMENT_CREATED")).toBe(true);
  });

  it("a second record id for the same document is refused (first link wins)", async () => {
    const doc = await newQuote(a.adminCtx);
    await processJobs();
    const linked = (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).hubspotObjectRecordId!;
    expect((await zapier.link({ dealdocs_document_id: doc.id, hubspot_object_record_id: linked })).json.ok).toBe(true); // idempotent
    const dup = await zapier.link({ dealdocs_document_id: doc.id, hubspot_object_record_id: "999999" });
    expect(dup.json).toMatchObject({ ok: false, conflict: true, linkedRecordId: linked });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).hubspotObjectRecordId).toBe(linked);
  });

  it("signs outbound events so Zapier can verify them", async () => {
    await newQuote(a.adminCtx);
    await processJobs();
    expect(zapier.signatureErrors).toBe(0);
    zapier.secret = "ddz_wrong";
    const doc = await newQuote(a.adminCtx, null);
    await processJobs(1);
    expect(zapier.signatureErrors).toBeGreaterThan(0);
    const event = await prisma.syncEvent.findFirstOrThrow({ where: { documentId: doc.id } });
    expect(event.status).toBe("FAILED");
    zapier.secret = secretA;
    await retrySyncEvent(a.adminCtx, event.id);
    await processJobs();
    expect((await prisma.syncEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe("SUCCESS");
  });

  it("never silently overwrites manual edits: refreshed data waits for an explicit choice", async () => {
    const doc = await newQuote(a.adminCtx);
    await processJobs();
    let draft = await prisma.documentVersion.findUniqueOrThrow({ where: { id: (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).draftVersionId! } });
    const data = parseDocumentData(draft.data);
    data.contact.firstName = "Amina (edited)";
    data.company.name = "Client Co — custom legal name";
    await saveDraft(a.adminCtx, doc.id, { baseUpdatedAt: draft.updatedAt.toISOString(), data });

    zapier.deals["9001"]!.snapshot.contact = { id: "501", firstname: "Amina", lastname: "Updated", email: "amina@client.test" };
    await requestDealData(a.adminCtx, doc.id, "refresh");
    await processJobs();
    const pending = await prisma.dealSnapshot.findFirstOrThrow({ where: { documentId: doc.id, status: "PENDING_REVIEW" } });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).dealDataStatus).toBe("PENDING_REVIEW");
    draft = await prisma.documentVersion.findUniqueOrThrow({ where: { id: draft.id } });
    expect(parseDocumentData(draft.data).contact.firstName).toBe("Amina (edited)"); // untouched until the user decides

    // User chooses: replace contact only, keep company and products.
    const linesBefore = await prisma.documentLineItem.count({ where: { versionId: draft.id } });
    await resolveSnapshot(a.adminCtx, doc.id, pending.id, { sections: ["contact"], lineItems: "keep" });
    draft = await prisma.documentVersion.findUniqueOrThrow({ where: { id: draft.id } });
    const after = parseDocumentData(draft.data);
    expect(after.contact.lastName).toBe("Updated");
    expect(after.company.name).toBe("Client Co — custom legal name");
    expect(await prisma.documentLineItem.count({ where: { versionId: draft.id } })).toBe(linesBefore);
    await expect(resolveSnapshot(a.adminCtx, doc.id, pending.id, "dismiss")).rejects.toThrow(/already handled/);
  });

  it("HubSpot updates change metadata or queue data for review — never signed evidence", async () => {
    const doc = await newQuote(a.adminCtx);
    await processJobs();
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).draftVersionId! } });
    await saveDraft(a.adminCtx, doc.id, { baseUpdatedAt: version.updatedAt.toISOString(), title: "Locked soon" });
    await publishDocument(a.adminCtx, doc.id);
    await processJobs();
    const published = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    const lockedBefore = await prisma.documentVersion.findUniqueOrThrow({ where: { id: published.publishedVersionId! } });

    const rename = await zapier.update({ hubspot_object_record_id: published.hubspotObjectRecordId, changed_property: "dealname", new_value: "ACME Renamed", event_id: "evt-1" });
    expect(rename.status).toBe(200);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).hubspotDealName).toBe("ACME Renamed");
    // Same Zapier event id again → acknowledged, no second effect.
    expect((await zapier.update({ hubspot_object_record_id: published.hubspotObjectRecordId, changed_property: "dealname", new_value: "Other", event_id: "evt-1" })).json).toMatchObject({ duplicate: true });

    const amount = await zapier.update({ dealdocs_document_id: doc.id, changed_property: "amount", new_value: "999999" });
    expect(amount.status).toBe(200);
    const lockedAfter = await prisma.documentVersion.findUniqueOrThrow({ where: { id: lockedBefore.id } });
    expect(lockedAfter.contentHash).toBe(lockedBefore.contentHash);
    expect(JSON.stringify(lockedAfter.data)).toBe(JSON.stringify(lockedBefore.data));
    const pending = await prisma.dealSnapshot.findFirstOrThrow({ where: { documentId: doc.id, status: "PENDING_REVIEW" } });
    // Applying requires a draft: published versions are never modified.
    await expect(resolveSnapshot(a.adminCtx, doc.id, pending.id, { sections: ["customProperties"], lineItems: "keep" })).rejects.toThrow(/revision/);

    const primary = await zapier.update({ dealdocs_document_id: doc.id, changed_property: "is_primary", new_value: "true" });
    expect(primary.status).toBe(200);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).isPrimary).toBe(true);
    expect((await zapier.update({ deal_id: "9001", changed_property: "bad property!", new_value: "x" })).status).toBe(422);
  });

  it("rejects a snapshot whose deal does not match the document", async () => {
    const doc = await newQuote(a.adminCtx);
    const res = await zapier.snapshot({ document_id: doc.id, deal_id: "123", deal: { dealname: "Other deal" } });
    expect(res.status).toBe(422);
  });

  it("serves stable per-version PDF links (file_url)", async () => {
    const doc = await newQuote(a.adminCtx);
    await processJobs();
    const v = await prisma.documentVersion.findUniqueOrThrow({ where: { id: (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).draftVersionId! } });
    await saveDraft(a.adminCtx, doc.id, { baseUpdatedAt: v.updatedAt.toISOString(), title: "With PDF" });
    await publishDocument(a.adminCtx, doc.id);
    await processJobs();
    const published = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    const call = (file: string) => versionPdfRoute(new Request(`http://localhost/files/${published.publicToken}/${file}`), { params: Promise.resolve({ token: published.publicToken, file }) });
    const res = await call("v1.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect((await call("v7.pdf")).status).toBe(404);
    expect((await call("../../etc/passwd")).status).toBe(404);
    const event = zapier.received.filter((p) => p.event === "DOCUMENT_PUBLISHED" && p.dealdocs_document_id === doc.id).pop()!;
    expect(event.document).toMatchObject({ document_status: "published", current_version: 1, pdf_ready: true });
    expect(event.document.file_url).toContain(`/files/${published.publicToken}/v1.pdf`);
    expect(event.document.document_url).toContain(`/d/${published.publicToken}`);
  });

  it("accepts HubSpot/Zapier field variants when normalising snapshots", () => {
    const snap = normalizeSnapshot({
      deal_id: 42,
      deal: JSON.stringify({ name: "Deal", amount: "1,200.50", deal_currency_code: "eur" }),
      contacts: [{ firstname: "No", lastname: "Email" }, { first_name: "Jo", last_name: "Doe", email: "JO@EX.COM" }],
      line_items: [{ name: "A", quantity: 3, unit_price: 10, hs_discount_percentage: "150", tax_rate: 20 }, { name: "B", price: "-5", discount_amount: "2" }],
      custom_properties: { ok_name: 1, "bad name": 2 },
    });
    expect(snap.dealId).toBe("42");
    expect(snap.deal).toMatchObject({ name: "Deal", amount: "1200.5", currency: "EUR" });
    expect(snap.contact?.email).toBe("jo@ex.com");
    expect(snap.lineItems![0]).toMatchObject({ quantity: "3", unitPrice: "10", discountType: "PERCENT", discountValue: "100", taxRate: "20" });
    expect(snap.lineItems![1]).toMatchObject({ unitPrice: "0", discountType: "AMOUNT", discountValue: "2" });
    expect(snap.customProperties).toEqual({ ok_name: "1" });
  });

  it("computes deal properties across several documents of a deal", () => {
    const base = { publicToken: "t", grandTotal: new Prisma.Decimal("100"), archivedAt: null, publishedVersionId: "v", signedAt: null, updatedAt: new Date("2026-01-01") };
    const values = computeDealPropertyValues(
      [
        { ...base, type: "QUOTE", number: "Q-1", status: "SENT", createdAt: new Date("2026-01-01") },
        { ...base, type: "QUOTE", number: "Q-2", status: "ACCEPTED", createdAt: new Date("2026-02-01"), updatedAt: new Date("2026-02-02") },
        { ...base, type: "CONTRACT", number: "C-1", status: "SIGNED", createdAt: new Date("2026-03-01"), signedAt: new Date() },
      ],
      { SENT: "sent", ACCEPTED: "accepted", SIGNED: "signed" },
      (t) => `https://x/d/${t}`,
    );
    expect(values).toMatchObject({ latest_quote_id: "Q-2", latest_quote_status: "accepted", latest_contract_status: "signed", document_signed: "true" });
  });

  it("restricts webhook targets to allowed HTTPS hosts", () => {
    expect(validateWebhookUrl("https://hooks.zapier.com/hooks/catch/1/2/")).toContain("hooks.zapier.com");
    expect(() => validateWebhookUrl("http://hooks.zapier.com/x")).toThrow(/HTTPS/);
    expect(() => validateWebhookUrl("https://169.254.169.254/latest")).toThrow(/host/);
    expect(() => validateWebhookUrl("https://user:pass@hooks.zapier.com/x")).toThrow(/Credentials/);
  });
});
