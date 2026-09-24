import { apiHandler } from "@/server/api";
import { requireOrgApi } from "@/server/auth/context";
import { searchProducts } from "@/server/hubspot/import";
import { enforceRateLimit } from "@/server/security/rate-limit";

export const GET = apiHandler("hubspot.products", async (req: Request) => {
  const ctx = await requireOrgApi();
  await enforceRateLimit(`hs-products:${ctx.user.id}`, 60, 60);
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return { products: await searchProducts(ctx, q) };
});
