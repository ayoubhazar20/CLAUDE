import type { Metadata } from "next";
import { loadPublicView } from "@/server/documents/public";
import { maskEmail } from "@/server/documents/otp";
import { CONSENT_TEXT, ACCEPTANCE_TEXT } from "@/server/documents/signing";
import { DocumentFrame } from "@/components/document-frame";
import { renderDocumentHtml } from "@/domain/render-html";
import { formatMoney } from "@/domain/money";
import { dateLabel } from "@/lib/format";
import { PublicActions } from "./public-actions";
import { ViewTracker } from "./view-tracker";

export const metadata: Metadata = { title: "Document", robots: { index: false, follow: false }, referrer: "no-referrer" };

function StatusBanner({ tone, title, children }: { tone: "green" | "amber" | "red" | "gray"; title: string; children?: React.ReactNode }) {
  const cls = { green: "border-emerald-200 bg-emerald-50 text-emerald-900", amber: "border-amber-200 bg-amber-50 text-amber-900", red: "border-red-200 bg-red-50 text-red-900", gray: "border-slate-200 bg-slate-100 text-slate-800" }[tone];
  return (
    <div className={`rounded-lg border px-4 py-3 ${cls}`} role="status">
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-0.5 text-sm">{children}</div> : null}
    </div>
  );
}

export default async function PublicDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await loadPublicView(token);
  if (!view || view.doc.archivedAt) {
    return (
      <main className="mx-auto max-w-lg px-4 py-24 text-center">
        <h1 className="text-2xl font-semibold">Document not found</h1>
        <p className="mt-2 text-sm text-slate-600">This link is invalid or the document is no longer available. Please contact the sender.</p>
      </main>
    );
  }
  const { doc, version, organization, recipients, attachments, signatures, resolved, totals } = view;
  const tz = organization.timezone;
  const mode: "ACCEPT" | "SIGN" = doc.type === "QUOTE" && doc.acceptanceMode === "ACCEPTANCE_ONLY" ? "ACCEPT" : "SIGN";
  const signedIds = new Set(signatures.filter((s) => s.kind === "SIGNATURE").map((s) => s.recipientId));
  const firstPending = Math.min(...recipients.filter((r) => r.role === "SIGNER" && r.required && !signedIds.has(r.id)).map((r) => r.signingOrder), Infinity);
  const actionRecipients = recipients
    .filter((r) => r.role === "SIGNER")
    .map((r) => ({
      id: r.id,
      name: r.name,
      maskedEmail: maskEmail(r.email),
      signed: signedIds.has(r.id),
      canActNow: doc.signingOrder !== "SEQUENTIAL" || r.signingOrder <= firstPending,
    }));
  const open = ["PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE"].includes(doc.status);
  const brand = /^#[0-9a-f]{6}$/i.test(organization.brandColor) ? organization.brandColor : "#2563eb";

  return (
    <div className="min-h-screen bg-slate-100">
      <ViewTracker token={token} />
      <header className="border-b border-slate-200 bg-white" style={{ borderTop: `4px solid ${brand}` }}>
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div className="flex items-center gap-3">
            {organization.logoFileId ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/d/${token}/logo`} alt={organization.name} className="max-h-10 max-w-[160px] object-contain" />
            ) : (
              <span className="text-lg font-bold">{organization.name}</span>
            )}
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{doc.title}</p>
            <p className="text-slate-500">{doc.number} · Version {version.versionNumber}</p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6 pb-40">
        <div className="mb-4 space-y-3">
          {doc.status === "ACCEPTED" ? <StatusBanner tone="green" title="Quote accepted">Accepted on {dateLabel(doc.acceptedAt, tz)}. Thank you!</StatusBanner> : null}
          {doc.status === "SIGNED" ? <StatusBanner tone="green" title="Signature completed">All parties signed on {dateLabel(doc.signedAt, tz)}. You can download the signed copy below.</StatusBanner> : null}
          {doc.status === "AWAITING_SIGNATURE" ? <StatusBanner tone="amber" title="Partially signed">Waiting for the remaining signatories.</StatusBanner> : null}
          {doc.status === "REJECTED" ? <StatusBanner tone="red" title="Declined">This document was declined{doc.rejectedAt ? ` on ${dateLabel(doc.rejectedAt, tz)}` : ""}.</StatusBanner> : null}
          {doc.status === "EXPIRED" ? <StatusBanner tone="gray" title="Document expired">This document expired on {dateLabel(doc.expiresAt, tz)}. Please contact {organization.name} for an updated version.</StatusBanner> : null}
          {doc.status === "CANCELLED" ? <StatusBanner tone="gray" title="Document cancelled">This document was withdrawn by {organization.name}.</StatusBanner> : null}
        </div>

        <div className="mb-4 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-4">
          <div><p className="text-xs uppercase tracking-wide text-slate-500">Prepared for</p><p className="font-medium">{doc.clientName ?? recipients[0]?.name ?? "—"}</p>{doc.clientCompany ? <p className="text-slate-600">{doc.clientCompany}</p> : null}</div>
          <div><p className="text-xs uppercase tracking-wide text-slate-500">From</p><p className="font-medium">{organization.name}</p></div>
          <div><p className="text-xs uppercase tracking-wide text-slate-500">Total</p><p className="font-semibold">{formatMoney(totals.grandTotal, version.currency)}</p></div>
          <div><p className="text-xs uppercase tracking-wide text-slate-500">Valid until</p><p className="font-medium">{doc.expiresAt ? dateLabel(doc.expiresAt, tz) : "—"}</p></div>
        </div>

        <article className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-10">
          <DocumentFrame html={renderDocumentHtml(resolved)} />
        </article>

        <section className="mt-4 rounded-lg border border-slate-200 bg-white p-4" aria-labelledby="downloads">
          <h2 id="downloads" className="mb-2 text-sm font-semibold">Downloads</h2>
          <ul className="space-y-1 text-sm">
            <li><a className="text-brand-700 underline" href={`/d/${token}/pdf`} style={{ color: brand }}>Download PDF{version.signedPdfFileId ? " (final)" : ""}</a></li>
            {attachments.map((a) => (
              <li key={a.id}><a className="underline" href={`/d/${token}/files/${a.id}`} style={{ color: brand }}>{a.name}</a> <span className="text-slate-500">({Math.ceil(a.file.size / 1024)} KB)</span></li>
            ))}
          </ul>
        </section>
        <p className="mt-6 text-center text-xs text-slate-400">Secured by DealDocs · Electronic acceptance and signatures are verified with a one-time code sent by email.</p>
      </main>

      {open ? (
        <PublicActions
          token={token}
          mode={mode}
          documentType={doc.type}
          recipients={actionRecipients}
          brand={brand}
          consentText={CONSENT_TEXT}
          acceptanceText={ACCEPTANCE_TEXT}
        />
      ) : null}
    </div>
  );
}
