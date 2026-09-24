import { requireOrgPage } from "@/server/auth/context";
import { getIntegration, isConfigured, objectTypeIdFor } from "@/server/integrations/config";
import { DEAL_PROPERTY_KEYS, DEFAULT_STATUS_LABELS } from "@/server/integrations/deal-properties";
import { DOCUMENT_EVENTS } from "@/server/integrations/outbound";
import { appUrl, env } from "@/server/env";
import { Alert, Badge, ButtonLink, Card, DescriptionList, PageHeader } from "@/components/ui";
import { dateTimeLabel } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";
import { IntegrationForm, SecretPanel, TestEventButton } from "./forms";

export const metadata = { title: "HubSpot via Zapier" };

const toLines = (m: unknown) => Object.entries((m ?? {}) as Record<string, string>).map(([k, v]) => `${k} = ${v}`).join("\n");

export default async function ZapierSettingsPage() {
  const ctx = await requireOrgPage(PERMISSIONS.INTEGRATIONS_MANAGE);
  const integration = await getIntegration(ctx.organizationId);
  const configured = isConfigured(integration);
  const tz = ctx.organization.timezone;
  const status = !integration?.webhookUrl || !integration.secretHash ? "Not configured" : !integration.enabled ? "Disabled" : integration.lastErrorAt && (!integration.lastSuccessAt || integration.lastErrorAt > integration.lastSuccessAt) ? "Error" : "Active";
  const endpoints = [
    { label: "Test authentication (GET)", url: appUrl("/api/integrations/zapier/me") },
    { label: "HubSpot record linked (POST)", url: appUrl("/api/integrations/zapier/hubspot-document-linked") },
    { label: "Deal snapshot (POST)", url: appUrl("/api/integrations/zapier/deal-snapshot") },
    { label: "HubSpot update (POST)", url: appUrl("/api/integrations/zapier/hubspot-update") },
    { label: "Document lookup (GET)", url: appUrl("/api/integrations/zapier/documents/{dealdocs_document_id}") },
  ];
  return (
    <>
      <PageHeader
        title="HubSpot via Zapier"
        description="DealDocs does not connect to HubSpot directly. Zapier mirrors each document to a HubSpot custom object record, and sends deal data back to DealDocs."
        actions={<ButtonLink variant="secondary" href="/settings/integrations/zapier/log">Synchronization log</ButtonLink>}
      />
      <div className="space-y-5">
        <Card title="Connection status">
          <DescriptionList
            items={[
              { label: "Status", value: <Badge tone={status === "Active" ? "green" : status === "Error" ? "red" : "gray"}>{status}</Badge> },
              { label: "HubSpot custom object type", value: objectTypeIdFor(integration) ?? "—" },
              { label: "Last successful sync", value: dateTimeLabel(integration?.lastSuccessAt, tz) },
              { label: "Last error", value: integration?.lastError ? `${integration.lastError} (${dateTimeLabel(integration.lastErrorAt, tz)})` : "None" },
            ]}
          />
          {configured ? <div className="mt-4"><TestEventButton /></div> : null}
        </Card>

        <Card title="Integration secret">
          <SecretPanel prefix={integration?.secretPrefix ?? null} rotatedAt={integration?.secretRotatedAt ? dateTimeLabel(integration.secretRotatedAt, tz) : null} />
        </Card>

        <Card title="Settings">
          <IntegrationForm
            defaults={{
              enabled: integration?.enabled ?? true,
              hubspotObjectTypeId: integration?.hubspotObjectTypeId ?? "",
              webhookUrl: integration?.webhookUrl ?? "",
              dealPropertyNames: toLines(integration?.dealPropertyNames),
              statusMapping: toLines(integration?.statusMapping),
              propertyVariableMap: toLines(integration?.propertyVariableMap),
            }}
            objectTypeFallback={env().HUBSPOT_DOCUMENT_OBJECT_TYPE_ID || null}
            dealPropertyKeys={[...DEAL_PROPERTY_KEYS]}
            statusKeys={Object.keys(DEFAULT_STATUS_LABELS)}
            allowedHosts={env().ZAPIER_ALLOWED_HOSTS}
          />
        </Card>

        <Card title="Zapier setup">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
            <li><strong>Outbound (DealDocs → HubSpot):</strong> create a Zap with <em>Webhooks by Zapier → Catch Hook</em> and paste its URL above. Events: {DOCUMENT_EVENTS.join(", ")}, DEAL_DATA_REQUESTED, DEAL_DATA_REFRESH_REQUESTED.</li>
            <li>For document events: <em>HubSpot → Find custom object record</em> by <code>dealdocs_document_id</code> (object type <code>{objectTypeIdFor(integration) ?? "your object type id"}</code>); if found update it, otherwise create it and associate it to deal <code>hubspot_deal_id</code>. Map the fields from <code>document.*</code>; optionally update the deal with <code>deal_properties.*</code>.</li>
            <li>After creating the record, POST <code>{"{"} dealdocs_document_id, hubspot_object_record_id {"}"}</code> to the “HubSpot record linked” endpoint.</li>
            <li>For DEAL_DATA_REQUESTED / DEAL_DATA_REFRESH_REQUESTED: read the deal, contact, company and line items from HubSpot and POST them (with <code>document_id</code>) to the “Deal snapshot” endpoint.</li>
            <li>Optionally, a Zap triggered in HubSpot can POST property changes to the “HubSpot update” endpoint. Pipeline stage changes stay in Zapier or HubSpot workflows (e.g. when <code>latest_contract_status = signed</code>).</li>
            <li>Every call to DealDocs must include the header <code>Authorization: Bearer &lt;integration secret&gt;</code>. Outbound requests carry <code>X-DealDocs-Signature</code> (HMAC-SHA256 of <code>timestamp.body</code>).</li>
          </ol>
          <div className="mt-4 space-y-1 text-sm">
            {endpoints.map((e) => (
              <p key={e.label}><span className="text-slate-500">{e.label}:</span> <code className="break-all text-xs">{e.url}</code></p>
            ))}
          </div>
          {!configured ? <div className="mt-4"><Alert tone="info">Until the webhook URL and secret are set, events are recorded in the synchronization log as not delivered and can be retried later.</Alert></div> : null}
        </Card>
      </div>
    </>
  );
}
