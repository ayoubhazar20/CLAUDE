import { z } from "zod";
import { prisma } from "../db";
import { appUrl } from "../env";
import { audit } from "../audit";
import { AppError, ValidationError } from "../errors";
import { hmac, randomToken } from "../security/crypto";
import { hashPassword, passwordPolicyError, verifyPassword } from "../security/password";
import { enforceRateLimit } from "../security/rate-limit";
import type { RequestMeta } from "../request";
import { queueEmail } from "../email/service";
import { renderEmailLayout, textToEmailHtml } from "../email/layout";
import { revokeAllUserSessions } from "../auth/session";

export const emailSchema = z.string().trim().toLowerCase().email().max(320);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 15 * 60 * 1000;

async function issueUserToken(userId: string, type: "EMAIL_VERIFICATION" | "PASSWORD_RESET", ttlMs: number) {
  const token = randomToken(32);
  // Invalidate previous unused tokens of the same type.
  await prisma.userToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.userToken.create({
    data: { userId, type, tokenHash: hmac(token, `user-token:${type}`), expiresAt: new Date(Date.now() + ttlMs) },
  });
  return token;
}

async function consumeUserToken(token: string, type: "EMAIL_VERIFICATION" | "PASSWORD_RESET") {
  if (!token || token.length > 200) return null;
  const row = await prisma.userToken.findUnique({ where: { tokenHash: hmac(token, `user-token:${type}`) } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt < new Date()) return null;
  const updated = await prisma.userToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  return updated.count === 1 ? row : null;
}

export async function sendVerificationEmail(user: { id: string; email: string; name: string }) {
  const token = await issueUserToken(user.id, "EMAIL_VERIFICATION", VERIFY_TTL_MS);
  const url = appUrl(`/verify-email?token=${encodeURIComponent(token)}`);
  await queueEmail({
    kind: "EMAIL_VERIFICATION",
    to: [user.email],
    subject: "Verify your email address",
    html: renderEmailLayout({
      brandName: "DealDocs",
      bodyHtml: textToEmailHtml(`Hello ${user.name},\n\nPlease confirm your email address to continue setting up your DealDocs account. This link expires in 24 hours.`),
      action: { label: "Verify email", url },
    }),
  });
}

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export async function registerUser(input: z.infer<typeof registerSchema>, meta: RequestMeta) {
  const data = registerSchema.parse(input);
  await enforceRateLimit(`register:${meta.ip ?? "unknown"}`, 10, 3600);
  const policy = passwordPolicyError(data.password);
  if (policy) throw new ValidationError(policy, { fieldErrors: { password: [policy] } });
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    // Do not reveal existing accounts beyond a neutral message.
    throw new AppError("An account with this email already exists. Try signing in or resetting your password.", 409, "EMAIL_TAKEN");
  }
  const user = await prisma.user.create({
    data: { name: data.name, email: data.email, passwordHash: await hashPassword(data.password) },
  });
  await audit({ userId: user.id, action: "USER_REGISTERED", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  await sendVerificationEmail(user);
  return user;
}

export async function verifyEmail(token: string, meta: RequestMeta) {
  const row = await consumeUserToken(token, "EMAIL_VERIFICATION");
  if (!row) return null;
  const user = await prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  await audit({ userId: user.id, action: "USER_EMAIL_VERIFIED", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  return user;
}

export class InvalidCredentialsError extends AppError {
  constructor(message = "Invalid email or password.") {
    super(message, 401, "INVALID_CREDENTIALS");
  }
}

export async function authenticate(emailInput: string, password: string, meta: RequestMeta) {
  const email = normalizeEmail(emailInput);
  await enforceRateLimit(`login:ip:${meta.ip ?? "unknown"}`, 30, 15 * 60);
  await enforceRateLimit(`login:email:${email}`, 15, 15 * 60);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Equalise timing with a dummy verification.
    await verifyPassword(password, "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
    throw new InvalidCredentialsError();
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new InvalidCredentialsError("Too many failed attempts. Please try again in a few minutes or reset your password.");
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: failed, lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCK_MS) : null },
    });
    await audit({ userId: user.id, action: "USER_LOGIN_FAILED", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
    throw new InvalidCredentialsError();
  }
  if (user.status === "SUSPENDED") throw new AppError("This account has been suspended. Contact support.", 403, "ACCOUNT_SUSPENDED");
  if (user.status === "DEACTIVATED") throw new AppError("This account has been deactivated.", 403, "ACCOUNT_DEACTIVATED");
  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  await audit({ userId: user.id, action: "USER_LOGGED_IN", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  return user;
}

export async function requestPasswordReset(emailInput: string, meta: RequestMeta) {
  const email = normalizeEmail(emailInput);
  await enforceRateLimit(`reset:ip:${meta.ip ?? "unknown"}`, 10, 3600);
  await enforceRateLimit(`reset:email:${email}`, 3, 3600);
  const user = await prisma.user.findUnique({ where: { email } });
  // Same response whether or not the account exists.
  if (!user || user.status !== "ACTIVE") return;
  const token = await issueUserToken(user.id, "PASSWORD_RESET", RESET_TTL_MS);
  const url = appUrl(`/reset-password?token=${encodeURIComponent(token)}`);
  await queueEmail({
    kind: "PASSWORD_RESET",
    to: [user.email],
    subject: "Reset your DealDocs password",
    html: renderEmailLayout({
      brandName: "DealDocs",
      bodyHtml: textToEmailHtml(`Hello ${user.name},\n\nWe received a request to reset your password. This link expires in 1 hour. If you did not request it, you can ignore this email.`),
      action: { label: "Reset password", url },
    }),
  });
  await audit({ userId: user.id, action: "USER_PASSWORD_RESET_REQUESTED", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
}

export async function resetPassword(token: string, newPassword: string, meta: RequestMeta) {
  const policy = passwordPolicyError(newPassword);
  if (policy) throw new ValidationError(policy, { fieldErrors: { password: [policy] } });
  const row = await consumeUserToken(token, "PASSWORD_RESET");
  if (!row) throw new AppError("This reset link is invalid or has expired.", 400, "INVALID_TOKEN");
  await prisma.user.update({
    where: { id: row.userId },
    data: { passwordHash: await hashPassword(newPassword), failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: new Date() },
  });
  await revokeAllUserSessions(row.userId);
  await audit({ userId: row.userId, action: "USER_PASSWORD_RESET", entityType: "User", entityId: row.userId, ip: meta.ip, userAgent: meta.userAgent });
}
