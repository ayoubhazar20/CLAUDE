import { apiHandler } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { searchDeals } from "@/server/hubspot/import";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { PERMISSIONS } from "@/domain/permissions";

export const GET = apiHandler("hubspot.deals", async (req: Request) => {
  const ctx = await requireOrgApi(PERMISSIONS.DOCUMENTS_CREATE);
  await enforceRateLimit(`hs-search:${ctx.user.id}`, 60, 60);
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return { deals: await searchDeals(ctx, q) };
});
