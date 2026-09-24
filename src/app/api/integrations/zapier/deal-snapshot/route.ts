import { zapierRoute } from "@/server/integrations/route";
import { receiveDealSnapshot } from "@/server/integrations/inbound";

/** Zapier → DealDocs: HubSpot deal / contact / company / line items snapshot for a document. */
export const POST = zapierRoute("DEAL_SNAPSHOT", (integration, body, meta) => receiveDealSnapshot(integration, body, meta));
