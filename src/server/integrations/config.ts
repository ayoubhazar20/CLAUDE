import type { ZapierIntegration } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { env, isProduction } from "../env";
import { audit } from "../audit";
import { ValidationError } from "../errors";
import { encrypt, hmac, randomToken } from "../security/crypto";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { DEFAULT_DEAL_PROPERTY_NAMES, DEFAULT_STATUS_LABELS } from "./deal-properties";
import { PERMISSIONS } from "@/domain/permissions";
import { VARIABLE_KEY_PATTERN } from "@/domain/variables";

/**
 * "HubSpot via Zapier" integration settings (one per organization).
 * DealDocs holds no HubSpot credentials — only the HubSpot custom object type id,
 * the Zapier webhook URL and a per-organization integration secret.
 */

export const SECRET_PREFIX = "ddz_";

export function hashIntegrationSecret(secret: string): string {
  return hmac(secret, "zapier-secret");
}

export async function getIntegration(organizationId: string) {
  return prisma.zapierIntegration.findUnique({ where: { organizationId } });
}

/** Custom object type id: organization setting, else the deployment default. */
export function objectTypeIdFor(integration: Pick<ZapierIntegration, "hubspotObjectTypeId"> | null): string | null {
  return integration?.hubspotObjectTypeId || env().HUBSPOT_DOCUMENT_OBJECT_TYPE_ID || null;
}

export function isConfigured(integration: ZapierIntegration | null): integration is ZapierIntegration & { webhookUrl: string; secretEnc: string } {
  return Boolean(integration?.enabled && integration.webhookUrl && integration.secretEnc);
}

/** Outbound targets are restricted to allowed hosts over HTTPS (SSRF protection). */
export function validateWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError("Enter a valid webhook URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !isProduction() && url.hostname === "localhost")) {
    throw new ValidationError("The webhook URL must use HTTPS.");
  }
  if (url.username || url.password) throw new ValidationError("Credentials are not allowed in the webhook URL.");
  const allowed = env()
    .ZAPIER_ALLOWED_HOSTS.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (!allowed.some((a) => host === a || host.endsWith(`.${a}`)) && !(host === "localhost" && !isProduction())) {
    throw new ValidationError(`Webhook host must be one of: ${allowed.join(", ")}.`);
  }
  return url.toString();
}

const objectTypeId = z
  .string()
  .trim()
  .regex(/^\d+-\d+$/, "Object type ids look like 2-12345678")
  .or(z.literal(""));

const stringMap = (valueCheck?: (v: string) => boolean, message?: string) =>
  z.record(z.string().trim().max(120)).refine((m) => Object.keys(m).length <= 50 && (!valueCheck || Object.values(m).every((v) => v === "" || valueCheck(v))), message ?? "Invalid mapping");

export const integrationSettingsSchema = z.object({
  enabled: z.boolean(),
  hubspotObjectTypeId: objectTypeId,
  webhookUrl: z.string().trim().max(500),
  dealPropertyNames: stringMap((v) => /^[a-z0-9_]{1,100}$/i.test(v), "HubSpot property names use letters, digits and underscores").default({}),
  statusMapping: stringMap().default({}),
  propertyVariableMap: stringMap((v) => VARIABLE_KEY_PATTERN.test(v), "Variable keys look like project.startDate").default({}),
});

function guard(ctx: OrgContext) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.INTEGRATIONS_MANAGE);
}

export async function saveIntegrationSettings(ctx: OrgContext, input: z.input<typeof integrationSettingsSchema>) {
  guard(ctx);
  const data = integrationSettingsSchema.parse(input);
  const webhookUrl = data.webhookUrl ? validateWebhookUrl(data.webhookUrl) : null;
  const clean = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== ""));
  const before = await getIntegration(ctx.organizationId);
  const values = {
    enabled: data.enabled,
    hubspotObjectTypeId: data.hubspotObjectTypeId || null,
    webhookUrl,
    dealPropertyNames: clean(data.dealPropertyNames),
    statusMapping: clean(data.statusMapping),
    propertyVariableMap: clean(data.propertyVariableMap),
  };
  const saved = await prisma.zapierIntegration.upsert({
    where: { organizationId: ctx.organizationId },
    create: { organizationId: ctx.organizationId, ...values },
    update: values,
  });
  await audit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: "INTEGRATION_UPDATED",
    entityType: "ZapierIntegration",
    entityId: saved.id,
    ip: ctx.meta.ip,
    userAgent: ctx.meta.userAgent,
    previousValue: before ? { enabled: before.enabled, hubspotObjectTypeId: before.hubspotObjectTypeId, webhookHost: before.webhookUrl ? new URL(before.webhookUrl).host : null } : null,
    newValue: { enabled: saved.enabled, hubspotObjectTypeId: saved.hubspotObjectTypeId, webhookHost: webhookUrl ? new URL(webhookUrl).host : null },
  });
  return saved;
}

/** Generate (or rotate) the integration secret. The raw value is returned once and never stored in clear. */
export async function rotateIntegrationSecret(ctx: OrgContext): Promise<string> {
  guard(ctx);
  const secret = `${SECRET_PREFIX}${randomToken(32)}`;
  const data = { secretHash: hashIntegrationSecret(secret), secretEnc: encrypt(secret), secretPrefix: secret.slice(0, 10), secretRotatedAt: new Date() };
  const saved = await prisma.zapierIntegration.upsert({
    where: { organizationId: ctx.organizationId },
    create: { organizationId: ctx.organizationId, ...data },
    update: data,
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "INTEGRATION_SECRET_ROTATED", entityType: "ZapierIntegration", entityId: saved.id, ip: ctx.meta.ip, userAgent: ctx.meta.userAgent });
  return secret;
}

export function effectiveDealPropertyNames(integration: Pick<ZapierIntegration, "dealPropertyNames"> | null): Record<string, string> {
  return { ...DEFAULT_DEAL_PROPERTY_NAMES, ...((integration?.dealPropertyNames ?? {}) as Record<string, string>) };
}

export function effectiveStatusLabels(integration: Pick<ZapierIntegration, "statusMapping"> | null): Record<string, string> {
  return { ...DEFAULT_STATUS_LABELS, ...((integration?.statusMapping ?? {}) as Record<string, string>) };
}
