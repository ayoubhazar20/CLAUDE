import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { buildOrgContext, type OrgContext } from "@/server/auth/context";
import { registerUser, verifyEmail, authenticate } from "@/server/services/auth";
import { createOrganization, approveOrganization } from "@/server/services/organizations";
import { rotateIntegrationSecret, saveIntegrationSettings } from "@/server/integrations/config";
import { setZapierFetch } from "@/server/integrations/outbound";
import { createDocument, saveDraft, publishDocument, convertQuoteToContract, createRevision } from "@/server/documents/service";
import { getEmailDraft, sendDocument } from "@/server/documents/send";
import { loadPublicView, recordView } from "@/server/documents/public";
import { acceptQuote, requestActionCode, signDocument, verifyActionCode } from "@/server/documents/signing";
import { parseBlocks } from "@/domain/blocks";
import { parseDocumentData } from "@/domain/document-data";
import { FakeZapier } from "./fake-zapier";
import { META, createUser, lastCode, processJobs, resetDatabase, useOutbox } from "./helpers";

const CLIENT_META = { ip: "198.51.100.7", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148" };
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAYCAYAAABKtPtEAAAA1klEQVR4nO2YUQ6AIAxDdwgP5v0vo/HDBFEEZtthtAlfhrV7GFy05eOy6ADR+gEozaZpPqwRJAGQNz4KiM2bDqDWfBSE3ZcKoNZkFITUkwagpzElgDwXBYDnVBUQrnLBATx5pZkQSrloAJ7sRUO4q2tIM0R4BoS7eoYyQ4ZW1oIAUJ8asoYhzFiXl+I+sXyDMmRr7d76PftOAN7w7UbmOnwGPdObYoJr9fJkOs0Bb5jfPc9LuhyE8iZLSy1GruIkOFrzLbk8qo7CozSeCnkg/z/B6ADRWgGz1AWLlP3ARgAAAABJRU5ErkJggg==";

describe("V1 acceptance scenario (section 63, HubSpot via Zapier)", () => {
  const zapier = new FakeZapier();
  const outbox = useOutbox();
  let adminCtx: OrgContext;
  let organizationId: string;
  let quoteId: string;
  let contractId: string;

  beforeAll(async () => {
    await resetDatabase();
    zapier.seedDeal();
    setZapierFetch(zapier.fetch);
  });

  it("company registers, verifies email and submits its company", async () => {
    const user = await registerUser({ name: "Alice Admin", email: "alice@seller.test", password: "Str0ng-Passw0rd!" }, META);
    await processJobs();
    const mail = outbox.outbox.find((m) => m.to.includes("alice@seller.test") && /verify/i.test(m.subject))!;
    const token = decodeURIComponent(mail.html.match(/token=([^"&<\s]+)/)![1]!);
    expect(await verifyEmail(token, META)).not.toBeNull();
    const org = await createOrganization(
      user.id,
      {
        name: "Seller Inc",
        legalName: "Seller Incorporated SARL",
        country: "Morocco",
        addressLine1: "10 Boulevard Test",
        city: "Casablanca",
        defaultCurrency: "MAD",
        timezone: "Africa/Casablanca",
        language: "en",
        vatNumber: "MA123",
        acceptTerms: true,
        acceptPrivacy: true,
      },
      META,
    );
    expect(org.status).toBe("PENDING_APPROVAL");
    const terms = await prisma.termsAcceptance.findMany({ where: { organizationId: org.id } });
    expect(terms.map((t) => t.documentType).sort()).toEqual(["PRIVACY_POLICY", "TERMS_OF_SERVICE"]);
    expect(terms.every((t) => t.version && t.acceptedAt)).toBe(true);
    organizationId = org.id;
  });

  it("platform super admin approves the company; admin logs in", async () => {
    const platform = await createUser("root@dealdocs.test", "Root", { platformAdmin: true });
    await approveOrganization(platform.id, organizationId, META);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(org.status).toBe("ACTIVE");
    const user = await authenticate("alice@seller.test", "Str0ng-Passw0rd!", META);
    adminCtx = (await buildOrgContext({ userId: user.id, organizationId, meta: META }))!;
    expect(adminCtx.roleKey).toBe("admin");
  });

  it("admin configures HubSpot via Zapier (no HubSpot OAuth); the secret is never stored in clear", async () => {
    zapier.secret = await rotateIntegrationSecret(adminCtx);
    await saveIntegrationSettings(adminCtx, {
      enabled: true,
      hubspotObjectTypeId: "2-12345678",
      webhookUrl: zapier.webhookUrl,
      dealPropertyNames: {},
      statusMapping: {},
      propertyVariableMap: { project_start_date: "project.startDate" },
    });
    const integration = await prisma.zapierIntegration.findUniqueOrThrow({ where: { organizationId } });
    expect(integration.secretHash).not.toContain(zapier.secret);
    expect(integration.secretEnc).not.toContain(zapier.secret);
    await expect(saveIntegrationSettings(adminCtx, { enabled: true, hubspotObjectTypeId: "", webhookUrl: "https://evil.example/hook", dealPropertyNames: {}, statusMapping: {}, propertyVariableMap: {} })).rejects.toThrow(/Webhook host/);
  });

  it("HubSpot card → user creates a quote for the deal; Zapier creates the custom object and returns the deal snapshot", async () => {
    const template = await prisma.template.findFirstOrThrow({ where: { organizationId, documentType: "QUOTE", isDefault: true } });
    const doc = await createDocument(adminCtx, { type: "QUOTE", templateId: template.id, hubspotDealId: "9001" });
    quoteId = doc.id;
    expect(doc.number).toMatch(/^Q-\d{4}-000001$/);
    expect(doc.hubspotDealId).toBe("9001");
    await processJobs();

    // DOCUMENT_CREATED → one custom object record, associated to the deal, linked back to DealDocs.
    const created = zapier.received.find((p) => p.event === "DOCUMENT_CREATED")!;
    expect(created.hubspot_object_type_id).toBe("2-12345678");
    expect(created.idempotency_key).toBe(doc.id);
    expect(created.document).toMatchObject({ dealdocs_document_id: doc.id, document_type: "quote", document_status: "draft", hubspot_deal_id: "9001", document_url: null });
    const [recordId, record] = zapier.recordFor(doc.id)!;
    expect(record.associatedDealId).toBe("9001");
    const linked = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(linked.hubspotObjectRecordId).toBe(recordId);

    // DEAL_DATA_REQUESTED → snapshot imported into the untouched draft.
    expect(linked.dealDataStatus).toBe("APPLIED");
    expect(linked.hubspotDealName).toBe("ACME Expansion");
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: linked.draftVersionId! } });
    const data = parseDocumentData(version.data);
    expect(data.contact.firstName).toBe("Amina");
    expect(data.company.name).toBe("Client Co");
    expect(data.deal.name).toBe("ACME Expansion");
    expect(data.deal.owner.name).toBe("Sara Owner");
    expect(data.hubspotProperties["project.startDate"]).toBe("2026-10-15");
    expect(data.recipients[0]).toMatchObject({ email: "amina@client.test", role: "SIGNER" });
    const lines = await prisma.documentLineItem.findMany({ where: { versionId: version.id }, orderBy: { position: "asc" } });
    expect(lines).toHaveLength(2);
    expect(lines[1]!.discountType).toBe("AMOUNT");
    expect(lines[1]!.discountValue.toString()).toBe("100"); // 50 per unit × 2
  });

  it("user edits prices, adds a custom line, discount and tax; totals are correct; HubSpot is untouched", async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.draftVersionId! } });
    const lines = await prisma.documentLineItem.findMany({ where: { versionId: version.id }, orderBy: { position: "asc" } });
    const snapshotBefore = JSON.stringify(zapier.deals["9001"]!.snapshot);

    const toInput = (l: (typeof lines)[number]) => ({
      id: l.id,
      source: l.source,
      hubspotLineItemId: l.hubspotLineItemId,
      hubspotProductId: l.hubspotProductId,
      sku: l.sku,
      name: l.name,
      description: l.description,
      quantity: l.quantity.toString(),
      unitPrice: l.unitPrice.toString(),
      discountType: l.discountType,
      discountValue: l.discountValue.toString(),
      taxKeys: ["vat"],
    });
    const result = await saveDraft(adminCtx, quoteId, {
      baseUpdatedAt: version.updatedAt.toISOString(),
      pricingConfig: { globalDiscountType: "PERCENT", globalDiscountValue: "10", taxes: [{ key: "vat", name: "VAT", rate: "20" }], fees: [] },
      lineItems: [
        { ...toInput(lines[0]!), unitPrice: "1400" }, // edited price: 10 × 1400 = 14000
        toInput(lines[1]!), // 2 × 1750.50 − 100 = 3401
        { id: crypto.randomUUID(), source: "CUSTOM", name: "Project management", quantity: "1", unitPrice: "2000", discountType: "NONE", discountValue: "0", taxKeys: ["vat"] },
      ],
    });
    // subtotal 19401, −10% = 1940.10 → 17460.90, VAT 20% = 3492.18 → 20953.08
    expect(result.totals.subtotal).toBe("19401.00");
    expect(result.totals.globalDiscount).toBe("1940.10");
    expect(result.totals.taxTotal).toBe("3492.18");
    expect(result.totals.grandTotal).toBe("20953.08");
    // Original HubSpot line items are unchanged (DealDocs never writes line items anywhere).
    expect(JSON.stringify(zapier.deals["9001"]!.snapshot)).toBe(snapshotBefore);
  });

  it("editable sections can change, locked legal text cannot; stale saves are rejected", async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    let version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.draftVersionId! } });
    const blocks = parseBlocks(version.content);
    const editable = blocks.find((b) => b.type === "paragraph" && !b.locked)!;
    (editable.props as { text: string }).text = "Custom intro for {{contact.firstName}}";
    const saved = await saveDraft(adminCtx, quoteId, { baseUpdatedAt: version.updatedAt.toISOString(), blocks });
    version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.draftVersionId! } });

    const tampered = parseBlocks(version.content);
    const legal = tampered.find((b) => b.locked)!;
    (legal.props as { html: string }).html = "<p>No obligations whatsoever</p>";
    await expect(saveDraft(adminCtx, quoteId, { baseUpdatedAt: saved.updatedAt, blocks: tampered })).rejects.toThrow(/Locked content/);
    const withoutLegal = parseBlocks(version.content).filter((b) => !b.locked);
    await expect(saveDraft(adminCtx, quoteId, { baseUpdatedAt: saved.updatedAt, blocks: withoutLegal })).rejects.toThrow(/Locked content/);
    await expect(saveDraft(adminCtx, quoteId, { baseUpdatedAt: new Date(0).toISOString(), title: "x" })).rejects.toThrow(/changed elsewhere/);
  });

  it("draft survives closing the application (persisted server-side)", async () => {
    const reloaded = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: reloaded.draftVersionId! } });
    const text = JSON.stringify(version.content);
    expect(text).toContain("Custom intro for {{contact.firstName}}");
    expect((await prisma.documentLineItem.count({ where: { versionId: version.id } }))).toBe(3);
  });

  it("publishes the quote: secure URL, locked version, PDF generated", async () => {
    await publishDocument(adminCtx, quoteId);
    await processJobs();
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    expect(doc.status).toBe("PUBLISHED");
    expect(doc.publicToken).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(doc.grandTotal.toString()).toBe("20953.08");
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.publishedVersionId! } });
    expect(version.lockedAt).not.toBeNull();
    expect(version.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(version.renderedHtml).toContain("Custom intro for Amina");
    expect(version.pdfFileId).not.toBeNull();
    const pdf = await prisma.storedFile.findUniqueOrThrow({ where: { id: version.pdfFileId! } });
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.checksum).toMatch(/^[0-9a-f]{64}$/);
    // PDF generation must not count as a view.
    expect(doc.viewCount).toBe(0);
  });

  it("Publish & Send: client receives the email", async () => {
    const draft = await getEmailDraft(adminCtx, quoteId);
    expect(draft.to).toEqual(["amina@client.test"]);
    expect(draft.subject).toMatch(/^Quote Q-\d{4}-000001 from Seller Inc$/);
    await sendDocument(adminCtx, quoteId, { ...draft, cc: ["omar@client.test"] });
    await processJobs();
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    expect(doc.status).toBe("SENT");
    expect(doc.sendCount).toBe(1);
    const email = outbox.outbox.find((m) => m.to.includes("amina@client.test") && m.subject.startsWith("Quote"))!;
    expect(email.html).toContain(`/d/${doc.publicToken}`);
    expect(email.attachments?.[0]?.filename).toMatch(/\.pdf$/);
    const delivery = await prisma.emailDelivery.findFirstOrThrow({ where: { documentId: quoteId, kind: "DOCUMENT_SEND" } });
    expect(delivery.status).toBe("SENT");
  });

  it("client opens the document; the view is recorded (internal and bot views are not)", async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    const view = await loadPublicView(doc.publicToken);
    expect(view?.resolved.blocks.length).toBeGreaterThan(0);
    await recordView({ token: doc.publicToken, visitorId: "visitor-1", meta: { ip: "198.51.100.7", userAgent: "Slackbot-LinkExpanding 1.0" }, internalViewer: false });
    await recordView({ token: doc.publicToken, visitorId: "visitor-2", meta: CLIENT_META, internalViewer: true });
    await recordView({ token: doc.publicToken, visitorId: "visitor-1", meta: CLIENT_META, internalViewer: false });
    await recordView({ token: doc.publicToken, visitorId: "visitor-1", meta: CLIENT_META, internalViewer: false });
    const after = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    expect(after.status).toBe("VIEWED");
    expect(after.viewCount).toBe(2);
    expect(after.uniqueViewCount).toBe(1);
    expect(after.firstViewedAt).not.toBeNull();
    const notification = await prisma.notification.findFirst({ where: { documentId: quoteId, type: "DOCUMENT_FIRST_VIEWED" } });
    expect(notification?.userId).toBe(adminCtx.user.id);
  });

  it("client accepts with OTP: quote accepted, evidence stored, HubSpot deal updated", async () => {
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    const recipient = await prisma.documentRecipient.findFirstOrThrow({ where: { documentId: quoteId } });
    const { challengeId } = await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT_META);
    await processJobs();
    const code = lastCode(outbox, "amina@client.test");
    const challenge = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(challenge.codeHash).not.toContain(code);
    const { grant } = await verifyActionCode(doc.publicToken, { challengeId, code }, CLIENT_META);
    await acceptQuote(doc.publicToken, { grant }, CLIENT_META);
    await processJobs();

    const accepted = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.acceptedAt).not.toBeNull();
    const signature = await prisma.signature.findFirstOrThrow({ where: { documentId: quoteId } });
    expect(signature).toMatchObject({ kind: "ACCEPTANCE", signerEmail: "amina@client.test", ip: CLIENT_META.ip });
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: accepted.publishedVersionId! } });
    expect(signature.documentHash).toBe(version.contentHash);
    expect(version.status).toBe("ACCEPTED");
    expect(version.signedPdfFileId).not.toBeNull();

    const deal = zapier.deals["9001"]!;
    expect(deal.properties.latest_quote_status).toBe("accepted");
    expect(deal.properties.latest_quote_id).toBe(accepted.number);
    expect(deal.properties.latest_quote_amount).toBe("20953.08");
    // The same HubSpot record was updated (never duplicated).
    const record = zapier.recordFor(quoteId)![1];
    expect(record.properties.document_status).toBe("accepted");
    expect(record.properties.file_url).toMatch(/\/files\/[A-Za-z0-9]{32}\/v1\.pdf$/);
    expect(zapier.createCalls).toBe(1);
    // Grants are single use.
    await expect(acceptQuote(doc.publicToken, { grant }, CLIENT_META)).rejects.toThrow();
  });

  it("converts the accepted quote to a contract, which is edited and published", async () => {
    const template = await prisma.template.findFirstOrThrow({ where: { organizationId, documentType: "CONTRACT", isDefault: true } });
    const contract = await convertQuoteToContract(adminCtx, quoteId, template.id);
    contractId = contract.id;
    expect(contract.type).toBe("CONTRACT");
    expect(contract.sourceQuoteId).toBe(quoteId);
    expect(contract.number).toMatch(/^C-\d{4}-000001$/);
    const quote = await prisma.document.findUniqueOrThrow({ where: { id: quoteId } });
    expect(quote.status).toBe("ACCEPTED"); // original untouched
    const rel = await prisma.documentRelationship.findFirstOrThrow({ where: { targetDocumentId: contractId } });
    expect(rel.type).toBe("CONVERTED_FROM_QUOTE");

    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: contract.draftVersionId! } });
    const lines = await prisma.documentLineItem.findMany({ where: { versionId: version.id } });
    expect(lines).toHaveLength(3);
    const data = parseDocumentData(version.data);
    // Two signatories, sequential: client then company director.
    data.recipients = [
      { ...data.recipients[0]!, signingOrder: 1 },
      { id: crypto.randomUUID(), name: "Dan Director", email: "dan@seller.test", role: "SIGNER", signingOrder: 2, required: true, hubspotContactId: null },
    ];
    await prisma.document.update({ where: { id: contractId }, data: { signingOrder: "SEQUENTIAL" } });
    await saveDraft(adminCtx, contractId, { baseUpdatedAt: version.updatedAt.toISOString(), data, title: "Service Agreement — ACME" });
    await publishDocument(adminCtx, contractId);
    await processJobs();
    const published = await prisma.document.findUniqueOrThrow({ where: { id: contractId } });
    expect(published.status).toBe("PUBLISHED");
  });

  it("client verifies email with OTP and signs; sequential order is enforced; signed PDF generated; HubSpot stage updated", async () => {
    const contract = await prisma.document.findUniqueOrThrow({ where: { id: contractId } });
    const recipients = await prisma.documentRecipient.findMany({ where: { documentId: contractId, removedAt: null }, orderBy: { signingOrder: "asc" } });
    const [client, director] = recipients;

    await expect(requestActionCode(contract.publicToken, { recipientId: director!.id, action: "SIGN_CONTRACT" }, CLIENT_META)).rejects.toThrow(/sign before you/);

    const sign = async (recipient: typeof client, name: string, method: "TYPED" | "DRAWN", data: string) => {
      const { challengeId } = await requestActionCode(contract.publicToken, { recipientId: recipient!.id, action: "SIGN_CONTRACT" }, CLIENT_META);
      await processJobs();
      const { grant } = await verifyActionCode(contract.publicToken, { challengeId, code: lastCode(outbox, recipient!.email) }, CLIENT_META);
      return signDocument(contract.publicToken, { grant, signerName: name, method, signatureData: data, consent: true }, CLIENT_META);
    };
    const first = await sign(client, "Amina Client", "DRAWN", TINY_PNG);
    expect(first.complete).toBe(false);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: contractId } })).status).toBe("AWAITING_SIGNATURE");
    await processJobs();
    expect(outbox.outbox.some((m) => m.to.includes("dan@seller.test") && /signature is requested/i.test(m.subject))).toBe(true);

    const second = await sign(director, "Dan Director", "TYPED", "Dan Director");
    expect(second.complete).toBe(true);
    await processJobs();

    const signed = await prisma.document.findUniqueOrThrow({ where: { id: contractId } });
    expect(signed.status).toBe("SIGNED");
    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: signed.publishedVersionId! } });
    expect(version.status).toBe("SIGNED");
    expect(version.signedPdfFileId).not.toBeNull();
    const events = await prisma.documentEvent.findMany({ where: { documentId: contractId }, select: { type: true } });
    const types = events.map((e) => e.type);
    for (const t of ["OTP_REQUESTED", "OTP_VERIFIED", "CONSENT_GIVEN", "SIGNED", "SIGNATURE_COMPLETED", "PDF_GENERATED"]) expect(types).toContain(t);
    expect(outbox.outbox.some((m) => m.to.includes("amina@client.test") && /completed/i.test(m.subject) && m.attachments?.length)).toBe(true);
    const record = zapier.recordFor(contractId)![1];
    expect(record.properties).toMatchObject({ document_status: "signed", document_type: "contract", hubspot_deal_id: "9001" });
    expect(record.properties.signed_at).toBeTruthy();
    expect(zapier.deals["9001"]!.properties.latest_contract_status).toBe("signed");
    expect(zapier.deals["9001"]!.properties.document_signed).toBe("true");
    // Pipeline change happens outside DealDocs (HubSpot workflow reacting to the property).
    expect(zapier.deals["9001"]!.properties.dealstage).toBe("closedwon");
  });

  it("signed version is immutable, even at the database level", async () => {
    const signed = await prisma.document.findUniqueOrThrow({ where: { id: contractId } });
    const versionId = signed.publishedVersionId!;
    await expect(prisma.documentVersion.update({ where: { id: versionId }, data: { content: [] } })).rejects.toThrow(/IMMUTABLE_VERSION/);
    await expect(prisma.documentVersion.update({ where: { id: versionId }, data: { status: "SUPERSEDED" } })).rejects.toThrow(/IMMUTABLE_VERSION/);
    await expect(prisma.documentLineItem.updateMany({ where: { versionId }, data: { unitPrice: "1" } })).rejects.toThrow(/IMMUTABLE_VERSION/);
    await expect(prisma.documentVersion.delete({ where: { id: versionId } })).rejects.toThrow(/IMMUTABLE_VERSION/);
    const sig = await prisma.signature.findFirstOrThrow({ where: { versionId } });
    await expect(prisma.signature.update({ where: { id: sig.id }, data: { signerName: "Forged" } })).rejects.toThrow(/IMMUTABLE_RECORD/);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/IMMUTABLE_RECORD/);
  });

  it("six months later, a revision keeps the signed version and the same public link", async () => {
    const before = await prisma.document.findUniqueOrThrow({ where: { id: contractId } });
    const signedVersionId = before.publishedVersionId!;
    const signedHash = (await prisma.documentVersion.findUniqueOrThrow({ where: { id: signedVersionId } })).contentHash;

    const { versionId, created } = await createRevision(adminCtx, contractId);
    expect(created).toBe(true);
    const draft = await prisma.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    expect(draft.versionNumber).toBe(2);
    await saveDraft(adminCtx, contractId, { baseUpdatedAt: draft.updatedAt.toISOString(), title: "Service Agreement — ACME (amendment)" });
    await publishDocument(adminCtx, contractId);
    await processJobs();

    const after = await prisma.document.findUniqueOrThrow({ where: { id: contractId } });
    expect(after.publicToken).toBe(before.publicToken);
    expect(after.publishedVersionId).toBe(versionId);
    expect(after.status).toBe("PUBLISHED");
    const oldVersion = await prisma.documentVersion.findUniqueOrThrow({ where: { id: signedVersionId } });
    expect(oldVersion.status).toBe("SIGNED");
    expect(oldVersion.contentHash).toBe(signedHash);
    expect(await prisma.signature.count({ where: { versionId: signedVersionId } })).toBe(2);
    const view = await loadPublicView(after.publicToken);
    expect(view!.version.versionNumber).toBe(2);
    expect(view!.signatures).toHaveLength(0);
  });

  it("all actions appear in document history and audit logs", async () => {
    const quoteEvents = (await prisma.documentEvent.findMany({ where: { documentId: quoteId } })).map((e) => e.type);
    for (const t of ["CREATED", "EDITED", "PUBLISHED", "EMAIL_SENT", "VIEWED", "OTP_REQUESTED", "OTP_VERIFIED", "ACCEPTED", "CONVERTED", "HUBSPOT_RECORD_LINKED", "HUBSPOT_DATA_RECEIVED"]) expect(quoteEvents).toContain(t);
    const contractEvents = (await prisma.documentEvent.findMany({ where: { documentId: contractId } })).map((e) => e.type);
    expect(contractEvents).toContain("REVISION_CREATED");
    const actions = (await prisma.auditLog.findMany({ where: { organizationId } })).map((a) => a.action);
    for (const a of ["ORGANIZATION_CREATED", "ORGANIZATION_APPROVED", "INTEGRATION_UPDATED", "INTEGRATION_SECRET_ROTATED", "HUBSPOT_RECORD_LINKED", "DOCUMENT_CREATED", "DOCUMENT_PUBLISHED", "DOCUMENT_SENT", "DOCUMENT_ACCEPTED", "DOCUMENT_CONVERTED", "DOCUMENT_SIGNED", "DOCUMENT_REVISED"]) {
      expect(actions).toContain(a);
    }
    const history = await prisma.documentStatusChange.findMany({ where: { documentId: contractId }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => h.toStatus)).toEqual(["PUBLISHED", "AWAITING_SIGNATURE", "SIGNED", "PUBLISHED"]);
    // No secrets in audit logs.
    const serialized = JSON.stringify(await prisma.auditLog.findMany());
    expect(serialized).not.toContain(zapier.secret);
    expect(serialized).not.toContain("Str0ng-Passw0rd!");
    expect(serialized).not.toMatch(/scrypt\$/);
  });
});
