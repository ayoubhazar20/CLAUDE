import React, { useCallback, useEffect, useState } from "react";
import { hubspot, Alert, Button, ButtonRow, Divider, Flex, Link, LoadingSpinner, Tag, Text } from "@hubspot/ui-extensions";
import { DEALDOCS_URL } from "../config";

/**
 * DealDocs Deal sidebar card. Deliberately lightweight: it lists the deal's
 * documents and opens the full DealDocs app (with the deal preloaded) to create
 * or edit documents. Requests are signed by HubSpot (hubspot.fetch) and verified
 * by DealDocs; no tokens are handled here.
 */
hubspot.extend(({ context }) => <DealDocsCard context={context} />);

const STATUS_VARIANT = {
  Draft: "default",
  Published: "info",
  Sent: "info",
  Viewed: "info",
  "Awaiting Signature": "warning",
  Accepted: "success",
  Signed: "success",
  Rejected: "error",
  Expired: "default",
  Cancelled: "default",
};

function DealDocsCard({ context }) {
  const dealId = String(context.crm.objectId);
  const portalId = String(context.portal.id);
  const [state, setState] = useState({ loading: true });
  const [choosing, setChoosing] = useState(false);

  const load = useCallback(async () => {
    setState({ loading: true });
    try {
      const res = await hubspot.fetch(`${DEALDOCS_URL}/api/hubspot/card?portalId=${encodeURIComponent(portalId)}&dealId=${encodeURIComponent(dealId)}`, { method: "GET" });
      if (!res.ok) throw new Error(`DealDocs responded with ${res.status}`);
      setState({ loading: false, data: await res.json() });
    } catch (error) {
      setState({ loading: false, error: error.message || "DealDocs is unreachable" });
    }
  }, [dealId, portalId]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.loading) return <LoadingSpinner label="Loading DealDocs…" />;
  if (state.error) {
    return (
      <Alert title="DealDocs is unavailable" variant="error">
        {state.error}. <Link onClick={load}>Retry</Link>
      </Alert>
    );
  }
  const data = state.data;
  if (!data.connected) {
    return (
      <Alert title="Connect DealDocs" variant="warning">
        This HubSpot account is not connected to an active DealDocs organization. <Link href={data.connectUrl}>Open DealDocs</Link>
      </Alert>
    );
  }

  return (
    <Flex direction="column" gap="sm">
      {choosing ? (
        <>
          <Text format={{ fontWeight: "bold" }}>Create new</Text>
          <ButtonRow>
            <Button variant="primary" href={{ url: data.createQuoteUrl, external: true }}>Quote</Button>
            <Button variant="primary" href={{ url: data.createContractUrl, external: true }}>Contract</Button>
            <Button variant="secondary" onClick={() => setChoosing(false)}>Cancel</Button>
          </ButtonRow>
        </>
      ) : (
        <Button variant="primary" onClick={() => setChoosing(true)}>+ Create Document</Button>
      )}
      <Divider />
      {data.documents.length === 0 ? (
        <Text>No quotes or contracts for this deal yet.</Text>
      ) : (
        data.documents.map((doc) => (
          <Flex key={doc.id} direction="column" gap="flush">
            <Flex direction="row" justify="between" align="center">
              <Text format={{ fontWeight: "bold" }}>
                {doc.type === "QUOTE" ? "Quote" : "Contract"} {doc.number}
              </Text>
              {doc.isPrimary ? <Tag variant="info">Primary</Tag> : null}
            </Flex>
            <Flex direction="row" gap="xs" align="center">
              <Tag variant={STATUS_VARIANT[doc.status] || "default"}>{doc.status}</Tag>
              <Text>{doc.amount}</Text>
            </Flex>
            <Text>
              <Link href={{ url: doc.viewUrl, external: true }}>View</Link> | <Link href={{ url: doc.editUrl, external: true }}>Edit</Link>
            </Text>
            <Divider />
          </Flex>
        ))
      )}
      <Link href={{ url: data.viewAllUrl, external: true }}>View All Documents{data.total > data.documents.length ? ` (${data.total})` : ""}</Link>
    </Flex>
  );
}
