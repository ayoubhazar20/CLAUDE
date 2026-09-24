import { NextResponse } from "next/server";
import { env, appUrl } from "@/server/env";
import { logError } from "@/server/errors";
import { verifySignatureV3 } from "@/server/hubspot/signature";
import { ingestWebhookEvents, type HubSpotWebhookEventPayload } from "@/server/hubspot/webhooks";

/**
 * HubSpot webhook receiver: validates the v3 signature, stores events
 * idempotently and returns immediately; processing happens in the job queue.
 */
export async function POST(req: Request) {
  const body = await req.text();
  if (body.length > 5_000_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  const publicUrl = appUrl(new URL(req.url).pathname + new URL(req.url).search);
  const valid = verifySignatureV3({
    secret: env().HUBSPOT_CLIENT_SECRET,
    method: "POST",
    uri: publicUrl,
    body,
    signature: req.headers.get("x-hubspot-signature-v3"),
    timestamp: req.headers.get("x-hubspot-request-timestamp"),
  });
  if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  try {
    const events = JSON.parse(body) as HubSpotWebhookEventPayload[];
    if (!Array.isArray(events)) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
    const result = await ingestWebhookEvents(events);
    return NextResponse.json(result);
  } catch (error) {
    await logError(error, { source: "hubspot.webhooks" });
    // 500 lets HubSpot retry; ingestion is idempotent.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
