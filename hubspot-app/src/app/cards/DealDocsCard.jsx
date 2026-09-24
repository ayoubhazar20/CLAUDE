import React from "react";
import { hubspot, Button, Flex, Text } from "@hubspot/ui-extensions";
import { DEALDOCS_URL } from "../config";

/**
 * DealDocs card on the HubSpot Deal record.
 *
 * It only passes the Deal record ID to DealDocs — no HubSpot API calls, no tokens.
 * DealDocs authenticates the user itself (and returns them here after login), reads
 * the deal's documents from its own database, and receives CRM data through Zapier.
 * The deal's quotes and contracts also appear as associated DealDocs custom object records.
 */
hubspot.extend(({ context }) => <DealDocsCard context={context} />);

function DealDocsCard({ context }) {
  const dealId = encodeURIComponent(String(context.crm.objectId));
  const link = (path) => ({ url: `${DEALDOCS_URL}${path}`, external: true });
  return (
    <Flex direction="column" gap="sm">
      <Button variant="primary" href={link(`/documents/new?type=quote&dealId=${dealId}`)}>+ Create Quote</Button>
      <Button variant="primary" href={link(`/documents/new?type=contract&dealId=${dealId}`)}>+ Create Contract</Button>
      <Button variant="secondary" href={link(`/deals/${dealId}/documents`)}>View Documents</Button>
      <Text variant="microcopy">Quotes and contracts for this deal are listed in the DealDocs Documents section of this record.</Text>
    </Flex>
  );
}
