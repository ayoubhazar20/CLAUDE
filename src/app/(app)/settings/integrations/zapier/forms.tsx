"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, FormResult, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { Alert, Button } from "@/components/ui";
import { rotateSecretAction, saveIntegrationAction, testEventAction } from "@/app/actions/integrations";

export function IntegrationForm(props: {
  defaults: { enabled: boolean; hubspotObjectTypeId: string; webhookUrl: string; dealPropertyNames: string; statusMapping: string; propertyVariableMap: string };
  objectTypeFallback: string | null;
  dealPropertyKeys: string[];
  statusKeys: string[];
  allowedHosts: string;
}) {
  const d = props.defaults;
  return (
    <ActionForm action={saveIntegrationAction} className="space-y-4">
      {(state) => (
        <>
          <FormResult state={state} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={d.enabled} /> Integration enabled</label>
          <TextField label="HubSpot custom object type ID" name="hubspotObjectTypeId" defaultValue={d.hubspotObjectTypeId} state={state} placeholder={props.objectTypeFallback ?? "2-12345678"} hint={props.objectTypeFallback ? `(default: ${props.objectTypeFallback})` : "(e.g. 2-12345678)"} />
          <TextField label="Zapier webhook URL" name="webhookUrl" defaultValue={d.webhookUrl} state={state} placeholder="https://hooks.zapier.com/hooks/catch/…" hint={`(allowed hosts: ${props.allowedHosts})`} />
          <details className="rounded-md border border-slate-200 p-3" open={Boolean(d.dealPropertyNames || d.statusMapping || d.propertyVariableMap)}>
            <summary className="cursor-pointer text-sm font-medium">Optional mappings</summary>
            <div className="mt-3 space-y-4">
              <TextAreaField label="Deal property names" name="dealPropertyNames" defaultValue={d.dealPropertyNames} rows={4} state={state} hint={`(one "key = hubspot_property" per line; keys: ${props.dealPropertyKeys.join(", ")})`} />
              <TextAreaField label="Status mapping" name="statusMapping" defaultValue={d.statusMapping} rows={4} state={state} hint={`(one "STATUS = value" per line; statuses: ${props.statusKeys.join(", ")})`} />
              <TextAreaField label="HubSpot custom properties → variables" name="propertyVariableMap" defaultValue={d.propertyVariableMap} rows={4} state={state} hint='(e.g. "project_start_date = project.startDate"; unmapped properties become {{hubspot.property_name}})' />
            </div>
          </details>
          <SubmitButton>Save settings</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function SecretPanel({ prefix, rotatedAt }: { prefix: string | null; rotatedAt: string | null }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        Zapier authenticates to DealDocs with this secret (<code>Authorization: Bearer …</code>) and DealDocs signs outbound events with it.
        It is shown only once — store it in Zapier. Never paste it in a browser or share it.
      </p>
      <p>Current secret: {prefix ? <code>{prefix}…</code> : <span className="text-slate-500">none</span>}{rotatedAt ? <span className="text-slate-500"> · created {rotatedAt}</span> : null}</p>
      {secret ? (
        <Alert tone="warning" title="Copy this secret now">
          <code className="block break-all rounded bg-white p-2 font-mono text-xs">{secret}</code>
          <span className="mt-1 block">It will not be shown again. The previous secret no longer works.</span>
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button
        variant={prefix ? "secondary" : "primary"}
        disabled={busy}
        onClick={async () => {
          if (prefix && !window.confirm("Rotate the secret? Zapier will stop working until you update it with the new secret.")) return;
          setBusy(true);
          const res = await rotateSecretAction();
          setBusy(false);
          if (res?.ok && res.data) {
            setSecret(res.data.secret);
            setError(null);
            router.refresh();
          } else if (res && !res.ok) setError(res.error);
        }}
      >
        {prefix ? "Rotate secret" : "Generate secret"}
      </Button>
    </div>
  );
}

export function TestEventButton() {
  const [state, action] = useActionState(testEventAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton variant="secondary" pendingLabel="Sending…">Send test event</SubmitButton>
      {state ? <span className={state.ok ? "text-sm text-emerald-700" : "text-sm text-red-600"}>{state.ok ? state.message : state.error}</span> : null}
    </form>
  );
}
