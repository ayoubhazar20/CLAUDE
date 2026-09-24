"use server";

import { prisma } from "@/server/db";
import { formString, runAction } from "@/server/actions";
import { assertPermission, assertWritable, requireOrgApi } from "@/server/auth/context";
import { audit } from "@/server/audit";
import { isCurrencyCode } from "@/domain/currencies";
import { PERMISSIONS } from "@/domain/permissions";
import type { ActionState } from "@/lib/action-state";

export async function saveCurrencyAction(form: FormData): Promise<ActionState> {
  return runAction("saveCurrency", async () => {
    const ctx = await requireOrgApi();
    assertWritable(ctx);
    assertPermission(ctx, PERMISSIONS.ORG_SETTINGS_MANAGE);
    const currency = formString(form, "currency");
    if (!isCurrencyCode(currency)) return { ok: false, error: "Unsupported currency" };
    await prisma.organization.update({ where: { id: ctx.organizationId }, data: { defaultCurrency: currency } });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "ORGANIZATION_UPDATED", entityType: "Organization", entityId: ctx.organizationId, newValue: { defaultCurrency: currency } });
    return { ok: true };
  });
}
