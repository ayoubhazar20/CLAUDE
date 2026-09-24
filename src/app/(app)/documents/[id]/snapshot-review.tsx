"use client";

import { ActionForm, FormResult, SubmitButton } from "@/components/forms";
import { Alert } from "@/components/ui";
import { resolveSnapshotAction } from "@/app/actions/integrations";

const SECTION_LABELS: Record<string, string> = { contact: "Contact", company: "Company", deal: "Deal", customProperties: "HubSpot properties", recipient: "Recipient" };

/**
 * Review of HubSpot data received via Zapier. Nothing is overwritten unless the
 * user explicitly selects it — manual document edits are preserved by default.
 */
export function SnapshotReview(props: {
  documentId: string;
  snapshotId: string;
  receivedAt: string;
  canApply: boolean;
  needsRevision: boolean;
  diff: { section: string; field: string; current: string; incoming: string }[];
  hasContact: boolean;
  incomingLines: { name: string; quantity: string; unitPrice: string }[];
  currentLines: { name: string; quantity: string; unitPrice: string }[];
  currency: string;
}) {
  const sections = [...new Set(props.diff.map((d) => d.section))];
  return (
    <section className="rounded-lg border-2 border-amber-300 bg-white p-5" aria-labelledby="review-title">
      <h2 id="review-title" className="text-base font-semibold">New HubSpot data — review</h2>
      <p className="mt-1 text-sm text-slate-600">Received {props.receivedAt}. Current document values are kept unless you choose to replace them.</p>
      {props.needsRevision ? <div className="mt-3"><Alert tone="info">This version is published. Create a revision to apply HubSpot data — published and signed versions are never modified.</Alert></div> : null}
      <ActionForm action={resolveSnapshotAction} className="mt-4 space-y-4">
        {(state) => (
          <>
            <FormResult state={state} />
            <input type="hidden" name="documentId" value={props.documentId} />
            <input type="hidden" name="snapshotId" value={props.snapshotId} />
            {props.diff.length ? (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-3">Field</th><th className="py-1 pr-3">In this document</th><th className="py-1">In HubSpot</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {props.diff.map((d) => (
                      <tr key={`${d.section}-${d.field}`}>
                        <td className="py-1.5 pr-3 text-slate-500">{SECTION_LABELS[d.section]} · {d.field}</td>
                        <td className="py-1.5 pr-3">{d.current || <span className="text-slate-400">empty</span>}</td>
                        <td className="py-1.5 font-medium">{d.incoming || <span className="text-slate-400">empty</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-sm text-slate-600">Client, company and deal details are identical.</p>}
            {props.canApply ? (
              <>
                <fieldset className="flex flex-wrap gap-4 text-sm">
                  <legend className="mb-1 text-sm font-medium">Replace in the draft</legend>
                  {sections.map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" name="sections" value={s} /> {SECTION_LABELS[s]}</label>)}
                  {props.hasContact ? <label className="flex items-center gap-1"><input type="checkbox" name="sections" value="recipient" /> Add HubSpot contact as signer</label> : null}
                </fieldset>
                {props.incomingLines.length ? (
                  <fieldset className="text-sm">
                    <legend className="mb-1 font-medium">Products ({props.incomingLines.length} in HubSpot, {props.currentLines.length} in this document)</legend>
                    <ul className="mb-2 list-disc pl-5 text-xs text-slate-600">{props.incomingLines.slice(0, 10).map((l, i) => <li key={i}>{l.name} — {l.quantity} × {l.unitPrice} {props.currency}</li>)}</ul>
                    <div className="flex flex-wrap gap-4">
                      <label className="flex items-center gap-1"><input type="radio" name="lineItems" value="keep" defaultChecked /> Keep document products</label>
                      <label className="flex items-center gap-1"><input type="radio" name="lineItems" value="append" /> Add HubSpot products</label>
                      <label className="flex items-center gap-1"><input type="radio" name="lineItems" value="replace" /> Replace with HubSpot products</label>
                    </div>
                  </fieldset>
                ) : <input type="hidden" name="lineItems" value="keep" />}
                <div className="flex gap-2">
                  <SubmitButton name="decision" value="apply">Apply selected</SubmitButton>
                  <SubmitButton name="decision" value="dismiss" variant="secondary">Dismiss</SubmitButton>
                </div>
              </>
            ) : !props.needsRevision ? <p className="text-sm text-slate-500">You cannot edit this document.</p> : null}
          </>
        )}
      </ActionForm>
    </section>
  );
}
