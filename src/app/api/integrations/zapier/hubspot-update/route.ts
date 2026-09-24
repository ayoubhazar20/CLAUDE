import { zapierRoute } from "@/server/integrations/route";
import { applyHubSpotUpdate } from "@/server/integrations/inbound";

/** Zapier → DealDocs: a property changed in HubSpot (metadata or data for review). */
export const POST = zapierRoute("HUBSPOT_UPDATE", (integration, body, meta) => applyHubSpotUpdate(integration, body, meta));
