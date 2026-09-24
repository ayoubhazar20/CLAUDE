import type { AutomationEvent, HubSpotObjectType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../audit";
import { ValidationError } from "../errors";
import { assertPermission, assertWritable, type OrgContext } from "../auth/context";
import { HubSpotApiError, HubSpotClient, requireConnection } from "./client";
import { isValidHubSpotPropertyName, isValidVariableKey, OBJECT_TYPE_API, WRITEBACK_SOURCES } from "./mapping";
import { PERMISSIONS } from "@/domain/permissions";

export const AUTOMATION_EVENTS: { event: AutomationEvent; label: string; type: "QUOTE" | "CONTRACT" }[] = [
  { event: "QUOTE_PUBLISHED", label: "Quote Published", type: "QUOTE" },
  { event: "QUOTE_SENT", label: "Quote Sent", type: "QUOTE" },
  { event: "QUOTE_VIEWED", label: "Quote Viewed", type: "QUOTE" },
  { event: "QUOTE_ACCEPTED", label: "Quote Accepted", type: "QUOTE" },
  { event: "QUOTE_REJECTED", label: "Quote Rejected", type: "QUOTE" },
  { event: "CONTRACT_PUBLISHED", label: "Contract Published", type: "CONTRACT" },
  { event: "CONTRACT_SENT", label: "Contract Sent", type: "CONTRACT" },
  { event: "CONTRACT_VIEWED", label: "Contract Viewed", type: "CONTRACT" },
  { event: "CONTRACT_SIGNED", label: "Contract Signed", type: "CONTRACT" },
  { event: "CONTRACT_REJECTED", label: "Contract Rejected", type: "CONTRACT" },
];

function guard(ctx: OrgContext) {
  assertWritable(ctx);
  assertPermission(ctx, PERMISSIONS.HUBSPOT_MANAGE);
}

// ───────────────────────── Property mapping ─────────────────────────

export const propertyMappingSchema = z.object({
  objectType: z.enum(["DEAL", "CONTACT", "COMPANY", "OWNER"]),
  hubspotProperty: z.string().trim().min(1).max(100),
  variableKey: z.string().trim().min(1).max(120),
  direction: z.enum(["IMPORT", "WRITEBACK"]),
  label: z.string().trim().max(120).optional().nullable(),
});

export async function upsertPropertyMapping(ctx: OrgContext, input: z.input<typeof propertyMappingSchema>) {
  guard(ctx);
  const data = propertyMappingSchema.parse(input);
  if (!isValidHubSpotPropertyName(data.hubspotProperty)) throw new ValidationError("Invalid HubSpot property name");
  if (data.direction === "IMPORT" && !isValidVariableKey(data.variableKey)) throw new ValidationError("Variable keys look like project.startDate");
  if (data.direction === "WRITEBACK") {
    if (data.objectType !== "DEAL") throw new ValidationError("Writeback is supported on Deal properties");
    if (!WRITEBACK_SOURCES.some((s) => s.key === data.variableKey)) throw new ValidationError("Unknown DealDocs value");
  }
  const mapping = await prisma.hubSpotPropertyMapping.upsert({
    where: {
      organizationId_direction_objectType_hubspotProperty_variableKey: {
        organizationId: ctx.organizationId,
        direction: data.direction,
        objectType: data.objectType as HubSpotObjectType,
        hubspotProperty: data.hubspotProperty,
        variableKey: data.variableKey,
      },
    },
    create: { organizationId: ctx.organizationId, ...data, objectType: data.objectType as HubSpotObjectType, label: data.label ?? null },
    update: { label: data.label ?? null, enabled: true },
  });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "PROPERTY_MAPPING_UPDATED", entityType: "HubSpotPropertyMapping", entityId: mapping.id, newValue: data });
  return mapping;
}

export async function deletePropertyMapping(ctx: OrgContext, id: string) {
  guard(ctx);
  const mapping = await prisma.hubSpotPropertyMapping.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!mapping) throw new ValidationError("Mapping not found");
  await prisma.hubSpotPropertyMapping.delete({ where: { id: mapping.id } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "PROPERTY_MAPPING_UPDATED", entityType: "HubSpotPropertyMapping", entityId: mapping.id, previousValue: mapping, newValue: null });
}

// ───────────────────────── Pipeline mapping ─────────────────────────

export const pipelineMappingSchema = z.object({
  event: z.enum(AUTOMATION_EVENTS.map((e) => e.event) as [AutomationEvent, ...AutomationEvent[]]),
  pipelineId: z.string().trim().min(1).max(100),
  stageId: z.string().trim().min(1).max(100),
});

export async function upsertPipelineMapping(ctx: OrgContext, input: z.input<typeof pipelineMappingSchema>) {
  guard(ctx);
  const data = pipelineMappingSchema.parse(input);
  // Validate against the live HubSpot pipelines — stage ids are never hardcoded.
  const connection = await requireConnection(ctx.organizationId);
  const pipelines = await new HubSpotClient(connection.id).getPipelines("deals");
  const pipeline = pipelines.results.find((p) => p.id === data.pipelineId);
  const stage = pipeline?.stages.find((s) => s.id === data.stageId);
  if (!pipeline || !stage) throw new ValidationError("This pipeline stage does not exist in HubSpot");
  const before = await prisma.hubSpotPipelineMapping.findUnique({
    where: { organizationId_event_pipelineId: { organizationId: ctx.organizationId, event: data.event, pipelineId: data.pipelineId } },
  });
  const mapping = await prisma.hubSpotPipelineMapping.upsert({
    where: { organizationId_event_pipelineId: { organizationId: ctx.organizationId, event: data.event, pipelineId: data.pipelineId } },
    create: { organizationId: ctx.organizationId, event: data.event, pipelineId: pipeline.id, pipelineLabel: pipeline.label, stageId: stage.id, stageLabel: stage.label },
    update: { stageId: stage.id, stageLabel: stage.label, pipelineLabel: pipeline.label, enabled: true },
  });
  await audit({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    action: "PIPELINE_MAPPING_UPDATED",
    entityType: "HubSpotPipelineMapping",
    entityId: mapping.id,
    previousValue: before ? { stage: before.stageLabel } : null,
    newValue: { event: data.event, pipeline: pipeline.label, stage: stage.label },
  });
  return mapping;
}

export async function deletePipelineMapping(ctx: OrgContext, id: string) {
  guard(ctx);
  const mapping = await prisma.hubSpotPipelineMapping.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!mapping) throw new ValidationError("Mapping not found");
  await prisma.hubSpotPipelineMapping.delete({ where: { id: mapping.id } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "PIPELINE_MAPPING_UPDATED", entityType: "HubSpotPipelineMapping", entityId: mapping.id, previousValue: { event: mapping.event, stage: mapping.stageLabel }, newValue: null });
}

// ───────────────────────── Connection settings ─────────────────────────

export const connectionSettingsSchema = z.object({
  writebackEnabled: z.boolean(),
  pipelineAutomationEnabled: z.boolean(),
  defaultDocumentType: z.enum(["QUOTE", "CONTRACT"]).default("QUOTE"),
});

export async function updateConnectionSettings(ctx: OrgContext, input: z.input<typeof connectionSettingsSchema>) {
  guard(ctx);
  const data = connectionSettingsSchema.parse(input);
  const connection = await requireConnection(ctx.organizationId);
  await prisma.hubSpotConnection.update({ where: { id: connection.id }, data: { settings: data } });
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "HUBSPOT_SETTINGS_UPDATED", entityType: "HubSpotConnection", entityId: connection.id, previousValue: connection.settings, newValue: data });
}

export async function listPipelines(ctx: OrgContext) {
  assertPermission(ctx, PERMISSIONS.HUBSPOT_MANAGE);
  const connection = await requireConnection(ctx.organizationId);
  const res = await new HubSpotClient(connection.id).getPipelines("deals");
  return res.results.map((p) => ({ id: p.id, label: p.label, stages: [...p.stages].sort((a, b) => a.displayOrder - b.displayOrder).map((s) => ({ id: s.id, label: s.label })) }));
}

export async function listHubSpotProperties(ctx: OrgContext, objectType: HubSpotObjectType) {
  assertPermission(ctx, PERMISSIONS.HUBSPOT_MANAGE);
  const connection = await requireConnection(ctx.organizationId);
  const res = await new HubSpotClient(connection.id).getProperties(OBJECT_TYPE_API[objectType]);
  return res.results
    .map((p) => ({ name: p.name, label: p.label, type: p.type, custom: !p.hubspotDefined, readOnly: Boolean(p.modificationMetadata?.readOnlyValue) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Create the DealDocs writeback properties (group "dealdocs") on HubSpot deals and map them.
 * Existing properties are left untouched.
 */
export async function installWritebackProperties(ctx: OrgContext) {
  guard(ctx);
  const connection = await requireConnection(ctx.organizationId);
  const client = new HubSpotClient(connection.id);
  const existing = new Set((await client.getProperties("deals")).results.map((p) => p.name));
  try {
    await client.createPropertyGroup("deals", "dealdocs", "DealDocs");
  } catch (error) {
    if (!(error instanceof HubSpotApiError && error.httpStatus === 409)) throw error;
  }
  for (const source of WRITEBACK_SOURCES) {
    if (!existing.has(source.suggestedProperty)) {
      const def =
        source.type === "number"
          ? { type: "number", fieldType: "number" }
          : source.type === "datetime"
            ? { type: "datetime", fieldType: "date" }
            : { type: "string", fieldType: "text" };
      await client.createProperty("deals", { name: source.suggestedProperty, label: `DealDocs: ${source.label}`, groupName: "dealdocs", ...def });
    }
    await prisma.hubSpotPropertyMapping.upsert({
      where: {
        organizationId_direction_objectType_hubspotProperty_variableKey: {
          organizationId: ctx.organizationId,
          direction: "WRITEBACK",
          objectType: "DEAL",
          hubspotProperty: source.suggestedProperty,
          variableKey: source.key,
        },
      },
      create: { organizationId: ctx.organizationId, direction: "WRITEBACK", objectType: "DEAL", hubspotProperty: source.suggestedProperty, variableKey: source.key, label: source.label },
      update: { enabled: true },
    });
  }
  await audit({ organizationId: ctx.organizationId, userId: ctx.user.id, action: "PROPERTY_MAPPING_UPDATED", entityType: "HubSpotConnection", entityId: connection.id, metadata: { installedWritebackProperties: WRITEBACK_SOURCES.length } });
}
