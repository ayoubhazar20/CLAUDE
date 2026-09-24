"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { formBool, formString, runAction } from "@/server/actions";
import { requestMeta } from "@/server/request";
import { getCurrentUser, requireOrgApi } from "@/server/auth/context";
import { createOrganization, updateBranding, updateCompanyProfile, updateNumbering, updateOnboarding, ONBOARDING_STEPS, type OnboardingStep } from "@/server/services/organizations";
import type { ActionState } from "@/lib/action-state";

function profileFromForm(form: FormData) {
  return {
    name: formString(form, "name"),
    legalName: formString(form, "legalName"),
    country: formString(form, "country"),
    addressLine1: formString(form, "addressLine1"),
    addressLine2: formString(form, "addressLine2"),
    city: formString(form, "city"),
    postalCode: formString(form, "postalCode"),
    region: formString(form, "region"),
    phone: formString(form, "phone"),
    website: formString(form, "website"),
    defaultCurrency: formString(form, "defaultCurrency"),
    timezone: formString(form, "timezone"),
    language: "en" as const,
    registrationNumber: formString(form, "registrationNumber"),
    vatNumber: formString(form, "vatNumber"),
  };
}

export async function createCompanyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("createCompany", async () => {
    const user = await getCurrentUser();
    if (!user) return { ok: false, error: "Please sign in again." };
    const org = await createOrganization(
      user.id,
      { ...profileFromForm(form), acceptTerms: formBool(form, "acceptTerms") as true, acceptPrivacy: formBool(form, "acceptPrivacy") as true },
      await requestMeta(),
    );
    await prisma.session.update({ where: { id: user.sessionId }, data: { activeOrganizationId: org.id } });
  });
  if (!result?.ok) return result;
  redirect("/pending-approval");
}

export async function updateProfileAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("updateProfile", async () => {
    const ctx = await requireOrgApi();
    await updateCompanyProfile(ctx, profileFromForm(form));
    if (formString(form, "onboardingStep")) await updateOnboarding(ctx, formString(form, "onboardingStep") as OnboardingStep, "done");
    return { ok: true, message: "Company profile saved." };
  });
}

export async function updateBrandingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("updateBranding", async () => {
    const ctx = await requireOrgApi();
    const logo = formString(form, "logoFileId");
    await updateBranding(ctx, { brandColor: formString(form, "brandColor"), logoFileId: logo === "__remove__" ? null : logo || undefined });
    if (formString(form, "onboardingStep")) await updateOnboarding(ctx, "branding", "done");
    return { ok: true, message: "Branding saved." };
  });
}

export async function onboardingStepAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const step = formString(form, "step") as OnboardingStep;
  const status = formString(form, "status") === "skipped" ? "skipped" : "done";
  const result = await runAction("onboardingStep", async () => {
    if (!ONBOARDING_STEPS.includes(step)) return { ok: false, error: "Unknown step" };
    const ctx = await requireOrgApi();
    await updateOnboarding(ctx, step, status);
  });
  if (!result?.ok) return result;
  const next = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1];
  redirect(step === "ready" ? "/dashboard" : `/onboarding?step=${next ?? "ready"}`);
}

export async function updateNumberingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("updateNumbering", async () => {
    const ctx = await requireOrgApi();
    await updateNumbering(ctx, {
      documentType: formString(form, "documentType") as "QUOTE" | "CONTRACT",
      prefix: formString(form, "prefix"),
      includeYear: formBool(form, "includeYear"),
      startNumber: Number(formString(form, "startNumber")),
      padding: Number(formString(form, "padding")),
    });
    return { ok: true, message: "Numbering saved." };
  });
}

export async function switchOrganizationAction(form: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const organizationId = formString(form, "organizationId");
  const membership = await prisma.organizationMembership.findFirst({ where: { userId: user.id, organizationId, status: "ACTIVE" } });
  if (membership) await prisma.session.update({ where: { id: user.sessionId }, data: { activeOrganizationId: organizationId } });
  redirect("/dashboard");
}
