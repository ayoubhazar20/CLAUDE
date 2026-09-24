"use client";

import { useActionState, useEffect, useState } from "react";
import { createDocumentAction } from "@/app/actions/documents";
import { SubmitButton } from "@/components/forms";
import { Alert, Button, Input, Label, Select, cn } from "@/components/ui";
import { CURRENCY_CODES } from "@/domain/currencies";

interface TemplateOption {
  id: string;
  name: string;
  documentType: "QUOTE" | "CONTRACT";
  isDefault: boolean;
  description: string | null;
}
interface Deal {
  id: string;
  name: string;
  amount: string;
  currency?: string;
}
interface Contact {
  hubspotId: string;
  firstName: string;
  lastName: string;
  email: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message ?? "Request failed");
  return json as T;
}

export function NewDocumentWizard(props: { templates: TemplateOption[]; initialType: "QUOTE" | "CONTRACT" | null; initialDealId: string | null; hubspotConnected: boolean; defaultCurrency: string }) {
  const [type, setType] = useState<"QUOTE" | "CONTRACT" | null>(props.initialType);
  const [query, setQuery] = useState("");
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [deal, setDeal] = useState<Deal | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withoutDeal, setWithoutDeal] = useState(false);
  const [state, formAction] = useActionState(createDocumentAction, null);

  const templates = props.templates.filter((t) => t.documentType === type);
  const [templateId, setTemplateId] = useState("");
  useEffect(() => {
    setTemplateId((templates.find((t) => t.isDefault) ?? templates[0])?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const loadDeal = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getJson<{ deal: Deal; contacts: Contact[] }>(`/api/hubspot/deals/${id}`);
      setDeal(res.deal);
      setContacts(res.contacts);
      setContactId((res.contacts.find((c) => c.email) ?? res.contacts[0])?.hubspotId ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (props.initialDealId && props.hubspotConnected) void loadDeal(props.initialDealId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await getJson<{ deals: Deal[] }>(`/api/hubspot/deals?q=${encodeURIComponent(query)}`);
      setDeals(res.deals);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const ready = type && templateId && (deal || withoutDeal || !props.hubspotConnected);

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <section className="rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="step-type">
          <h2 id="step-type" className="mb-3 font-semibold">1. Create new</h2>
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Document type">
            {(["QUOTE", "CONTRACT"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={type === t}
                onClick={() => setType(t)}
                className={cn("rounded-lg border-2 p-4 text-left transition", type === t ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:border-slate-300")}
              >
                <span className="block text-base font-semibold">{t === "QUOTE" ? "Quote" : "Contract"}</span>
                <span className="text-sm text-slate-600">{t === "QUOTE" ? "Pricing proposal with online acceptance" : "Agreement with electronic signatures"}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5" aria-labelledby="step-deal">
          <h2 id="step-deal" className="mb-3 font-semibold">2. HubSpot deal</h2>
          {!props.hubspotConnected ? (
            <Alert tone="warning">HubSpot is not connected — the document will be created without deal data. You can enter the client details in the editor.</Alert>
          ) : deal ? (
            <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div>
                <p className="font-medium">{deal.name}</p>
                <p className="text-sm text-slate-600">Deal #{deal.id}{deal.amount ? ` · ${deal.amount} ${deal.currency ?? ""}` : ""}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setDeal(null); setContacts([]); }}>Change</Button>
            </div>
          ) : withoutDeal ? (
            <div className="flex items-center justify-between rounded-md border border-slate-200 px-4 py-3 text-sm">
              <span>No deal — client details will be entered manually.</span>
              <Button variant="ghost" size="sm" onClick={() => setWithoutDeal(false)}>Select a deal</Button>
            </div>
          ) : (
            <>
              <form onSubmit={search} className="flex gap-2" role="search">
                <label htmlFor="deal-q" className="sr-only">Search deals</label>
                <Input id="deal-q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search deals by name…" />
                <Button type="submit" variant="secondary" disabled={loading}>{loading ? "Searching…" : "Search"}</Button>
              </form>
              {deals ? (
                deals.length ? (
                  <ul className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200">
                    {deals.map((d) => (
                      <li key={d.id}>
                        <button type="button" onClick={() => void loadDeal(d.id)} className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-slate-50">
                          <span className="font-medium">{d.name}</span>
                          <span className="text-sm text-slate-500">{d.amount ? `${d.amount} ${d.currency ?? ""}` : ""}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 text-sm text-slate-600">No deals found.</p>
                )
              ) : null}
            </>
          )}
          {error ? <div className="mt-3"><Alert tone="error">{error}</Alert></div> : null}
          {deal && contacts.length > 0 ? (
            <div className="mt-4">
              <Label htmlFor="contact">Recipient / signatory</Label>
              <Select id="contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                {contacts.map((c) => (
                  <option key={c.hubspotId} value={c.hubspotId} disabled={!c.email}>
                    {[c.firstName, c.lastName].filter(Boolean).join(" ") || "(no name)"} — {c.email || "no email"}
                  </option>
                ))}
              </Select>
            </div>
          ) : deal ? (
            <p className="mt-3 text-sm text-amber-700">This deal has no associated contacts. You can add recipients in the editor.</p>
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
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={templateId === t.id}
                  onClick={() => setTemplateId(t.id)}
                  className={cn("rounded-md border-2 p-3 text-left", templateId === t.id ? "border-brand-600 bg-brand-50" : "border-slate-200 hover:border-slate-300")}
                >
                  <span className="block font-medium">{t.name}{t.isDefault ? <span className="ml-2 text-xs text-brand-700">Default</span> : null}</span>
                  {t.description ? <span className="text-sm text-slate-600">{t.description}</span> : null}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="h-fit rounded-lg border border-slate-200 bg-white p-5 lg:sticky lg:top-6">
        <h2 className="mb-3 font-semibold">Summary</h2>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="type" value={type ?? ""} />
          <input type="hidden" name="templateId" value={templateId} />
          <input type="hidden" name="dealId" value={deal?.id ?? ""} />
          <input type="hidden" name="contactId" value={contactId} />
          <details>
            <summary className="cursor-pointer text-sm text-slate-600">Advanced</summary>
            <div className="mt-2">
              <Label htmlFor="currency" hint="(optional)">Currency</Label>
              <Select id="currency" name="currency" defaultValue="">
                <option value="">Template / deal / company default ({props.defaultCurrency})</option>
                {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </details>
          {state && !state.ok ? <Alert tone="error">{state.error}</Alert> : null}
          <SubmitButton className="w-full" pendingLabel="Importing data…">{ready ? "Create & edit" : "Complete the steps"}</SubmitButton>
          {!ready ? <p className="text-xs text-slate-500">Select a type, a deal and a template.</p> : null}
        </form>
      </aside>
    </div>
  );
}
