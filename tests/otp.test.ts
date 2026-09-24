import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createDocument, saveDraft, publishDocument, createRevision, cancelDocument } from "@/server/documents/service";
import { acceptQuote, rejectDocument, requestActionCode, verifyActionCode } from "@/server/documents/signing";
import { parseDocumentData } from "@/domain/document-data";
import { createActiveOrg, lastCode, processJobs, resetDatabase, templateId, useOutbox } from "./helpers";

const CLIENT = { ip: "198.51.100.20", userAgent: "Mozilla/5.0 (Macintosh) Safari/605" };

async function publishedQuote(ctx: Awaited<ReturnType<typeof createActiveOrg>>["adminCtx"], email = "client@example.test") {
  const doc = await createDocument(ctx, { type: "QUOTE", templateId: await templateId(ctx.organizationId, "QUOTE") });
  const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: doc.draftVersionId! } });
  const data = parseDocumentData(version.data);
  data.recipients = [{ id: crypto.randomUUID(), name: "Client Person", email, role: "SIGNER", signingOrder: 1, required: true, hubspotContactId: null }];
  await saveDraft(ctx, doc.id, {
    baseUpdatedAt: version.updatedAt.toISOString(),
    data,
    lineItems: [{ id: crypto.randomUUID(), source: "CUSTOM", name: "Service", quantity: "1", unitPrice: "100", discountType: "NONE", discountValue: "0", taxKeys: [] }],
  });
  await publishDocument(ctx, doc.id);
  const fresh = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
  const recipient = await prisma.documentRecipient.findFirstOrThrow({ where: { documentId: doc.id } });
  return { doc: fresh, recipient };
}

describe("OTP verification", () => {
  const outbox = useOutbox();
  let org: Awaited<ReturnType<typeof createActiveOrg>>;

  beforeAll(async () => {
    await resetDatabase();
    org = await createActiveOrg();
  });

  it("stores only a hash and rejects incorrect codes, locking after 5 attempts", async () => {
    const { doc, recipient } = await publishedQuote(org.adminCtx, "attempts@example.test");
    const { challengeId } = await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT);
    await processJobs();
    const code = lastCode(outbox, "attempts@example.test");
    expect(code).toMatch(/^\d{6}$/);
    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(row.codeHash).not.toContain(code);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      await expect(verifyActionCode(doc.publicToken, { challengeId, code: wrong }, CLIENT)).rejects.toThrow(/Incorrect code/);
    }
    await expect(verifyActionCode(doc.publicToken, { challengeId, code: wrong }, CLIENT)).rejects.toThrow(/Too many/);
    // Even the right code no longer works.
    await expect(verifyActionCode(doc.publicToken, { challengeId, code }, CLIENT)).rejects.toThrow(/no longer valid|Too many/);
  });

  it("expires after 10 minutes", async () => {
    const { doc, recipient } = await publishedQuote(org.adminCtx, "expiry@example.test");
    const { challengeId } = await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT);
    await processJobs();
    const code = lastCode(outbox, "expiry@example.test");
    const row = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challengeId } });
    expect(Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - 10 * 60 * 1000)).toBeLessThan(1000);
    await prisma.otpChallenge.update({ where: { id: challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(verifyActionCode(doc.publicToken, { challengeId, code }, CLIENT)).rejects.toThrow(/expired/);
  });

  it("enforces a resend cooldown and invalidates the previous code on resend", async () => {
    const { doc, recipient } = await publishedQuote(org.adminCtx, "resend@example.test");
    const first = await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT);
    await processJobs();
    const firstCode = lastCode(outbox, "resend@example.test");
    await expect(requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT)).rejects.toThrow(/wait/);
    await prisma.otpChallenge.update({ where: { id: first.challengeId }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const second = await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT);
    await processJobs();
    await expect(verifyActionCode(doc.publicToken, { challengeId: first.challengeId, code: firstCode }, CLIENT)).rejects.toThrow(/no longer valid/);
    const { grant } = await verifyActionCode(doc.publicToken, { challengeId: second.challengeId, code: lastCode(outbox, "resend@example.test") }, CLIENT);
    expect(grant.length).toBeGreaterThan(20);
  });

  it("rate-limits OTP requests per recipient", async () => {
    const { doc, recipient } = await publishedQuote(org.adminCtx, "ratelimit@example.test");
    let limited = false;
    for (let i = 0; i < 8; i++) {
      await prisma.otpChallenge.updateMany({ where: { documentId: doc.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
      try {
        await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT);
      } catch (e) {
        if (/Too many requests/.test((e as Error).message)) limited = true;
      }
    }
    expect(limited).toBe(true);
  });

  it("a code/grant for one document or action cannot authorize another", async () => {
    const one = await publishedQuote(org.adminCtx, "cross1@example.test");
    const two = await publishedQuote(org.adminCtx, "cross2@example.test");
    const { challengeId } = await requestActionCode(one.doc.publicToken, { recipientId: one.recipient.id, action: "ACCEPT_QUOTE" }, CLIENT);
    await processJobs();
    const code = lastCode(outbox, "cross1@example.test");
    // Challenge id of doc 1 used against doc 2.
    await expect(verifyActionCode(two.doc.publicToken, { challengeId, code }, CLIENT)).rejects.toThrow(/no longer valid/);
    // Recipient of doc 1 cannot request a code on doc 2.
    await expect(requestActionCode(two.doc.publicToken, { recipientId: one.recipient.id, action: "ACCEPT_QUOTE" }, CLIENT)).rejects.toThrow(/not found/);
    const { grant } = await verifyActionCode(one.doc.publicToken, { challengeId, code }, CLIENT);
    await expect(acceptQuote(two.doc.publicToken, { grant }, CLIENT)).rejects.toThrow(/verify your email again/);
    // A grant for ACCEPT cannot be used to REJECT.
    await expect(rejectDocument(one.doc.publicToken, { grant, reason: "no" }, CLIENT)).rejects.toThrow(/verify your email again/);
    await acceptQuote(one.doc.publicToken, { grant }, CLIENT);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: one.doc.id } })).status).toBe("ACCEPTED");
    await expect(requestActionCode(one.doc.publicToken, { recipientId: one.recipient.id, action: "ACCEPT_QUOTE" }, CLIENT)).rejects.toThrow(/already been accepted/);
  });

  it("a new revision invalidates codes issued for the previous version", async () => {
    const { doc, recipient } = await publishedQuote(org.adminCtx, "revision@example.test");
    const { challengeId } = await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT);
    await processJobs();
    const code = lastCode(outbox, "revision@example.test");
    await createRevision(org.adminCtx, doc.id);
    await publishDocument(org.adminCtx, doc.id);
    await expect(verifyActionCode(doc.publicToken, { challengeId, code }, CLIENT)).rejects.toThrow(/no longer valid|updated/);
  });

  it("rejection with reason, and cancelled documents refuse actions", async () => {
    const { doc, recipient } = await publishedQuote(org.adminCtx, "reject@example.test");
    const { challengeId } = await requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "REJECT_DOCUMENT" }, CLIENT);
    await processJobs();
    const { grant } = await verifyActionCode(doc.publicToken, { challengeId, code: lastCode(outbox, "reject@example.test") }, CLIENT);
    await rejectDocument(doc.publicToken, { grant, reason: "Too expensive" }, CLIENT);
    const rejected = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("Too expensive");

    const other = await publishedQuote(org.adminCtx, "cancel@example.test");
    await cancelDocument(org.adminCtx, other.doc.id, "Replaced");
    await expect(requestActionCode(other.doc.publicToken, { recipientId: other.recipient.id, action: "ACCEPT_QUOTE" }, CLIENT)).rejects.toThrow(/cancelled/);
  });

  it("expired documents cannot be accepted", async () => {
    const { doc, recipient } = await publishedQuote(org.adminCtx, "expired-doc@example.test");
    await prisma.document.update({ where: { id: doc.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(requestActionCode(doc.publicToken, { recipientId: recipient.id, action: "ACCEPT_QUOTE" }, CLIENT)).rejects.toThrow(/expired/);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe("EXPIRED");
  });
});
