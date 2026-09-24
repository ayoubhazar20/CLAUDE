import { zapierRoute } from "@/server/integrations/route";
import { linkHubSpotRecord } from "@/server/integrations/inbound";

/** Zapier → DealDocs: the HubSpot custom object record created/found for a document. */
export const POST = zapierRoute("HUBSPOT_DOCUMENT_LINKED", (integration, body, meta) => linkHubSpotRecord(integration, body, meta));
