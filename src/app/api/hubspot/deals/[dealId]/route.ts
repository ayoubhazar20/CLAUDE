import { apiHandler } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { HubSpotClient, requireConnection } from "@/server/hubspot/client";
import { listDealContacts } from "@/server/hubspot/import";
import { ValidationError } from "@/server/errors";
import { PERMISSIONS } from "@/domain/permissions";

export const GET = apiHandler("hubspot.deal", async (_req: Request, { params }: { params: Promise<{ dealId: string }> }) => {
  const ctx = await requireOrgApi(PERMISSIONS.DOCUMENTS_CREATE);
  const { dealId } = await params;
  if (!/^\d{1,30}$/.test(dealId)) throw new ValidationError("Invalid deal id");
  const connection = await requireConnection(ctx.organizationId);
  const deal = await new HubSpotClient(connection.id).getObject("deals", dealId, ["dealname", "amount", "deal_currency_code"]);
  return {
    deal: { id: deal.id, name: deal.properties.dealname ?? `Deal ${deal.id}`, amount: deal.properties.amount ?? "", currency: deal.properties.deal_currency_code ?? "" },
    contacts: await listDealContacts(ctx, dealId),
  };
});
