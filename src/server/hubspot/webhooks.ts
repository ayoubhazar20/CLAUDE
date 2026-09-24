import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { enqueue } from "../jobs/queue";

/**
 * HubSpot webhooks: validated by the route (signature v3), persisted
 * idempotently (unique portalId+eventId), acknowledged immediately and
 * processed asynchronously.
 */
export interface HubSpotWebhookEventPayload {
  eventId: number | string;
  subscriptionId?: number;
  portalId: number | string;
  appId?: number;
  occurredAt?: number;
  subscriptionType: string;
  attemptNumber?: number;
  objectId?: number | string;
  propertyName?: string;
  propertyValue?: string;
  changeSource?: string;
  /** New developer platform: generic object events carry the object type id (deal = 0-3). */
  objectTypeId?: string;
}

/** Normalise new-platform "object.*" events for deals to the classic "deal.*" names. */
export function normalizeSubscriptionType(e: Pick<HubSpotWebhookEventPayload, "subscriptionType" | "objectTypeId">): string {
  if (e.subscriptionType.startsWith("object.") && e.objectTypeId === "0-3") return `deal.${e.subscriptionType.slice("object.".length)}`;
  return e.subscriptionType;
}

export async function ingestWebhookEvents(events: HubSpotWebhookEventPayload[]): Promise<{ received: number; duplicates: number }> {
  let received = 0;
  let duplicates = 0;
  for (const e of events.slice(0, 1000)) {
    if (e.eventId === undefined || e.portalId === undefined || !e.subscriptionType) continue;
    const portalId = String(e.portalId);
    const connection = await prisma.hubSpotConnection.findFirst({ where: { portalId, status: { in: ["CONNECTED", "ERROR"] } }, select: { organizationId: true } });
    const created = await prisma.hubSpotWebhookEvent.createMany({
      data: [
        {
          portalId,
          eventId: String(e.eventId),
          organizationId: connection?.organizationId ?? null,
          subscriptionType: normalizeSubscriptionType(e).slice(0, 100),
          objectId: e.objectId !== undefined ? String(e.objectId) : null,
          propertyName: e.propertyName?.slice(0, 200) ?? null,
          propertyValue: e.propertyValue?.slice(0, 2000) ?? null,
          occurredAt: e.occurredAt ? new Date(e.occurredAt) : null,
          payload: e as unknown as Prisma.InputJsonValue,
          status: connection ? "RECEIVED" : "IGNORED",
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      duplicates += 1;
      continue;
    }
    received += 1;
    if (connection) {
      const row = await prisma.hubSpotWebhookEvent.findUnique({ where: { portalId_eventId: { portalId, eventId: String(e.eventId) } } });
      if (row) await enqueue("hubspot.processWebhook", { webhookEventId: row.id }, { organizationId: connection.organizationId, dedupeKey: `webhook:${row.id}` });
    }
  }
  return { received, duplicates };
}

/** Job handler. Idempotent: re-processing an already processed event is a no-op. */
export async function processWebhookEvent(payload: { webhookEventId: string }) {
  const event = await prisma.hubSpotWebhookEvent.findUnique({ where: { id: payload.webhookEventId } });
  if (!event || event.status === "PROCESSED" || event.status === "IGNORED" || !event.organizationId) return;
  try {
    await prisma.hubSpotWebhookEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 } } });
    const organizationId = event.organizationId;
    switch (event.subscriptionType) {
      case "deal.propertyChange":
        if (event.propertyName === "dealname" && event.objectId) {
          await prisma.document.updateMany({
            where: { organizationId, hubspotDealId: event.objectId },
            data: { hubspotDealName: event.propertyValue ?? null },
          });
        }
        break;
      case "deal.deletion":
        if (event.objectId) {
          const docs = await prisma.document.findMany({ where: { organizationId, hubspotDealId: event.objectId }, select: { id: true } });
          for (const d of docs) {
            await prisma.documentEvent.create({
              data: { organizationId, documentId: d.id, type: "HUBSPOT_DEAL_DELETED", actorType: "SYSTEM", metadata: { dealId: event.objectId } },
            });
          }
        }
        break;
      default:
        break;
    }
    await prisma.hubSpotWebhookEvent.update({ where: { id: event.id }, data: { status: "PROCESSED", processedAt: new Date(), error: null } });
  } catch (error) {
    await prisma.hubSpotWebhookEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) },
    });
    throw error;
  }
}
