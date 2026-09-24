import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { appUrl, env } from "@/server/env";
import { logError } from "@/server/errors";
import { verifySignatureV3 } from "@/server/hubspot/signature";

/**
 * Data for the settings page shown inside HubSpot (app settings extension).
 * Signed by HubSpot; returns a status summary and deep links into DealDocs,
 * which remains the authoritative interface for advanced configuration.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const valid = verifySignatureV3({
    secret: env().HUBSPOT_CLIENT_SECRET,
    method: "GET",
    uri: appUrl(url.pathname + url.search),
    body: "",
    signature: req.headers.get("x-hubspot-signature-v3"),
    timestamp: req.headers.get("x-hubspot-request-timestamp"),
  });
  if (!valid) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  const portalId = url.searchParams.get("portalId") ?? "";
  if (!/^\d{1,20}$/.test(portalId)) return NextResponse.json({ error: "invalid parameters" }, { status: 400 });
  try {
    const connection = await prisma.hubSpotConnection.findFirst({ where: { portalId, status: { in: ["CONNECTED", "ERROR"] } }, include: { organization: true } });
    if (!connection) return NextResponse.json({ connected: false, connectUrl: appUrl("/settings/integrations/hubspot") });
    const [importMappings, writebackMappings, pipelineRules] = await Promise.all([
      prisma.hubSpotPropertyMapping.count({ where: { organizationId: connection.organizationId, direction: "IMPORT" } }),
      prisma.hubSpotPropertyMapping.count({ where: { organizationId: connection.organizationId, direction: "WRITEBACK" } }),
      prisma.hubSpotPipelineMapping.count({ where: { organizationId: connection.organizationId, enabled: true } }),
    ]);
    const settings = (connection.settings ?? {}) as { writebackEnabled?: boolean; pipelineAutomationEnabled?: boolean };
    return NextResponse.json({
      connected: true,
      status: connection.status,
      organization: connection.organization.name,
      organizationStatus: connection.organization.status,
      lastError: connection.lastError,
      writebackEnabled: settings.writebackEnabled !== false,
      pipelineAutomationEnabled: settings.pipelineAutomationEnabled !== false,
      importMappings,
      writebackMappings,
      pipelineRules,
      links: {
        connection: appUrl("/settings/integrations/hubspot"),
        mapping: appUrl("/settings/integrations/hubspot/mapping"),
        pipeline: appUrl("/settings/integrations/hubspot/pipeline"),
        templates: appUrl("/templates"),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: "internal error", traceId: await logError(error, { source: "hubspot.appSettings" }) }, { status: 500 });
  }
}
