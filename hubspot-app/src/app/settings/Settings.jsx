import React, { useEffect, useState } from "react";
import { hubspot, Alert, DescriptionList, DescriptionListItem, Flex, Link, LoadingSpinner, Text } from "@hubspot/ui-extensions";
import { DEALDOCS_URL } from "../config";

/**
 * App settings page inside HubSpot: connection status and shortcuts.
 * DealDocs remains the authoritative interface for advanced configuration.
 */
hubspot.extend(({ context }) => <Settings context={context} />);

function Settings({ context }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    hubspot
      .fetch(`${DEALDOCS_URL}/api/hubspot/app-settings?portalId=${encodeURIComponent(String(context.portal.id))}`, { method: "GET" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`DealDocs responded with ${res.status}`);
        setState({ loading: false, data: await res.json() });
      })
      .catch((error) => setState({ loading: false, error: error.message }));
  }, [context.portal.id]);

  if (state.loading) return <LoadingSpinner label="Loading…" />;
  if (state.error) return <Alert title="DealDocs is unavailable" variant="error">{state.error}</Alert>;
  const d = state.data;
  if (!d.connected) {
    return (
      <Alert title="Not connected" variant="warning">
        Connect this HubSpot account from DealDocs: <Link href={{ url: d.connectUrl, external: true }}>open DealDocs</Link>
      </Alert>
    );
  }
  return (
    <Flex direction="column" gap="md">
      {d.status === "ERROR" ? <Alert title="Reconnection required" variant="error">{d.lastError}</Alert> : null}
      <DescriptionList direction="row">
        <DescriptionListItem label="Organization"><Text>{d.organization}</Text></DescriptionListItem>
        <DescriptionListItem label="Connection"><Text>{d.status}</Text></DescriptionListItem>
        <DescriptionListItem label="Writeback"><Text>{d.writebackEnabled ? `On (${d.writebackMappings} properties)` : "Off"}</Text></DescriptionListItem>
        <DescriptionListItem label="Pipeline automation"><Text>{d.pipelineAutomationEnabled ? `On (${d.pipelineRules} rules)` : "Off"}</Text></DescriptionListItem>
        <DescriptionListItem label="Custom property mappings"><Text>{String(d.importMappings)}</Text></DescriptionListItem>
      </DescriptionList>
      <Text>
        Manage in DealDocs: <Link href={{ url: d.links.connection, external: true }}>Connection</Link> · <Link href={{ url: d.links.mapping, external: true }}>Property mapping</Link> ·{" "}
        <Link href={{ url: d.links.pipeline, external: true }}>Pipeline automation</Link> · <Link href={{ url: d.links.templates, external: true }}>Templates</Link>
      </Text>
    </Flex>
  );
}
