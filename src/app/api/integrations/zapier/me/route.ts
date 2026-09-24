import { prisma } from "@/server/db";
import { zapierRoute } from "@/server/integrations/route";
import { objectTypeIdFor } from "@/server/integrations/config";

/** Connection test for Zapier ("Test authentication"). */
export const GET = zapierRoute("AUTH_TEST", async (integration) => {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: integration.organizationId }, select: { name: true } });
  return { ok: true, organization: org.name, hubspot_object_type_id: objectTypeIdFor(integration) };
});
