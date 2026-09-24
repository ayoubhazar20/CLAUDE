import { cookies } from "next/headers";
import { prisma } from "../db";
import { isProduction } from "../env";
import { hmac, randomToken } from "../security/crypto";

export const SESSION_COOKIE = "dd_session";
const ABSOLUTE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const IDLE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days of inactivity
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return hmac(token, "session");
}

export async function createSession(userId: string, meta: { ip: string | null; userAgent: string | null }, activeOrganizationId?: string | null) {
  const token = randomToken(32);
  const now = Date.now();
  const session = await prisma.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId,
      activeOrganizationId: activeOrganizationId ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      expiresAt: new Date(now + ABSOLUTE_TTL_MS),
    },
  });
  return { token, session };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Validate a raw session token. Returns null when missing, revoked, expired or idle. */
export async function validateSessionToken(token: string | undefined | null) {
  if (!token || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.revokedAt || session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > IDLE_TTL_MS) {
    return null;
  }
  if (session.user.status !== "ACTIVE") return null;
  if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }
  return session;
}

export async function getSessionFromCookies() {
  const store = await cookies();
  return validateSessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function revokeSession(sessionId: string) {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}

export async function revokeAllUserSessions(userId: string, exceptSessionId?: string) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}
