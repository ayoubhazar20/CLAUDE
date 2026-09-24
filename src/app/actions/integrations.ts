"use server";

import { z } from "zod";
import { formBool, formString, runAction } from "@/server/actions";
import { requireOrgApi } from "@/server/auth/context";
import { rotateIntegrationSecret, saveIntegrationSettings } from "@/server/integrations/config";
import { requestDealData, retrySyncEvent, sendTestEvent } from "@/server/integrations/outbound";
import { resolveSnapshot, type SnapshotSection } from "@/server/integrations/snapshot";
import type { ActionState } from "@/lib/action-state";

/** Parse "key = value" lines into a map (used for optional property/status mappings). */
function parseMapping(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (m && m[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

export async function saveIntegrationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("saveIntegration", async () => {
    const ctx = await requireOrgApi();
    await saveIntegrationSettings(ctx, {
      enabled: formBool(form, "enabled"),
      hubspotObjectTypeId: formString(form, "hubspotObjectTypeId"),
      webhookUrl: formString(form, "webhookUrl"),
      dealPropertyNames: parseMapping(formString(form, "dealPropertyNames")),
      statusMapping: parseMapping(formString(form, "statusMapping")),
      propertyVariableMap: parseMapping(formString(form, "propertyVariableMap")),
    });
    return { ok: true, message: "Integration settings saved." };
  });
}

export async function rotateSecretAction(): Promise<ActionState<{ secret: string }>> {
  return runAction("rotateSecret", async () => {
    const ctx = await requireOrgApi();
    return { ok: true, data: { secret: await rotateIntegrationSecret(ctx) } };
  });
}

export async function testEventAction(_prev: ActionState): Promise<ActionState> {
  return runAction("testEvent", async () => {
    const ctx = await requireOrgApi();
    await sendTestEvent(ctx);
    return { ok: true, message: "Test event queued — check the synchronization log in a few seconds." };
  });
}

export async function retrySyncAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("retrySync", async () => {
    const ctx = await requireOrgApi();
    await retrySyncEvent(ctx, z.string().uuid().parse(formString(form, "syncEventId")));
    return { ok: true, message: "Retry scheduled." };
  });
}

export async function refreshHubSpotDataAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("refreshHubSpotData", async () => {
    const ctx = await requireOrgApi();
    await requestDealData(ctx, z.string().uuid().parse(formString(form, "documentId")), "refresh");
    return { ok: true, message: "Refresh requested from HubSpot via Zapier. New data will appear here for review." };
  });
}

const SECTIONS: SnapshotSection[] = ["contact", "company", "deal", "customProperties", "recipient"];

export async function resolveSnapshotAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("resolveSnapshot", async () => {
    const ctx = await requireOrgApi();
    const documentId = z.string().uuid().parse(formString(form, "documentId"));
    const snapshotId = z.string().uuid().parse(formString(form, "snapshotId"));
    if (formString(form, "decision") === "dismiss") {
      await resolveSnapshot(ctx, documentId, snapshotId, "dismiss");
      return { ok: true, message: "HubSpot data dismissed — the document was not changed." };
    }
    const sections = form.getAll("sections").map(String).filter((s): s is SnapshotSection => SECTIONS.includes(s as SnapshotSection));
    const lineItems = z.enum(["keep", "replace", "append"]).parse(formString(form, "lineItems") || "keep");
    if (!sections.length && lineItems === "keep") return { ok: false, error: "Select what to update, or dismiss." };
    await resolveSnapshot(ctx, documentId, snapshotId, { sections, lineItems });
    return { ok: true, message: "Selected HubSpot data applied to the draft." };
  });
}
