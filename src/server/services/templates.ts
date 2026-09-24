import type { DocumentType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { starterContractBlocks, starterQuoteBlocks } from "./starter-content";
import { parseBlocks, walkBlocks, type Block } from "@/domain/blocks";
import { sanitizeRichText } from "@/domain/richtext";
import { PERMISSIONS } from "@/domain/permissions";
import { CURRENCY_CODES } from "@/domain/currencies";

export const taxDefinitionSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(60),
  rate: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/, "Rate must be a percentage like 20 or 7.5"),
});

export const templateSettingsSchema = z.object({
  acceptanceMode: z.enum(["ACCEPTANCE_ONLY", "SIGNATURE_REQUIRED"]).default("ACCEPTANCE_ONLY"),
  expirationDays: z.number().int().min(0).max(3650).default(30),
  signingOrder: z.enum(["ANY", "SEQUENTIAL"]).default("ANY"),
  defaultTaxes: z.array(taxDefinitionSchema).max(10).default([]),
  applyDefaultTaxes: z.boolean().default(true),
  currency: z.enum(CURRENCY_CODES as [string, ...string[]]).nullable().default(null),
});

export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

export function parseTemplateSettings(value: unknown, type: DocumentType): TemplateSettings {
  const parsed = templateSettingsSchema.parse(value ?? {});
  // Contracts always require signatures.
  if (type === "CONTRACT") parsed.acceptanceMode = "SIGNATURE_REQUIRED";
  return parsed;
}

/** Sanitise rich-text props in a block tree before persisting. */
export function sanitizeBlocks(blocks: Block[]): Block[] {
  const copy = structuredClone(blocks);
  walkBlocks(copy, (b) => {
    const props = b.props as Record<string, unknown>;
    if (typeof props.html === "string") props.html = sanitizeRichText(props.html);
  });
  return copy;
}

function guardManage(ctx: OrgContext) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.TEMPLATES_MANAGE);
}

async function loadTemplate(ctx: OrgContext, id: string) {
  const template = await prisma.template.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!template) throw new NotFoundError("Template");
  return template;
}

export async function listTemplates(ctx: OrgContext, filter: { type?: DocumentType; archived?: boolean; publishedOnly?: boolean } = {}) {
  assertPermission(ctx, PERMISSIONS.TEMPLATES_VIEW);
  return prisma.template.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: filter.archived ? "ARCHIVED" : "ACTIVE",
      ...(filter.type ? { documentType: filter.type } : {}),
      ...(filter.publishedOnly ? { publishedVersionId: { not: null } } : {}),
    },
    include: { versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true, updatedAt: true } } },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  });
}

export async function getTemplateForEditing(ctx: OrgContext, id: string) {
  assertPermission(ctx, PERMISSIONS.TEMPLATES_VIEW);
  const template = await loadTemplate(ctx, id);
  const latest = await prisma.templateVersion.findFirst({ where: { templateId: template.id }, orderBy: { version: "desc" } });
  if (!latest) throw new NotFoundError("Template version");
  return { template, version: latest, blocks: parseBlocks(latest.content), settings: parseTemplateSettings(latest.settings, template.documentType) };
}

export const createTemplateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  documentType: z.enum(["QUOTE", "CONTRACT"]),
  description: z.string().trim().max(500).optional().default(""),
});

export async function createTemplate(ctx: OrgContext, input: z.input<typeof createTemplateSchema>) {
  guardManage(ctx);
  const data = createTemplateSchema.parse(input);
  const blocks = data.documentType === "QUOTE" ? starterQuoteBlocks() : starterContractBlocks();
  const settings = parseTemplateSettings({ acceptanceMode: data.documentType === "QUOTE" ? "ACCEPTANCE_ONLY" : "SIGNATURE_REQUIRED" }, data.documentType);
  const template = await prisma.$transaction(async (tx) => {
    const template = await tx.template.create({
      data: { organizationId: ctx.organizationId, documentType: data.documentType, name: data.name, description: data.description || null, createdById: ctx.user.id },
    });
    await tx.templateVersion.create({
      data: { organizationId: ctx.organizationId, templateId: template.id, version: 1, status: "DRAFT", content: blocks as unknown as Prisma.InputJsonValue, settings, createdById: ctx.user.id },
    });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "TEMPLATE_CREATED", entityType: "Template", entityId: template.id, newValue: { name: data.name, type: data.documentType } }, tx);
    return template;
  });
  return template;
}

export const saveTemplateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  blocks: z.unknown(),
  settings: z.unknown(),
  expectedUpdatedAt: z.string().datetime().optional(),
});

/**
 * Save the template draft. If the latest version is published, a new draft
 * version is created — published versions (and documents generated from them)
 * are never modified.
 */
export async function saveTemplateDraft(ctx: OrgContext, templateId: string, input: z.input<typeof saveTemplateSchema>) {
  guardManage(ctx);
  const data = saveTemplateSchema.parse(input);
  const template = await loadTemplate(ctx, templateId);
  if (template.status === "ARCHIVED") throw new ConflictError("Archived templates cannot be edited. Restore it first.");
  const blocks = sanitizeBlocks(parseBlocks(data.blocks));
  const settings = parseTemplateSettings(data.settings, template.documentType);

  return prisma.$transaction(async (tx) => {
    const latest = await tx.templateVersion.findFirst({ where: { templateId }, orderBy: { version: "desc" } });
    let version;
    if (latest && latest.status === "DRAFT") {
      if (data.expectedUpdatedAt && latest.updatedAt.toISOString() !== data.expectedUpdatedAt) {
        throw new ConflictError("This template was changed in another window. Reload to get the latest version.", "STALE_TEMPLATE");
      }
      version = await tx.templateVersion.update({
        where: { id: latest.id },
        data: { content: blocks as unknown as Prisma.InputJsonValue, settings },
      });
    } else {
      version = await tx.templateVersion.create({
        data: {
          organizationId: ctx.organizationId,
          templateId,
          version: (latest?.version ?? 0) + 1,
          status: "DRAFT",
          content: blocks as unknown as Prisma.InputJsonValue,
          settings,
          createdById: ctx.user.id,
        },
      });
    }
    if (data.name !== undefined || data.description !== undefined) {
      await tx.template.update({
        where: { id: templateId },
        data: { ...(data.name ? { name: data.name } : {}), ...(data.description !== undefined ? { description: data.description || null } : {}) },
      });
    }
    return version;
  });
}

export async function publishTemplate(ctx: OrgContext, templateId: string) {
  guardManage(ctx);
  const template = await loadTemplate(ctx, templateId);
  const draft = await prisma.templateVersion.findFirst({ where: { templateId, status: "DRAFT" }, orderBy: { version: "desc" } });
  if (!draft) throw new ConflictError("There are no unpublished changes.");
  const blocks = parseBlocks(draft.content);
  if (!blocks.length) throw new ValidationError("A template needs at least one block.");
  await prisma.$transaction(async (tx) => {
    await tx.templateVersion.update({ where: { id: draft.id }, data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: ctx.user.id } });
    await tx.template.update({ where: { id: template.id }, data: { publishedVersionId: draft.id } });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "TEMPLATE_PUBLISHED", entityType: "Template", entityId: template.id, metadata: { version: draft.version } }, tx);
  });
}

export async function duplicateTemplate(ctx: OrgContext, templateId: string) {
  guardManage(ctx);
  const { template, version } = await getTemplateForEditing(ctx, templateId);
  return prisma.$transaction(async (tx) => {
    const copy = await tx.template.create({
      data: { organizationId: ctx.organizationId, documentType: template.documentType, name: `${template.name} (copy)`.slice(0, 120), description: template.description, createdById: ctx.user.id },
    });
    await tx.templateVersion.create({
      data: { organizationId: ctx.organizationId, templateId: copy.id, version: 1, status: "DRAFT", content: version.content as Prisma.InputJsonValue, settings: version.settings as Prisma.InputJsonValue, createdById: ctx.user.id },
    });
    await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "TEMPLATE_DUPLICATED", entityType: "Template", entityId: copy.id, metadata: { sourceTemplateId: template.id } }, tx);
    return copy;
  });
}

export async function setTemplateArchived(ctx: OrgContext, templateId: string, archived: boolean) {
  guardManage(ctx);
  const template = await loadTemplate(ctx, templateId);
  await prisma.template.update({
    where: { id: template.id },
    data: archived ? { status: "ARCHIVED", archivedAt: new Date(), isDefault: false } : { status: "ACTIVE", archivedAt: null },
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: archived ? "TEMPLATE_ARCHIVED" : "TEMPLATE_RESTORED", entityType: "Template", entityId: template.id });
}

export async function setDefaultTemplate(ctx: OrgContext, templateId: string) {
  guardManage(ctx);
  const template = await loadTemplate(ctx, templateId);
  if (template.status !== "ACTIVE" || !template.publishedVersionId) throw new ConflictError("Only active, published templates can be the default.");
  await prisma.$transaction([
    prisma.template.updateMany({ where: { organizationId: ctx.organizationId, documentType: template.documentType }, data: { isDefault: false } }),
    prisma.template.update({ where: { id: template.id }, data: { isDefault: true } }),
  ]);
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "TEMPLATE_SET_DEFAULT", entityType: "Template", entityId: template.id });
}
