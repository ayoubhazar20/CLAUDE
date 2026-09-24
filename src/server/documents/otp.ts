import type { OtpAction } from "@prisma/client";
import { prisma, type Tx } from "../db";
import { AppError } from "../errors";
import { hmac, numericCode, randomToken, safeEqual } from "../security/crypto";
import { enforceRateLimit } from "../security/rate-limit";
import type { RequestMeta } from "../request";
import { queueEmail } from "../email/service";
import { renderEmailLayout, textToEmailHtml } from "../email/layout";
import { recordEvent } from "./events";

/**
 * One-time passcodes for client actions.
 *  - 6 numeric digits, 10 minute expiry, 5 attempts max, resend with cooldown.
 *  - Only an HMAC is stored, bound to (challenge, document, version, recipient, email, action),
 *    so a code for one document/action can never authorise another.
 *  - A verified OTP yields a short-lived single-use grant consumed by the final action.
 */
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
export const GRANT_TTL_MS = 15 * 60 * 1000;

export class OtpError extends AppError {
  constructor(message: string, code: string, status = 400) {
    super(message, status, code);
  }
}

interface Binding {
  challengeId: string;
  documentId: string;
  versionNumber: number;
  recipientId: string;
  email: string;
  action: OtpAction;
}

export function otpHash(b: Binding, code: string): string {
  return hmac(`${b.challengeId}|${b.documentId}|${b.versionNumber}|${b.recipientId}|${b.email.toLowerCase()}|${b.action}|${code}`, "otp");
}

export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${"•".repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

export async function invalidateOpenChallenges(tx: Tx, documentId: string, filter: { recipientId?: string; action?: OtpAction } = {}) {
  await tx.otpChallenge.updateMany({
    where: { documentId, verifiedAt: null, invalidatedAt: null, ...filter },
    data: { invalidatedAt: new Date() },
  });
  // Unused grants of a superseded version must not be usable either.
  await tx.otpChallenge.updateMany({
    where: { documentId, verifiedAt: { not: null }, consumedAt: null, invalidatedAt: null, ...filter },
    data: { invalidatedAt: new Date() },
  });
}

export async function issueOtp(params: {
  document: { id: string; organizationId: string; number: string; title: string };
  organization: { name: string; brandColor: string };
  versionNumber: number;
  recipient: { id: string; email: string; name: string };
  action: OtpAction;
  meta: RequestMeta;
}) {
  const { document, recipient, action, meta } = params;
  await enforceRateLimit(`otp:ip:${meta.ip ?? "unknown"}`, 30, 3600);
  await enforceRateLimit(`otp:recipient:${document.id}:${recipient.id}`, 6, 15 * 60);

  const last = await prisma.otpChallenge.findFirst({
    where: { documentId: document.id, recipientId: recipient.id, action },
    orderBy: { createdAt: "desc" },
  });
  if (last && Date.now() - last.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw new OtpError("Please wait a few seconds before requesting a new code.", "OTP_COOLDOWN", 429);
  }

  const code = numericCode(6);
  const challenge = await prisma.$transaction(async (tx) => {
    await invalidateOpenChallenges(tx, document.id, { recipientId: recipient.id, action });
    const created = await tx.otpChallenge.create({
      data: {
        organizationId: document.organizationId,
        documentId: document.id,
        versionNumber: params.versionNumber,
        recipientId: recipient.id,
        email: recipient.email.toLowerCase(),
        action,
        codeHash: "pending",
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        maxAttempts: OTP_MAX_ATTEMPTS,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    const hash = otpHash({ challengeId: created.id, documentId: document.id, versionNumber: params.versionNumber, recipientId: recipient.id, email: recipient.email, action }, code);
    await tx.otpChallenge.update({ where: { id: created.id }, data: { codeHash: hash } });
    await recordEvent(tx, document, "OTP_REQUESTED", { type: "RECIPIENT", recipientId: recipient.id, label: recipient.name, ip: meta.ip, userAgent: meta.userAgent }, params.versionNumber, { action, email: maskEmail(recipient.email) });
    return created;
  });

  const verb = action === "ACCEPT_QUOTE" ? "accept" : action === "SIGN_CONTRACT" ? "sign" : "respond to";
  await queueEmail({
    organizationId: document.organizationId,
    documentId: document.id,
    versionNumber: params.versionNumber,
    kind: "OTP",
    to: [recipient.email],
    subject: `${code} is your verification code for ${document.number}`,
    html: renderEmailLayout({
      brandName: params.organization.name,
      brandColor: params.organization.brandColor,
      bodyHtml:
        textToEmailHtml(`Hello ${recipient.name},\n\nUse this code to ${verb} ${document.title} (${document.number}):`) +
        `<p style="font-size:30px;letter-spacing:8px;font-weight:700;margin:16px 0">${code}</p>` +
        textToEmailHtml("The code expires in 10 minutes. If you did not request it, you can ignore this email."),
    }),
    text: `Your verification code for ${document.number} is ${code}. It expires in 10 minutes.`,
  });
  return { challengeId: challenge.id, expiresAt: challenge.expiresAt, maskedEmail: maskEmail(recipient.email) };
}

/** Verify a code. Returns a single-use grant token on success. */
export async function verifyOtp(params: { documentId: string; currentVersionNumber: number; challengeId: string; code: string; meta: RequestMeta }) {
  const { meta } = params;
  if (!/^[0-9a-f-]{36}$/i.test(params.challengeId)) throw new OtpError("Invalid verification request.", "OTP_INVALID");
  const code = params.code.replace(/\s+/g, "");
  await enforceRateLimit(`otp-verify:ip:${meta.ip ?? "unknown"}`, 60, 3600);

  const challenge = await prisma.otpChallenge.findFirst({ where: { id: params.challengeId, documentId: params.documentId }, include: { recipient: true } });
  if (!challenge || challenge.invalidatedAt || challenge.consumedAt) throw new OtpError("This code is no longer valid. Request a new one.", "OTP_INVALID");
  if (challenge.verifiedAt) throw new OtpError("This code was already used. Request a new one.", "OTP_USED");
  if (challenge.versionNumber !== params.currentVersionNumber) throw new OtpError("The document was updated. Please review it again and request a new code.", "OTP_STALE");
  if (challenge.expiresAt < new Date()) throw new OtpError("This code has expired. Request a new one.", "OTP_EXPIRED");

  // Count the attempt atomically before comparing (prevents parallel guessing).
  const counted = await prisma.otpChallenge.updateMany({
    where: { id: challenge.id, attempts: { lt: challenge.maxAttempts }, verifiedAt: null, invalidatedAt: null },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count === 0) throw new OtpError("Too many incorrect attempts. Request a new code.", "OTP_LOCKED");

  const binding = { challengeId: challenge.id, documentId: challenge.documentId, versionNumber: challenge.versionNumber, recipientId: challenge.recipientId, email: challenge.email, action: challenge.action };
  const valid = /^\d{6}$/.test(code) && safeEqual(otpHash(binding, code), challenge.codeHash);
  const actor = { type: "RECIPIENT" as const, recipientId: challenge.recipientId, label: challenge.recipient.name, ip: meta.ip, userAgent: meta.userAgent };
  const doc = { id: challenge.documentId, organizationId: challenge.organizationId };

  if (!valid) {
    const after = await prisma.otpChallenge.findUniqueOrThrow({ where: { id: challenge.id } });
    const remaining = after.maxAttempts - after.attempts;
    await prisma.$transaction(async (tx) => {
      if (remaining <= 0) await tx.otpChallenge.update({ where: { id: challenge.id }, data: { invalidatedAt: new Date() } });
      await recordEvent(tx, doc, "OTP_FAILED", actor, challenge.versionNumber, { action: challenge.action, remainingAttempts: Math.max(0, remaining) });
    });
    if (remaining <= 0) throw new OtpError("Too many incorrect attempts. Request a new code.", "OTP_LOCKED");
    throw new OtpError(`Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`, "OTP_INCORRECT");
  }

  const grant = randomToken(32);
  await prisma.$transaction(async (tx) => {
    await tx.otpChallenge.update({
      where: { id: challenge.id },
      data: { verifiedAt: new Date(), grantHash: hmac(grant, "otp-grant"), grantExpiresAt: new Date(Date.now() + GRANT_TTL_MS) },
    });
    await recordEvent(tx, doc, "OTP_VERIFIED", actor, challenge.versionNumber, { action: challenge.action, email: maskEmail(challenge.email) });
  });
  return { grant, action: challenge.action, recipientId: challenge.recipientId };
}

/** Consume a verified grant inside the action's transaction (single use, bound to doc/version/action). */
export async function consumeGrant(tx: Tx, params: { documentId: string; versionNumber: number; grant: string; action: OtpAction }) {
  if (!params.grant || params.grant.length > 100) throw new OtpError("Verification required.", "OTP_REQUIRED", 403);
  const challenge = await tx.otpChallenge.findUnique({ where: { grantHash: hmac(params.grant, "otp-grant") }, include: { recipient: true } });
  if (
    !challenge ||
    challenge.documentId !== params.documentId ||
    challenge.action !== params.action ||
    challenge.versionNumber !== params.versionNumber ||
    !challenge.verifiedAt ||
    challenge.invalidatedAt ||
    !challenge.grantExpiresAt ||
    challenge.grantExpiresAt < new Date()
  ) {
    throw new OtpError("Your verification has expired. Please verify your email again.", "OTP_REQUIRED", 403);
  }
  const consumed = await tx.otpChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw new OtpError("This verification was already used.", "OTP_REQUIRED", 403);
  return challenge;
}
