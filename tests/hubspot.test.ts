import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { applyImportMappings, buildWritebackProperties, computeWritebackValues, requestedProperties } from "@/server/hubspot/mapping";
import { computeSignatureV3, verifySignatureV3 } from "@/server/hubspot/signature";
import { ingestWebhookEvents } from "@/server/hubspot/webhooks";
import { getAccessToken, setHubSpotFetch } from "@/server/hubspot/client";
import { mapLineItem } from "@/server/hubspot/import";
import { encrypt } from "@/server/security/crypto";
import { emptyDocumentData } from "@/domain/document-data";
import { Prisma } from "@prisma/client";
import { FakeHubSpot } from "./fake-hubspot";
import { createActiveOrg, processJobs, resetDatabase, useOutbox } from "./helpers";

describe("HubSpot mapping logic", () => {
  it("maps standard and custom properties onto document data", () => {
    const data = emptyDocumentData();
    const mappings = [
      { objectType: "DEAL" as const, hubspotProperty: "project_start_date", variableKey: "project.startDate", direction: "IMPORT" as const, enabled: true },
      { objectType: "CONTACT" as const, hubspotProperty: "mobilephone", variableKey: "contact.phone", direction: "IMPORT" as const, enabled: true },
      { objectType: "DEAL" as const, hubspotProperty: "disabled_prop", variableKey: "x.y", direction: "IMPORT" as const, enabled: false },
    ];
    const out = applyImportMappings(data, mappings, {
      deal: { project_start_date: "2026-10-15", disabled_prop: "nope" },
      contact: { mobilephone: "+212 611" },
      company: null,
      owner: null,
    });
    expect(out.hubspotProperties["project.startDate"]).toBe("2026-10-15");
    expect(out.contact.phone).toBe("+212 611");
    expect(out.hubspotProperties["x.y"]).toBeUndefined();
    expect(data.contact.phone).toBe(""); // input not mutated
    expect(requestedProperties(mappings).deals).toContain("project_start_date");
  });

  it("converts HubSpot line items to document lines (unit discount → line amount)", () => {
    const li = mapLineItem({ id: "1", properties: { name: "A", quantity: "3", price: "10.5", discount: "2", hs_discount_percentage: null } });
    expect(li).toMatchObject({ quantity: "3", unitPrice: "10.5", discountType: "AMOUNT", discountValue: "6" });
    const pct = mapLineItem({ id: "2", properties: { name: "B", quantity: "1", price: "100", hs_discount_percentage: "15" } });
    expect(pct).toMatchObject({ discountType: "PERCENT", discountValue: "15" });
  });

  it("computes latest/primary document writeback values", () => {
    const base = { publicToken: "t", grandTotal: new Prisma.Decimal("100"), publishedAt: new Date(), firstPublishedAt: new Date("2026-01-01"), acceptedAt: null, sentAt: null, signedAt: null, isPrimary: false, archivedAt: null, publishedVersionId: "v", ownerName: "Owner" };
    const values = computeWritebackValues(
      [
        { ...base, type: "QUOTE", number: "Q-1", status: "SENT", createdAt: new Date("2026-01-01") },
        { ...base, type: "QUOTE", number: "Q-2", status: "ACCEPTED", createdAt: new Date("2026-02-01"), acceptedAt: new Date("2026-02-03"), isPrimary: true },
        { ...base, type: "QUOTE", number: "Q-3", status: "DRAFT", createdAt: new Date("2026-03-01"), publishedVersionId: null },
      ],
      (t) => `https://x/d/${t}`,
    );
    expect(values["latestQuote.number"]).toBe("Q-2");
    expect(values["latestQuote.status"]).toBe("Accepted");
    expect(values["primaryDocument.number"]).toBe("Q-2");
    const props = buildWritebackProperties(values, [
      { hubspotProperty: "dd_quote", variableKey: "latestQuote.number", direction: "WRITEBACK", enabled: true, objectType: "DEAL" },
      { hubspotProperty: "dd_off", variableKey: "latestQuote.status", direction: "WRITEBACK", enabled: false, objectType: "DEAL" },
    ]);
    expect(props).toEqual({ dd_quote: "Q-2" });
  });
});

describe("HubSpot signatures, webhooks and tokens", () => {
  useOutbox();
  const fake = new FakeHubSpot();
  beforeAll(async () => {
    await resetDatabase();
    setHubSpotFetch(fake.fetch);
  });

  it("validates v3 signatures and rejects stale or tampered requests", () => {
    const now = Date.now();
    const ts = String(now);
    const uri = "https://app.test/api/integrations/hubspot/webhooks";
    const sig = computeSignatureV3("secret", "POST", uri, '{"a":1}', ts);
    expect(verifySignatureV3({ secret: "secret", method: "POST", uri, body: '{"a":1}', signature: sig, timestamp: ts, now })).toBe(true);
    expect(verifySignatureV3({ secret: "secret", method: "POST", uri, body: '{"a":2}', signature: sig, timestamp: ts, now })).toBe(false);
    expect(verifySignatureV3({ secret: "other", method: "POST", uri, body: '{"a":1}', signature: sig, timestamp: ts, now })).toBe(false);
    expect(verifySignatureV3({ secret: "secret", method: "POST", uri, body: '{"a":1}', signature: sig, timestamp: ts, now: now + 6 * 60 * 1000 })).toBe(false);
    expect(verifySignatureV3({ secret: "secret", method: "POST", uri, body: "", signature: null, timestamp: ts, now })).toBe(false);
  });

  it("webhook processing is idempotent under duplicate delivery", async () => {
    const { org, admin } = await createActiveOrg();
    await prisma.hubSpotConnection.create({
      data: { organizationId: org.id, portalId: "5555", accessTokenEnc: encrypt("a"), refreshTokenEnc: encrypt("r"), expiresAt: new Date(Date.now() + 3600e3), scopes: [] },
    });
    const doc = await prisma.document.create({
      data: {
        organizationId: org.id, type: "QUOTE", number: "Q-X-1", title: "t", ownerId: admin.id,
        createdById: admin.id, currency: "MAD", publicToken: "A".repeat(32), hubspotDealId: "123", hubspotDealName: "Old",
      },
    });
    const event = { eventId: 99, portalId: 5555, subscriptionType: "deal.propertyChange", objectId: 123, propertyName: "dealname", propertyValue: "New name", occurredAt: Date.now() };
    const first = await ingestWebhookEvents([event]);
    const second = await ingestWebhookEvents([event, event]);
    expect(first).toEqual({ received: 1, duplicates: 0 });
    expect(second).toEqual({ received: 0, duplicates: 2 });
    await processJobs();
    await processJobs();
    expect(await prisma.hubSpotWebhookEvent.count({ where: { portalId: "5555" } })).toBe(1);
    expect((await prisma.hubSpotWebhookEvent.findFirstOrThrow({ where: { portalId: "5555" } })).status).toBe("PROCESSED");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).hubspotDealName).toBe("New name");
    // Unknown portals are stored but ignored.
    await ingestWebhookEvents([{ ...event, portalId: 1, eventId: 1 }]);
    expect((await prisma.hubSpotWebhookEvent.findFirstOrThrow({ where: { portalId: "1" } })).status).toBe("IGNORED");
  });

  it("refreshes expired access tokens and marks revoked connections", async () => {
    const { org } = await createActiveOrg("Token Org");
    const conn = await prisma.hubSpotConnection.create({
      data: { organizationId: org.id, portalId: "7777", accessTokenEnc: encrypt("old"), refreshTokenEnc: encrypt(fake.refreshToken), expiresAt: new Date(Date.now() - 1000), scopes: [] },
    });
    expect(await getAccessToken(conn.id)).toBe(fake.accessToken);
    const refreshed = await prisma.hubSpotConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const revoked = await prisma.hubSpotConnection.create({
      data: { organizationId: org.id, portalId: "7778", accessTokenEnc: encrypt("old"), refreshTokenEnc: encrypt("revoked"), expiresAt: new Date(Date.now() - 1000), scopes: [] },
    });
    await expect(getAccessToken(revoked.id)).rejects.toThrow(/reconnect/i);
    expect((await prisma.hubSpotConnection.findUniqueOrThrow({ where: { id: revoked.id } })).status).toBe("ERROR");
  });
});
