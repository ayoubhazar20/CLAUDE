import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { hubspotConfigured, redirectUri } from "@/server/hubspot/oauth";
import { appUrl } from "@/server/env";
import { Alert, Badge, ButtonLink, Card, DescriptionList, PageHeader } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { dateTimeLabel } from "@/lib/format";
import { PERMISSIONS } from "@/domain/permissions";
import { hubspotAction } from "@/app/actions/settings";
import { SyncSettingsForm } from "./sync-form";

export const metadata = { title: "HubSpot" };

export default async function HubSpotSettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const ctx = await requireOrgPage(PERMISSIONS.HUBSPOT_MANAGE);
  const sp = await searchParams;
  const connections = await prisma.hubSpotConnection.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { installedAt: "desc" } });
  const active = connections.find((c) => c.status !== "DISCONNECTED");
  const installer = active?.installedById ? await prisma.user.findUnique({ where: { id: active.installedById }, select: { name: true } }) : null;
  const settings = (active?.settings ?? {}) as { writebackEnabled?: boolean; pipelineAutomationEnabled?: boolean; defaultDocumentType?: string };
  const tz = ctx.organization.timezone;
  return (
    <>
      <PageHeader title="HubSpot" description="Connect your HubSpot portal to create documents from deals and keep deals in sync." />
      <div className="space-y-5">
        {sp.error ? <Alert tone="error" title="HubSpot connection failed">{sp.error}</Alert> : null}
        {sp.connected ? <Alert tone="success">HubSpot connected successfully.</Alert> : null}
        {!hubspotConfigured() ? <Alert tone="warning" title="HubSpot app not configured">The server administrator must set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET.</Alert> : null}
        <Card
          title="Connection"
          actions={
            active ? (
              <div className="flex gap-2">
                <ButtonLink variant="secondary" size="sm" href="/api/integrations/hubspot/install" prefetch={false}>Reconnect</ButtonLink>
                <InlineAction action={hubspotAction} hidden={{ op: "disconnect", connectionId: active.id }} variant="danger" confirm="Disconnect HubSpot? Documents stay intact, but synchronization stops until you reconnect.">Disconnect</InlineAction>
              </div>
            ) : null
          }
        >
          {active ? (
            <>
              {active.status === "ERROR" ? <div className="mb-4"><Alert tone="error" title="Action required">{active.lastError ?? "The connection must be re-authorized."}</Alert></div> : null}
              <DescriptionList
                items={[
                  { label: "Status", value: <Badge tone={active.status === "CONNECTED" ? "green" : "red"}>{active.status.toLowerCase()}</Badge> },
                  { label: "HubSpot account", value: `${active.hubDomain ?? "—"} (portal ${active.portalId})` },
                  { label: "Installed by", value: installer?.name ?? "—" },
                  { label: "Installed", value: dateTimeLabel(active.installedAt, tz) },
                  { label: "Scopes", value: <span className="text-xs">{active.scopes.join(", ")}</span> },
                  { label: "Last error", value: active.lastError ? `${active.lastError} (${dateTimeLabel(active.lastErrorAt, tz)})` : "None" },
                ]}
              />
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">Not connected. You will be redirected to HubSpot to choose the account and approve access.</p>
              <ButtonLink href="/api/integrations/hubspot/install" prefetch={false}>Connect HubSpot</ButtonLink>
            </div>
          )}
        </Card>
        {active ? (
          <Card title="Synchronization">
            <SyncSettingsForm writebackEnabled={settings.writebackEnabled !== false} pipelineAutomationEnabled={settings.pipelineAutomationEnabled !== false} />
          </Card>
        ) : null}
        <Card title="HubSpot app configuration">
          <p className="mb-2 text-sm text-slate-600">Values for the HubSpot developer app (for platform operators):</p>
          <DescriptionList
            items={[
              { label: "OAuth redirect URL", value: <code className="break-all text-xs">{redirectUri()}</code> },
              { label: "Webhook target URL", value: <code className="break-all text-xs">{appUrl("/api/integrations/hubspot/webhooks")}</code> },
              { label: "App card data URL", value: <code className="break-all text-xs">{appUrl("/api/hubspot/card")}</code> },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
