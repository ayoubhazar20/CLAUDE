"use client";

import { useActionState, useEffect, useState } from "react";
import { createDocumentAction } from "@/app/actions/documents";
import { SubmitButton } from "@/components/forms";
import { Alert, Input, Label, Select, cn } from "@/components/ui";
import { CURRENCY_CODES } from "@/domain/currencies";

interface TemplateOption {
  id: string;
  name: string;
  documentType: "QUOTE" | "CONTRACT";
  isDefault: boolean;
  description: string | null;
}

export function NewDocumentWizard(props: { templates: TemplateOption[]; initialType: "QUOTE" | "CONTRACT" | null; initialDealId: string | null; integrationReady: boolean; defaultCurrency: string }) {
  const [type, setType] = useState<"QUOTE" | "CONTRACT" | null>(props.initialType);
  const [dealId, setDealId] = useState(props.initialDealId ?? "");
  const [state, formAction] = useActionState(createDocumentAction, null);
  const templates = props.templates.filter((t) => t.documentType === type);
  const [templateId, setTemplateId] = useState("");
  useEffect(() => {
    setTemplateId((templates.find((t) => t.isDefault) ?? templates[0])?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);
  const dealValid = dealId === "" || /^\d{1,30}$/.test(dealId);
  const ready = Boolean(type && templateId && dealValid);

  return (
    <form action={formAction} className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="step-type">
          <h2 id="step-type" className="mb-3 font-semibold">1. Create new</h2>
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Document type">
            {(["QUOTE", "CONTRACT"] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)} className={cn("rounded-lg border-2 p-4 text-left transition", type === t ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:border-slate-300")}>
                <span className="block text-base font-semibold">{t === "QUOTE" ? "Quote" : "Contract"}</span>
                <span className="text-sm text-slate-600">{t === "QUOTE" ? "Pricing proposal with online acceptance" : "Agreement with electronic signatures"}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="step-deal">
          <h2 id="step-deal" className="mb-3 font-semibold">2. HubSpot deal</h2>
          {props.initialDealId ? (
            <p className="text-sm text-slate-700">Deal <strong>#{props.initialDealId}</strong> (opened from HubSpot). The document stays linked to this deal permanently.</p>
          ) : (
            <div className="max-w-sm">
              <Label htmlFor="dealId" hint="(optional)">HubSpot deal ID</Label>
              <Input id="dealId" inputMode="numeric" value={dealId} onChange={(e) => setDealId(e.target.value.trim())} placeholder="e.g. 123456789" aria-invalid={!dealValid} />
              {!dealValid ? <p className="mt-1 text-sm text-red-600">HubSpot deal IDs are numeric.</p> : <p className="mt-1 text-xs text-slate-500">Tip: open the deal in HubSpot and use the DealDocs card — the ID is filled in for you.</p>}
            </div>
          )}
          {dealId && dealValid ? (
            props.integrationReady ? (
              <p className="mt-3 text-sm text-slate-600">After creation, DealDocs requests the deal’s contact, company and line items from HubSpot through Zapier and imports them into the draft.</p>
            ) : (
              <div className="mt-3"><Alert tone="warning">HubSpot via Zapier is not configured, so deal data cannot be imported automatically. You can enter client details and products in the editor.</Alert></div>
            )
          ) : null}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="step-template">
          <h2 id="step-template" className="mb-3 font-semibold">3. Template</h2>
          {!type ? (
            <p className="text-sm text-slate-600">Choose Quote or Contract first.</p>
          ) : templates.length === 0 ? (
            <Alert tone="warning">No published {type === "QUOTE" ? "quote" : "contract"} templates.</Alert>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Template">
              {templates.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={templateId === t.id} onClick={() => setTemplateId(t.id)} className={cn("rounded-md border-2 p-3 text-left", templateId === t.id ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:border-slate-300")}>
                  <span className="block font-medium">{t.name}{t.isDefault ? <span className="ml-2 text-xs text-brand-700">Default</span> : null}</span>
                  {t.description ? <span className="text-sm text-slate-600">{t.description}</span> : null}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="h-fit space-y-3 rounded-lg border border-slate-200 bg-white p-5 lg:sticky lg:top-6">
        <h2 className="font-semibold">Summary</h2>
        <input type="hidden" name="type" value={type ?? ""} />
        <input type="hidden" name="templateId" value={templateId} />
        <input type="hidden" name="dealId" value={dealValid ? dealId : ""} />
        <details>
          <summary className="cursor-pointer text-sm text-slate-600">Advanced</summary>
          <div className="mt-2">
            <Label htmlFor="currency" hint="(optional)">Currency</Label>
            <Select id="currency" name="currency" defaultValue="">
              <option value="">Template / company default ({props.defaultCurrency})</option>
              {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
        </details>
        {state && !state.ok ? <Alert tone="error">{state.error}</Alert> : null}
        <SubmitButton className="w-full" pendingLabel="Creating…">{ready ? "Create & edit" : "Complete the steps"}</SubmitButton>
        {!ready ? <p className="text-xs text-slate-500">Select a type and a template.</p> : null}
      </aside>
    </form>
  );
}
