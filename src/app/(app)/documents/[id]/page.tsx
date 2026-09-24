import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgPage } from "@/server/auth/context";
import { prisma } from "@/server/db";
import { canEditDocument, loadDocumentForView } from "@/server/documents/access";
import { documentAnalytics, formatDuration } from "@/server/documents/queries";
import { resolveFromRows } from "@/server/documents/render-input";
import { NotFoundError } from "@/server/errors";
import { appUrl } from "@/server/env";
import { Badge, Card, DescriptionList, EmptyState, PageHeader, Table, Tabs, Td, Th } from "@/components/ui";
import { StatusBadge } from "@/components/status-badge";
import { DocumentFrame } from "@/components/document-frame";
import { dateLabel, dateTimeLabel, money } from "@/lib/format";
import { renderDocumentHtml } from "@/domain/render-html";
import { DOCUMENT_TYPE_LABELS, STATUS_LABELS } from "@/domain/status";
import { PERMISSIONS } from "@/domain/permissions";
import { DocumentActions } from "./actions-bar";
import { AttachmentsPanel } from "./attachments";
import { SnapshotReview } from "./snapshot-review";
import { InlineAction } from "@/components/forms";
import { objectTypeIdFor } from "@/server/integrations/config";
import { diffSnapshot, type NormalizedSnapshot } from "@/server/integrations/snapshot";
import { parseDocumentData } from "@/domain/document-data";
import { refreshHubSpotDataAction, retrySyncAction } from "@/app/actions/integrations";

export const metadata = { title: "Document" };

const EVENT_LABELS: Record<string, string> = {
  CREATED: "Created",
  EDITED: "Edited",
  PUBLISHED: "Published",
  EMAIL_SENT: "Email sent",
  REMINDER_SENT: "Reminder sent",
  VIEWED: "Viewed",
  OTP_REQUESTED: "OTP requested",
  OTP_VERIFIED: "OTP verified",
  OTP_FAILED: "OTP failed",
  CONSENT_GIVEN: "Consent given",
  ACCEPTED: "Accepted",
  SIGNED: "Signed",
  SIGNATURE_COMPLETED: "All signatures completed",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  REVISION_CREATED: "Revision created",
  DRAFT_DISCARDED: "Draft discarded",
  DUPLICATED: "Duplicated",
  CONVERTED: "Converted to contract",
  ARCHIVED: "Archived",
  RESTORED: "Restored",
  PRIMARY_SET: "Marked primary",
  OWNER_CHANGED: "Owner changed",
  PDF_GENERATED: "PDF generated",
  ATTACHMENT_ADDED: "Attachment added",
  ATTACHMENT_REMOVED: "Attachment removed",
  HUBSPOT_RECORD_LINKED: "HubSpot record linked",
  HUBSPOT_DATA_REQUESTED: "HubSpot data requested",
  HUBSPOT_DATA_RECEIVED: "HubSpot data received",
  HUBSPOT_DATA_APPLIED: "HubSpot data applied",
  HUBSPOT_DATA_DISMISSED: "HubSpot data dismissed",
  HUBSPOT_UPDATE_RECEIVED: "HubSpot change received",
};

function metaSummary(type: string, meta: Record<string, unknown>): string {
  if (type === "EMAIL_SENT" || type === "REMINDER_SENT") return `To ${(meta.to as string[] | undefined)?.join(", ") ?? ""}`;
  if (type === "REJECTED" && meta.reason) return `Reason: ${String(meta.reason)}`;
  if (type === "HUBSPOT_RECORD_LINKED") return `Record #${String(meta.recordId ?? "")}`;
  if (type === "HUBSPOT_DATA_RECEIVED") return meta.applied ? "Imported automatically" : "Waiting for review";
  if (type === "HUBSPOT_UPDATE_RECEIVED") return `${String(meta.property ?? "")}`;
  if (type === "SIGNED" || type === "ACCEPTED") return [meta.signer, meta.email, meta.method].filter(Boolean).join(" · ");
  if (type === "OTP_FAILED") return `${meta.remainingAttempts ?? 0} attempts left`;
  if (type === "CONVERTED") return `Contract ${String(meta.contract ?? "")}`;
  if (type === "CREATED" && meta.convertedFrom) return `From quote ${String(meta.convertedFrom)}`;
  if (type === "CREATED" && meta.duplicatedFrom) return `Duplicate of ${String(meta.duplicatedFrom)}`;
  return "";
}

export default async function DocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireOrgPage();
  const { id } = await params;
  const tab = (await searchParams).tab ?? "document";
  let doc;
  try {
    doc = await loadDocumentForView(ctx, id, { owner: { select: { id: true, name: true, email: true } }, sourceQuote: { select: { id: true, number: true } }, derivedContracts: { select: { id: true, number: true, status: true } } });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const canEdit = await canEditDocument(ctx, doc);
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } });
  const currentVersionId = doc.publishedVersionId ?? doc.draftVersionId;
  const version = currentVersionId ? await prisma.documentVersion.findUnique({ where: { id: currentVersionId } }) : null;
  const tz = ctx.organization.timezone;
  const base = `/documents/${doc.id}`;
  const [versionCount, signatureCount, attachmentCount, emailCount] = await Promise.all([
    prisma.documentVersion.count({ where: { documentId: doc.id, status: { not: "DISCARDED" } } }),
    prisma.signature.count({ where: { documentId: doc.id } }),
    prisma.attachment.count({ where: { documentId: doc.id, archivedAt: null } }),
    prisma.emailDelivery.count({ where: { documentId: doc.id } }),
  ]);
  const contractTemplates = doc.type === "QUOTE" ? await prisma.template.findMany({ where: { organizationId: ctx.organizationId, documentType: "CONTRACT", status: "ACTIVE", publishedVersionId: { not: null } }, select: { id: true, name: true, isDefault: true } }) : [];
  const members = ctx.permissions.has(PERMISSIONS.DOCUMENTS_REASSIGN) ? await prisma.organizationMembership.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, include: { user: { select: { id: true, name: true } } } }) : [];
  const pdfFileId = version?.signedPdfFileId ?? version?.pdfFileId ?? null;

  const tabs = [
    { key: "document", label: "Document", href: base },
    { key: "versions", label: `Versions (${versionCount})`, href: `${base}?tab=versions` },
    { key: "activity", label: "Activity", href: `${base}?tab=activity` },
    { key: "emails", label: `Emails (${emailCount})`, href: `${base}?tab=emails` },
    { key: "signatures", label: `Signatures (${signatureCount})`, href: `${base}?tab=signatures` },
    { key: "attachments", label: `Attachments (${attachmentCount})`, href: `${base}?tab=attachments` },
    { key: "hubspot", label: "HubSpot", href: `${base}?tab=hubspot` },
  ];

  let content: React.ReactNode = null;
  if (tab === "document") {
    let html = "";
    if (version) {
      const [lines, recipients, signatures] = await Promise.all([
        prisma.documentLineItem.findMany({ where: { versionId: version.id } }),
        version.lockedAt ? prisma.documentRecipient.findMany({ where: { documentId: doc.id, removedAt: null } }) : Promise.resolve(null),
        prisma.signature.findMany({ where: { versionId: version.id } }),
      ]);
      const { resolved } = resolveFromRows({
        document: doc,
        version,
        lineItems: lines,
        organization,
        recipients,
        signatures,
        logoUrl: organization.logoFileId ? `/api/files/${organization.logoFileId}` : null,
        imageUrl: (fileId) => `/api/files/${fileId}`,
        showMissingVariables: !version.lockedAt,
      });
      html = renderDocumentHtml(resolved);
    }
    const a = documentAnalytics(doc);
    content = (
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          {doc.draftVersionId && doc.publishedVersionId ? (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              A draft revision (v{doc.latestVersionNumber}) is in progress. The client still sees the published version below. <Link href={`${base}/edit`} className="font-semibold underline">Continue editing</Link>
            </p>
          ) : null}
          <div className="rounded-lg border border-slate-200 bg-white p-5 sm:p-8">
            {html ? <DocumentFrame html={html} /> : <EmptyState title="No content" />}
          </div>
        </div>
        <div className="space-y-5">
          <Card title="Details">
            <DescriptionList
              items={[
                { label: "Owner", value: doc.owner.name },
                { label: "Client", value: [doc.clientName, doc.clientCompany].filter(Boolean).join(" · ") || "—" },
                { label: "Currency", value: doc.currency },
                { label: "Expires", value: dateLabel(doc.expiresAt, tz) },
                { label: "Created", value: dateTimeLabel(doc.createdAt, tz) },
                { label: "Published", value: dateTimeLabel(doc.firstPublishedAt, tz) },
                { label: "Public link", value: doc.publishedVersionId ? <a href={appUrl(`/d/${doc.publicToken}`)} target="_blank" rel="noreferrer" className="break-all text-brand-700 underline">/d/{doc.publicToken.slice(0, 8)}…</a> : "Not published" },
                { label: "Source quote", value: doc.sourceQuote ? <Link className="text-brand-700 underline" href={`/documents/${doc.sourceQuote.id}`}>{doc.sourceQuote.number}</Link> : "—" },
              ]}
            />
            {doc.derivedContracts.length ? (
              <p className="mt-3 text-sm">Contracts: {doc.derivedContracts.map((c) => <Link key={c.id} className="mr-2 text-brand-700 underline" href={`/documents/${c.id}`}>{c.number}</Link>)}</p>
            ) : null}
          </Card>
          <Card title="Analytics">
            <DescriptionList
              items={[
                { label: "Total views", value: a.totalViews },
                { label: "Unique viewers", value: a.uniqueViews },
                { label: "First viewed", value: dateTimeLabel(a.firstViewedAt, tz) },
                { label: "Last viewed", value: dateTimeLabel(a.lastViewedAt, tz) },
                { label: "Sends / reminders", value: `${a.sends} / ${a.reminders}` },
                { label: "Revisions", value: a.revisions },
                { label: "Sent", value: dateTimeLabel(a.sentAt, tz) },
                { label: "Accepted", value: dateTimeLabel(a.acceptedAt, tz) },
                { label: "Signed", value: dateTimeLabel(a.signedAt, tz) },
                { label: "Rejected", value: dateTimeLabel(a.rejectedAt, tz) },
                { label: "Time to first view", value: formatDuration(a.timeToFirstViewMs) },
                { label: "Time to completion", value: formatDuration(a.timeToCompletionMs) },
              ]}
            />
            {doc.rejectionReason ? <p className="mt-3 text-sm text-red-700">Rejection reason: {doc.rejectionReason}</p> : null}
          </Card>
        </div>
      </div>
    );
  } else if (tab === "versions") {
    const versions = await prisma.documentVersion.findMany({ where: { documentId: doc.id }, orderBy: { versionNumber: "desc" }, select: { id: true, versionNumber: true, status: true, createdAt: true, publishedAt: true, completedAt: true, contentHash: true, pdfFileId: true, signedPdfFileId: true, currency: true, totals: true } });
    content = (
      <Table>
        <thead className="bg-slate-50"><tr><Th>Version</Th><Th>Status</Th><Th>Published</Th><Th>Total</Th><Th>Hash</Th><Th>Files</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {versions.map((v) => (
            <tr key={v.id}>
              <Td className="font-medium">v{v.versionNumber}{v.id === doc.publishedVersionId ? <span className="ml-2"><Badge tone="blue">Live</Badge></span> : null}</Td>
              <Td><Badge tone={v.status === "SIGNED" || v.status === "ACCEPTED" ? "green" : v.status === "DRAFT" ? "gray" : v.status === "PUBLISHED" ? "blue" : "gray"}>{v.status.charAt(0) + v.status.slice(1).toLowerCase()}</Badge></Td>
              <Td>{dateTimeLabel(v.publishedAt, tz)}{v.completedAt ? <div className="text-xs text-slate-500">Completed {dateTimeLabel(v.completedAt, tz)}</div> : null}</Td>
              <Td className="tabular-nums">{money((v.totals as { grandTotal?: string }).grandTotal ?? "0", v.currency)}</Td>
              <Td className="font-mono text-xs" >{v.contentHash ? `${v.contentHash.slice(0, 12)}…` : "—"}</Td>
              <Td className="space-x-2 whitespace-nowrap">
                {v.pdfFileId ? <a className="text-brand-700 underline" href={`/api/files/${v.pdfFileId}`}>PDF</a> : v.publishedAt ? <span className="text-xs text-slate-500">Generating…</span> : null}
                {v.signedPdfFileId ? <a className="text-brand-700 underline" href={`/api/files/${v.signedPdfFileId}`}>Final PDF</a> : null}
                {v.publishedAt ? <Link className="text-brand-700 underline" href={`${base}/preview?version=${v.versionNumber}`}>View</Link> : null}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  } else if (tab === "activity") {
    const [events, statuses] = await Promise.all([
      prisma.documentEvent.findMany({ where: { documentId: doc.id }, orderBy: { createdAt: "desc" }, take: 300 }),
      prisma.documentStatusChange.findMany({ where: { documentId: doc.id }, orderBy: { createdAt: "desc" } }),
    ]);
    const userIds = [...new Set(events.map((e) => e.actorUserId).filter((x): x is string => Boolean(x)))];
    const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    content = (
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Card title="History">
            <ol className="space-y-3">
              {events.map((e) => (
                <li key={e.id} className="flex gap-3 text-sm">
                  <span className="mt-1.5 h-2 w-2 flex-none rounded-full bg-brand-500" aria-hidden="true" />
                  <div>
                    <p>
                      <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                      {e.versionNumber ? <span className="text-slate-500"> · v{e.versionNumber}</span> : null}
                      <span className="text-slate-500"> · {(e.actorUserId ? users.get(e.actorUserId) : e.actorLabel) ?? (e.actorType === "SYSTEM" ? "System" : "Client")}</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {dateTimeLabel(e.createdAt, tz)}{e.ip ? ` · IP ${e.ip}` : ""}{metaSummary(e.type, e.metadata as Record<string, unknown>) ? ` · ${metaSummary(e.type, e.metadata as Record<string, unknown>)}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Card title="Status history">
          <ol className="space-y-2 text-sm">
            {statuses.map((s) => (
              <li key={s.id}>
                <span className="text-slate-500">{s.fromStatus ? STATUS_LABELS[s.fromStatus] : "—"} →</span> <span className="font-medium">{STATUS_LABELS[s.toStatus]}</span>
                <div className="text-xs text-slate-500">{dateTimeLabel(s.createdAt, tz)}{s.versionNumber ? ` · v${s.versionNumber}` : ""}{s.reason ? ` · ${s.reason}` : ""}</div>
              </li>
            ))}
            {statuses.length === 0 ? <li className="text-slate-500">No status changes yet.</li> : null}
          </ol>
        </Card>
      </div>
    );
  } else if (tab === "emails") {
    const emails = await prisma.emailDelivery.findMany({ where: { documentId: doc.id, organizationId: ctx.organizationId, kind: { notIn: ["OTP"] } }, orderBy: { queuedAt: "desc" } });
    content = emails.length ? (
      <Table>
        <thead className="bg-slate-50"><tr><Th>Subject</Th><Th>To</Th><Th>Status</Th><Th>Queued</Th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {emails.map((m) => (
            <tr key={m.id}>
              <Td><div className="font-medium">{m.subject}</div><div className="text-xs text-slate-500">{m.kind.replace(/_/g, " ").toLowerCase()}{m.versionNumber ? ` · v${m.versionNumber}` : ""}</div></Td>
              <Td className="text-xs">{m.to.join(", ")}{m.cc.length ? <div className="text-slate-500">cc {m.cc.join(", ")}</div> : null}</Td>
              <Td><Badge tone={m.status === "SENT" || m.status === "DELIVERED" ? "green" : m.status === "FAILED" ? "red" : "gray"}>{m.status.toLowerCase()}</Badge>{m.error ? <div className="mt-1 max-w-xs text-xs text-red-600">{m.error}</div> : null}</Td>
              <Td className="whitespace-nowrap text-xs">{dateTimeLabel(m.queuedAt, tz)}{m.sentAt ? <div className="text-slate-500">Sent {dateTimeLabel(m.sentAt, tz)}</div> : null}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    ) : (
      <EmptyState title="No emails yet" description="Use Send or Publish & Send to email the document to your client." />
    );
  } else if (tab === "signatures") {
    const [signatures, recipients] = await Promise.all([
      prisma.signature.findMany({ where: { documentId: doc.id }, include: { version: { select: { versionNumber: true } }, otpChallenge: { select: { verifiedAt: true } } }, orderBy: { signedAt: "desc" } }),
      prisma.documentRecipient.findMany({ where: { documentId: doc.id, removedAt: null }, orderBy: { signingOrder: "asc" } }),
    ]);
    content = (
      <div className="space-y-5">
        <Card title={`Recipients${doc.signingOrder === "SEQUENTIAL" ? " (sequential signing)" : ""}`}>
          {recipients.length ? (
            <ul className="divide-y divide-slate-100 text-sm">
              {recipients.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2">
                  <span>{doc.signingOrder === "SEQUENTIAL" ? `${r.signingOrder}. ` : ""}<span className="font-medium">{r.name}</span> <span className="text-slate-500">{r.email} · {r.role.toLowerCase()}{r.required ? "" : " (optional)"}</span></span>
                  <Badge tone={r.status === "SIGNED" || r.status === "ACCEPTED" ? "green" : r.status === "REJECTED" ? "red" : "gray"}>{r.status.toLowerCase()}</Badge>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-500">Recipients are set when the document is published.</p>}
        </Card>
        {signatures.length ? (
          <Table>
            <thead className="bg-slate-50"><tr><Th>Signer</Th><Th>Action</Th><Th>Version</Th><Th>Evidence</Th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {signatures.map((s) => (
                <tr key={s.id}>
                  <Td><div className="font-medium">{s.signerName}</div><div className="text-xs text-slate-500">{s.signerEmail}</div></Td>
                  <Td>{s.kind === "ACCEPTANCE" ? "Accepted" : `Signed (${s.method.toLowerCase()})`}<div className="text-xs text-slate-500">{dateTimeLabel(s.signedAt, tz)}</div></Td>
                  <Td>v{s.version.versionNumber}</Td>
                  <Td className="text-xs text-slate-600">
                    Email verified {dateTimeLabel(s.otpChallenge.verifiedAt, tz)}<br />IP {s.ip ?? "—"}<br />Hash <span className="font-mono">{s.documentHash.slice(0, 16)}…</span>
                    {s.method === "DRAWN" && s.signatureData ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={s.signatureData} alt={`Signature of ${s.signerName}`} className="mt-1 max-h-12" />
                    ) : s.method === "TYPED" ? <div className="mt-1 font-serif text-lg italic">{s.signatureData}</div> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No signatures yet" />
        )}
      </div>
    );
  } else if (tab === "attachments") {
    const attachments = await prisma.attachment.findMany({ where: { documentId: doc.id, archivedAt: null }, include: { file: { select: { size: true, contentType: true } } }, orderBy: { createdAt: "desc" } });
    content = <AttachmentsPanel documentId={doc.id} canEdit={canEdit} attachments={attachments.map((a) => ({ id: a.id, name: a.name, visibility: a.visibility, fileId: a.fileId, size: a.file.size, createdAt: dateTimeLabel(a.createdAt, tz) }))} />;
  } else if (tab === "hubspot") {
    const [integration, others, syncEvents, pending, lastApplied] = await Promise.all([
      prisma.zapierIntegration.findUnique({ where: { organizationId: ctx.organizationId } }),
      doc.hubspotDealId ? prisma.document.findMany({ where: { organizationId: ctx.organizationId, hubspotDealId: doc.hubspotDealId, id: { not: doc.id } }, orderBy: { createdAt: "desc" }, select: { id: true, number: true, type: true, status: true, isPrimary: true } }) : Promise.resolve([]),
      prisma.syncEvent.findMany({ where: { documentId: doc.id, organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 30 }),
      prisma.dealSnapshot.findFirst({ where: { documentId: doc.id, organizationId: ctx.organizationId, status: "PENDING_REVIEW" }, orderBy: { receivedAt: "desc" } }),
      prisma.dealSnapshot.findFirst({ where: { documentId: doc.id, organizationId: ctx.organizationId, status: "APPLIED" }, orderBy: { receivedAt: "desc" } }),
    ]);
    const canManageSync = ctx.permissions.has(PERMISSIONS.INTEGRATIONS_MANAGE) && !ctx.isSupportView;
    let review: React.ReactNode = null;
    if (pending) {
      const draft = doc.draftVersionId ? await prisma.documentVersion.findUnique({ where: { id: doc.draftVersionId } }) : null;
      const snap = pending.payload as unknown as NormalizedSnapshot;
      const diff = draft ? diffSnapshot(parseDocumentData(draft.data), snap, (integration?.propertyVariableMap ?? {}) as Record<string, string>) : [];
      const currentLines = draft ? await prisma.documentLineItem.findMany({ where: { versionId: draft.id }, orderBy: { position: "asc" }, select: { name: true, quantity: true, unitPrice: true } }) : [];
      review = (
        <SnapshotReview
          documentId={doc.id}
          snapshotId={pending.id}
          receivedAt={dateTimeLabel(pending.receivedAt, tz)}
          canApply={canEdit && Boolean(draft)}
          needsRevision={!draft}
          diff={diff}
          hasContact={Boolean(snap.contact?.email)}
          incomingLines={(snap.lineItems ?? []).map((l) => ({ name: l.name, quantity: l.quantity, unitPrice: l.unitPrice }))}
          currentLines={currentLines.map((l) => ({ name: l.name, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString() }))}
          currency={doc.currency}
        />
      );
    }
    content = (
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="HubSpot link" actions={doc.hubspotDealId && canEdit ? <InlineAction action={refreshHubSpotDataAction} hidden={{ documentId: doc.id }}>Refresh HubSpot data</InlineAction> : null}>
          <DescriptionList
            items={[
              { label: "HubSpot deal", value: doc.hubspotDealId ? <Link className="text-brand-700 underline" href={`/deals/${doc.hubspotDealId}/documents`}>{doc.hubspotDealName ?? "Deal"} #{doc.hubspotDealId}</Link> : "Not linked" },
              { label: "HubSpot record", value: doc.hubspotObjectRecordId ? `#${doc.hubspotObjectRecordId}` : doc.hubspotDealId ? <span className="text-slate-500">Waiting for Zapier</span> : "—" },
              { label: "Custom object type", value: objectTypeIdFor(integration) ?? "Not configured" },
              { label: "Linked", value: dateTimeLabel(doc.hubspotLinkedAt, tz) },
              { label: "Last sync", value: dateTimeLabel(doc.lastSyncAt, tz) },
              { label: "HubSpot data", value: { NOT_REQUESTED: "Not requested", REQUESTED: "Requested — waiting for Zapier", APPLIED: lastApplied ? `Imported ${dateTimeLabel(lastApplied.resolvedAt ?? lastApplied.receivedAt, tz)}` : "Imported", PENDING_REVIEW: "New data waiting for review" }[doc.dealDataStatus] ?? doc.dealDataStatus },
              { label: "Primary document", value: doc.isPrimary ? "Yes" : "No" },
            ]}
          />
          <p className="mt-3 text-xs text-slate-500">DealDocs is authoritative for the document content, prices, versions and signatures. The HubSpot record is a mirror maintained by Zapier.</p>
        </Card>
        <Card title="Other documents on this deal">
          {others.length ? (
            <ul className="space-y-1 text-sm">
              {others.map((o) => (
                <li key={o.id} className="flex items-center justify-between">
                  <Link className="text-brand-700 underline" href={`/documents/${o.id}`}>{o.number}</Link>
                  <span className="flex items-center gap-2">{o.isPrimary ? <Badge tone="blue">Primary</Badge> : null}<StatusBadge status={o.status} /></span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-500">{doc.hubspotDealId ? "This is the only document for the deal." : "—"}</p>}
        </Card>
        {review ? <div className="lg:col-span-2">{review}</div> : null}
        <Card title="Synchronization with HubSpot" className="lg:col-span-2" actions={canManageSync ? <Link href="/settings/integrations/zapier/log" className="text-sm text-brand-700 underline">Full log</Link> : null}>
          {syncEvents.length ? (
            <Table>
              <thead className="bg-slate-50"><tr><Th>When</Th><Th>Event</Th><Th>Status</Th><Th>Details</Th><Th /></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {syncEvents.map((e) => (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap text-xs">{dateTimeLabel(e.createdAt, tz)}</Td>
                    <Td className="font-mono text-xs">{e.eventType}</Td>
                    <Td><Badge tone={e.status === "SUCCESS" ? "green" : e.status === "FAILED" ? "red" : "gray"}>{e.status.toLowerCase()}</Badge></Td>
                    <Td className="max-w-sm text-xs text-slate-600">{e.lastError ?? (e.deliveredAt ? `Delivered ${dateTimeLabel(e.deliveredAt, tz)}` : `Attempts: ${e.attempts}`)}</Td>
                    <Td className="text-right">{e.status === "FAILED" && canManageSync ? <InlineAction action={retrySyncAction} hidden={{ syncEventId: e.id }}>Retry</InlineAction> : null}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : <p className="text-sm text-slate-500">No synchronization yet.</p>}
        </Card>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        back={{ href: doc.type === "QUOTE" ? "/documents?type=QUOTE" : "/documents?type=CONTRACT", label: doc.type === "QUOTE" ? "Quotes" : "Contracts" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {doc.number}
            <StatusBadge status={doc.status} />
            {doc.archivedAt ? <Badge tone="gray">Archived</Badge> : null}
            {doc.isPrimary ? <Badge tone="blue">Primary</Badge> : null}
          </span>
        }
        description={
          <>
            {DOCUMENT_TYPE_LABELS[doc.type]} · {doc.title} · Version {version?.versionNumber ?? doc.latestVersionNumber}
            {doc.clientName ? ` · ${doc.clientName}` : ""} · <span className="font-medium text-slate-900">{money(doc.grandTotal, doc.currency)}</span>
          </>
        }
      />
      <DocumentActions
        doc={{
          id: doc.id,
          type: doc.type,
          status: doc.status,
          hasDraft: Boolean(doc.draftVersionId),
          hasPublished: Boolean(doc.publishedVersionId),
          archived: Boolean(doc.archivedAt),
          isPrimary: doc.isPrimary,
          hasDeal: Boolean(doc.hubspotDealId),
          sent: Boolean(doc.sentAt),
          pdfUrl: pdfFileId ? `/api/files/${pdfFileId}` : null,
          ownerId: doc.ownerId,
        }}
        can={{
          edit: canEdit,
          publish: canEdit && ctx.permissions.has(PERMISSIONS.DOCUMENTS_PUBLISH),
          send: canEdit && ctx.permissions.has(PERMISSIONS.DOCUMENTS_SEND),
          create: ctx.permissions.has(PERMISSIONS.DOCUMENTS_CREATE) && !ctx.isSupportView,
          archive: canEdit && ctx.permissions.has(PERMISSIONS.DOCUMENTS_ARCHIVE),
          reviseCompleted: ctx.permissions.has(PERMISSIONS.DOCUMENTS_REVISE_COMPLETED),
          reviseFromTemplate: ctx.permissions.has(PERMISSIONS.TEMPLATES_MANAGE),
          reassign: canEdit && ctx.permissions.has(PERMISSIONS.DOCUMENTS_REASSIGN),
        }}
        contractTemplates={contractTemplates}
        members={members.map((m) => ({ id: m.user.id, name: m.user.name }))}
      />
      <Tabs tabs={tabs} active={tab} />
      {content}
    </>
  );
}
