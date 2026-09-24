import type { AutomationEvent } from "@prisma/client";
import { prisma } from "../db";
import { appUrl } from "../env";
import { enqueue } from "../jobs/queue";
import { HubSpotClient, primaryConnection } from "./client";
import { buildWritebackProperties, computeWritebackValues } from "./mapping";

/**
 * HubSpot writeback + pipeline automation. Runs asynchronously (job queue) so a
 * slow or failing HubSpot never blocks the user or the client.
 */

export async function scheduleHubSpotSync(documentId: string, organizationId: string, event: AutomationEvent | null) {
  await enqueue("hubspot.syncDocument", { documentId, event }, { organizationId, maxAttempts: 6 });
}

export function publicDocumentUrl(token: string): string {
  return appUrl(`/d/${token}`);
}

export async function syncDocumentToHubSpot(payload: { documentId: string; event: AutomationEvent | null }) {
  const document = await prisma.document.findUnique({ where: { id: payload.documentId } });
  if (!document?.hubspotDealId) return;
  const connection = document.hubspotConnectionId
    ? await prisma.hubSpotConnection.findFirst({ where: { id: document.hubspotConnectionId, organizationId: document.organizationId, status: "CONNECTED" } })
    : await primaryConnection(document.organizationId);
  if (!connection || connection.status !== "CONNECTED") {
    await prisma.documentEvent.create({
      data: {
        organizationId: document.organizationId,
        documentId: document.id,
        type: "HUBSPOT_SYNC_SKIPPED",
        actorType: "SYSTEM",
        metadata: { reason: "HubSpot not connected", event: payload.event },
      },
    });
    return;
  }
  const settings = (connection.settings ?? {}) as { writebackEnabled?: boolean; pipelineAutomationEnabled?: boolean };
  const client = new HubSpotClient(connection.id);
  const properties: Record<string, string> = {};

  if (settings.writebackEnabled !== false) {
    const mappings = await prisma.hubSpotPropertyMapping.findMany({ where: { organizationId: document.organizationId, direction: "WRITEBACK", enabled: true } });
    if (mappings.length) {
      const docs = await prisma.document.findMany({
        where: { organizationId: document.organizationId, hubspotDealId: document.hubspotDealId },
        include: { owner: { select: { name: true } } },
      });
      const values = computeWritebackValues(
        docs.map((d) => ({ ...d, ownerName: d.owner.name })),
        publicDocumentUrl,
      );
      Object.assign(properties, buildWritebackProperties(values, mappings));
    }
  }

  let stageChange: { pipelineId: string; stageId: string } | null = null;
  if (payload.event && settings.pipelineAutomationEnabled !== false) {
    const mappings = await prisma.hubSpotPipelineMapping.findMany({
      where: { organizationId: document.organizationId, event: payload.event, enabled: true },
    });
    if (mappings.length) {
      // Only move the deal within its own pipeline — never jump it to another pipeline silently.
      const deal = await client.getObject("deals", document.hubspotDealId, ["pipeline", "dealstage"]);
      const mapping = mappings.find((m) => m.pipelineId === deal.properties.pipeline);
      if (mapping && deal.properties.dealstage !== mapping.stageId) {
        properties.dealstage = mapping.stageId;
        stageChange = { pipelineId: mapping.pipelineId, stageId: mapping.stageId };
      }
    }
  }

  if (!Object.keys(properties).length) return;
  await client.updateObject("deals", document.hubspotDealId, properties);
  await prisma.documentEvent.create({
    data: {
      organizationId: document.organizationId,
      documentId: document.id,
      type: "HUBSPOT_SYNCED",
      actorType: "SYSTEM",
      metadata: { event: payload.event, properties: Object.keys(properties), stageChange },
    },
  });
}
