import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { BUILTIN_VARIABLES, VARIABLE_KEY_PATTERN, type VariableDefinition } from "@/domain/variables";
import { PERMISSIONS } from "@/domain/permissions";

export const customFieldSchema = z.object({
  key: z.string().trim().min(3).max(120).regex(VARIABLE_KEY_PATTERN, "Use a key like project.startDate"),
  label: z.string().trim().min(1).max(120),
  type: z.enum(["TEXT", "LONG_TEXT", "NUMBER", "DATE", "BOOLEAN", "SELECT"]),
  options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  defaultValue: z.string().max(2000).optional().nullable(),
  appliesTo: z.array(z.enum(["QUOTE", "CONTRACT"])).min(1).default(["QUOTE", "CONTRACT"]),
  required: z.boolean().default(false),
});

const RESERVED_PREFIXES = ["contact.", "company.", "deal.", "document.", "sender.", "organization.", "lineItems."];

export async function upsertCustomField(ctx: OrgContext, input: z.input<typeof customFieldSchema>, id?: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.CUSTOM_FIELDS_MANAGE);
  const data = customFieldSchema.parse(input);
  if (RESERVED_PREFIXES.some((p) => data.key.startsWith(p))) throw new ValidationError("This key is reserved for built-in variables.");
  if (data.type === "SELECT" && data.options.length === 0) throw new ValidationError("Add at least one option.");
  if (id) {
    const existing = await prisma.customFieldDefinition.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!existing) throw new NotFoundError("Custom variable");
    if (existing.key !== data.key) throw new ValidationError("The key of an existing variable cannot change (documents reference it).");
    const updated = await prisma.customFieldDefinition.update({ where: { id }, data: { ...data, defaultValue: data.defaultValue ?? null } });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "CUSTOM_FIELD_UPDATED", entityType: "CustomFieldDefinition", entityId: id, previousValue: existing, newValue: data });
    return updated;
  }
  const clash = await prisma.customFieldDefinition.findFirst({ where: { organizationId: ctx.organizationId, key: data.key } });
  if (clash) throw new ConflictError("A variable with this key already exists.");
  const created = await prisma.customFieldDefinition.create({ data: { organizationId: ctx.organizationId, ...data, defaultValue: data.defaultValue ?? null } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "CUSTOM_FIELD_UPDATED", entityType: "CustomFieldDefinition", entityId: created.id, newValue: data });
  return created;
}

export async function archiveCustomField(ctx: OrgContext, id: string) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.CUSTOM_FIELDS_MANAGE);
  const existing = await prisma.customFieldDefinition.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!existing) throw new NotFoundError("Custom variable");
  await prisma.customFieldDefinition.update({ where: { id }, data: { archivedAt: new Date() } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "CUSTOM_FIELD_UPDATED", entityType: "CustomFieldDefinition", entityId: id, metadata: { archived: true } });
}

/**
 * Complete variable catalogue for the picker: built-ins + custom fields + HubSpot
 * custom properties (mapped in the Zapier settings, or seen in recent snapshots).
 */
export async function variableCatalog(organizationId: string): Promise<VariableDefinition[]> {
  const [custom, integration, snapshots] = await Promise.all([
    prisma.customFieldDefinition.findMany({ where: { organizationId, archivedAt: null }, orderBy: { label: "asc" } }),
    prisma.zapierIntegration.findUnique({ where: { organizationId } }),
    prisma.dealSnapshot.findMany({ where: { organizationId }, orderBy: { receivedAt: "desc" }, take: 20, select: { payload: true } }),
  ]);
  const map = (integration?.propertyVariableMap ?? {}) as Record<string, string>;
  const names = new Set<string>(Object.keys(map));
  for (const s of snapshots) for (const k of Object.keys((s.payload as { customProperties?: Record<string, string> }).customProperties ?? {})) names.add(k);
  const known = new Set([...BUILTIN_VARIABLES.map((v) => v.key), ...custom.map((c) => c.key)]);
  const hubspot = [...names]
    .map((name) => ({ key: map[name] || `hubspot.${name}`, label: name, group: "HubSpot" }))
    .filter((v) => !known.has(v.key));
  return [...BUILTIN_VARIABLES, ...custom.map((c) => ({ key: c.key, label: c.label, group: "Custom" })), ...hubspot];
}
