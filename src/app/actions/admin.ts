"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { prisma } from "@/server/db";
import { formString, runAction } from "@/server/actions";
import { requestMeta } from "@/server/request";
import { getCurrentUser, requirePlatformAdminApi } from "@/server/auth/context";
import { approveOrganization, closeSupportView, openSupportView, reactivateOrganization, rejectOrganization, suspendOrganization } from "@/server/services/organizations";
import { audit } from "@/server/audit";
import { revokeAllUserSessions } from "@/server/auth/session";
import type { ActionState } from "@/lib/action-state";

export async function orgLifecycleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("orgLifecycle", async () => {
    const admin = await requirePlatformAdminApi();
    const meta = await requestMeta();
    const id = formString(form, "organizationId");
    const reason = formString(form, "reason");
    switch (formString(form, "op")) {
      case "approve":
        await approveOrganization(admin.id, id, meta);
        return { ok: true, message: "Organization approved." };
      case "reject":
        await rejectOrganization(admin.id, id, reason, meta);
        return { ok: true, message: "Organization rejected." };
      case "suspend":
        await suspendOrganization(admin.id, id, reason, meta);
        return { ok: true, message: "Organization suspended." };
      case "reactivate":
        await reactivateOrganization(admin.id, id, meta);
        return { ok: true, message: "Organization reactivated." };
      default:
        return { ok: false, error: "Unknown operation" };
    }
  });
}

export async function openSupportViewAction(form: FormData) {
  const user = await getCurrentUser();
  if (!user?.isPlatformAdmin) redirect("/unauthorized");
  await openSupportView(user.id, user.sessionId, formString(form, "organizationId"), await requestMeta());
  redirect("/dashboard");
}

export async function closeSupportViewAction() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  await closeSupportView(user.id, user.sessionId, await requestMeta());
  redirect("/admin/organizations");
}

export async function userStatusAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("platformUserStatus", async () => {
    const admin = await requirePlatformAdminApi();
    const userId = z.string().uuid().parse(formString(form, "userId"));
    if (userId === admin.id) return { ok: false, error: "You cannot change your own status." };
    const status = z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]).parse(formString(form, "status"));
    await prisma.user.update({ where: { id: userId }, data: { status } });
    if (status !== "ACTIVE") await revokeAllUserSessions(userId);
    const meta = await requestMeta();
    await audit({ userId: admin.id, actorType: "PLATFORM_ADMIN", action: status === "ACTIVE" ? "USER_REACTIVATED" : "USER_SUSPENDED", entityType: "User", entityId: userId, ip: meta.ip, userAgent: meta.userAgent, newValue: { status } });
    return { ok: true, message: "User updated." };
  });
}

const planSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  maxUsers: z.string(),
  maxDocumentsPerMonth: z.string(),
  maxStorageMb: z.string(),
  isActive: z.boolean(),
});
const limit = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.floor(Number(v))));

export async function updatePlanAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("updatePlan", async () => {
    const admin = await requirePlatformAdminApi();
    const data = planSchema.parse({
      id: formString(form, "id"),
      name: formString(form, "name"),
      maxUsers: formString(form, "maxUsers"),
      maxDocumentsPerMonth: formString(form, "maxDocumentsPerMonth"),
      maxStorageMb: formString(form, "maxStorageMb"),
      isActive: form.get("isActive") === "on",
    });
    const before = await prisma.plan.findUniqueOrThrow({ where: { id: data.id } });
    const after = await prisma.plan.update({
      where: { id: data.id },
      data: { name: data.name, maxUsers: limit(data.maxUsers), maxDocumentsPerMonth: limit(data.maxDocumentsPerMonth), maxStorageMb: limit(data.maxStorageMb), isActive: data.isActive },
    });
    await audit({ userId: admin.id, actorType: "PLATFORM_ADMIN", action: "PLAN_UPDATED", entityType: "Plan", entityId: data.id, previousValue: before, newValue: after });
    return { ok: true, message: "Plan saved." };
  });
}

export async function assignPlanAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("assignPlan", async () => {
    const admin = await requirePlatformAdminApi();
    const organizationId = z.string().uuid().parse(formString(form, "organizationId"));
    const planId = z.string().uuid().parse(formString(form, "planId"));
    await prisma.$transaction(async (tx) => {
      await tx.subscription.updateMany({ where: { organizationId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      await tx.subscription.create({ data: { organizationId, planId, status: "ACTIVE" } });
      await audit({ organizationId, userId: admin.id, actorType: "PLATFORM_ADMIN", action: "ORGANIZATION_PLAN_CHANGED", entityType: "Organization", entityId: organizationId, newValue: { planId } }, tx);
    });
    return { ok: true, message: "Plan assigned." };
  });
}
