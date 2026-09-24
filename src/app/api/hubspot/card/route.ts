import { NextResponse } from "next/server";
import { prisma } from "@/server/db";
import { appUrl, env } from "@/server/env";
import { logError } from "@/server/errors";
import { verifySignatureV3 } from "@/server/hubspot/signature";
import { STATUS_LABELS } from "@/domain/status";
import { formatMoney } from "@/domain/money";

/**
 * Data endpoint for the HubSpot Deal App Card (UI extension, via hubspot.fetch).
 * Authenticated by HubSpot's v3 request signature; the portal id selects the
 * DealDocs organization. Returns only lightweight summaries (no tokens, no content).
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
  const dealId = url.searchParams.get("dealId") ?? "";
  if (!/^\d{1,20}$/.test(portalId) || !/^\d{1,30}$/.test(dealId)) return NextResponse.json({ error: "invalid parameters" }, { status: 400 });

  try {
    const connection = await prisma.hubSpotConnection.findFirst({ where: { portalId, status: { in: ["CONNECTED", "ERROR"] } }, include: { organization: true } });
    if (!connection || connection.organization.status !== "ACTIVE") {
      return NextResponse.json({ connected: false, connectUrl: appUrl("/settings/integrations/hubspot") });
    }
    const docs = await prisma.document.findMany({
      where: { organizationId: connection.organizationId, hubspotDealId: dealId, archivedAt: null },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
      take: 10,
    });
    const total = await prisma.document.count({ where: { organizationId: connection.organizationId, hubspotDealId: dealId, archivedAt: null } });
    return NextResponse.json({
      connected: true,
      organization: connection.organization.name,
      createQuoteUrl: appUrl(`/documents/new?type=QUOTE&dealId=${dealId}&portalId=${portalId}`),
      createContractUrl: appUrl(`/documents/new?type=CONTRACT&dealId=${dealId}&portalId=${portalId}`),
      viewAllUrl: appUrl(`/documents?dealId=${dealId}`),
      total,
      documents: docs.map((d) => ({
        id: d.id,
        type: d.type,
        number: d.number,
        status: STATUS_LABELS[d.status],
        amount: formatMoney(d.grandTotal.toString(), d.currency),
        isPrimary: d.isPrimary,
        viewUrl: appUrl(`/documents/${d.id}`),
        editUrl: appUrl(`/documents/${d.id}/edit`),
      })),
    });
  } catch (error) {
    const traceId = await logError(error, { source: "hubspot.card" });
    return NextResponse.json({ error: "internal error", traceId }, { status: 500 });
  }
}
