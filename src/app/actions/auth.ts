"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/server/db";
import { formString, runAction } from "@/server/actions";
import { requestMeta } from "@/server/request";
import { authenticate, registerUser, requestPasswordReset, resetPassword, sendVerificationEmail } from "@/server/services/auth";
import { createSession, setSessionCookie, clearSessionCookie, revokeSession } from "@/server/auth/session";
import { getCurrentUser } from "@/server/auth/context";
import { acceptInvitation } from "@/server/services/members";
import { audit } from "@/server/audit";
import { enforceRateLimit } from "@/server/security/rate-limit";
import type { ActionState } from "@/lib/action-state";

function safeNext(value: string): string {
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/dashboard";
}

export async function loginAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const next = safeNext(formString(form, "next") || "/dashboard");
  const result = await runAction("login", async () => {
    const meta = await requestMeta();
    const user = await authenticate(formString(form, "email"), formString(form, "password"), meta);
    const membership = await prisma.organizationMembership.findFirst({ where: { userId: user.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
    const { token, session } = await createSession(user.id, meta, membership?.organizationId ?? null);
    await setSessionCookie(token, session.expiresAt);
  });
  if (!result?.ok) return result;
  redirect(next);
}

export async function registerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("register", async () => {
    const meta = await requestMeta();
    const user = await registerUser({ name: formString(form, "name"), email: formString(form, "email"), password: formString(form, "password") }, meta);
    const { token, session } = await createSession(user.id, meta);
    await setSessionCookie(token, session.expiresAt);
  });
  if (!result?.ok) return result;
  redirect("/verify-email");
}

export async function resendVerificationAction(): Promise<ActionState> {
  return runAction("resendVerification", async () => {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "Please sign in again." };
    await enforceRateLimit(`verify-resend:${user.id}`, 3, 3600);
    if (!user.emailVerified) await sendVerificationEmail(user);
    return { ok: true, message: "Verification email sent." };
  });
}

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) {
    await revokeSession(user.sessionId);
    const meta = await requestMeta();
    await audit({ userId: user.id, action: "USER_LOGGED_OUT", entityType: "User", entityId: user.id, ip: meta.ip, userAgent: meta.userAgent });
  }
  await clearSessionCookie();
  redirect("/login");
}

export async function forgotPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("forgotPassword", async () => {
    const email = z.string().email().safeParse(formString(form, "email").trim());
    if (!email.success) return { ok: false, error: "Enter a valid email address." };
    await requestPasswordReset(email.data, await requestMeta());
    return { ok: true, message: "If an account exists for this email, we sent a reset link." };
  });
}

export async function resetPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("resetPassword", async () => {
    if (formString(form, "password") !== formString(form, "confirm")) return { ok: false, error: "Passwords do not match.", fieldErrors: { confirm: ["Passwords do not match."] } };
    await resetPassword(formString(form, "token"), formString(form, "password"), await requestMeta());
  });
  if (!result?.ok) return result;
  redirect("/login?reset=1");
}

export async function acceptInvitationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("acceptInvitation", async () => {
    const meta = await requestMeta();
    const current = await getCurrentUser();
    const { user, organizationId } = await acceptInvitation(formString(form, "token"), { name: formString(form, "name"), password: formString(form, "password"), currentUserId: current?.id ?? null }, meta);
    if (!current) {
      const { token, session } = await createSession(user.id, meta, organizationId);
      await setSessionCookie(token, session.expiresAt);
    } else {
      await prisma.session.update({ where: { id: current.sessionId }, data: { activeOrganizationId: organizationId } });
    }
  });
  if (!result?.ok) return result;
  redirect("/dashboard");
}
