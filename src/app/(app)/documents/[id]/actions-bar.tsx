"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DocumentStatus } from "@prisma/client";
import {
  archiveAction,
  cancelAction,
  changeOwnerAction,
  convertAction,
  discardDraftAction,
  duplicateAction,
  emailDraftAction,
  primaryAction,
  publishAction,
  publishAndPrepareSendAction,
  revisionAction,
  sendAction,
} from "@/app/actions/documents";
import { Alert, Button, ButtonLink, Label, Select } from "@/components/ui";
import { Modal } from "@/components/modal";
import { EmailComposer, type EmailDraft } from "@/components/email-composer";
import { SubmitButton } from "@/components/forms";
import type { ActionState } from "@/lib/action-state";

const OPEN: DocumentStatus[] = ["PUBLISHED", "SENT", "VIEWED", "AWAITING_SIGNATURE"];

interface Props {
  doc: { id: string; type: "QUOTE" | "CONTRACT"; status: DocumentStatus; hasDraft: boolean; hasPublished: boolean; archived: boolean; isPrimary: boolean; hasDeal: boolean; sent: boolean; pdfUrl: string | null; ownerId: string };
  can: { edit: boolean; publish: boolean; send: boolean; create: boolean; archive: boolean; reviseCompleted: boolean; reviseFromTemplate: boolean; reassign: boolean };
  contractTemplates: { id: string; name: string; isDefault: boolean }[];
  members: { id: string; name: string }[];
}

function FormAction({ action, id, children, variant = "secondary", confirm, extra }: { action: (p: ActionState, f: FormData) => Promise<ActionState>; id: string; children: React.ReactNode; variant?: "primary" | "secondary" | "danger"; confirm?: string; extra?: Record<string, string> }) {
  const [state, formAction] = useActionState(action, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
  return (
    <form action={formAction} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
      <input type="hidden" name="documentId" value={id} />
      {extra ? Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      <SubmitButton variant={variant}>{children}</SubmitButton>
      {state && !state.ok ? <p className="mt-1 max-w-xs text-xs text-red-600" role="alert">{state.error}</p> : null}
    </form>
  );
}

export function DocumentActions({ doc, can, contractTemplates, members }: Props) {
  const router = useRouter();
  const [composer, setComposer] = useState<{ draft: EmailDraft; kind: "initial" | "reminder" } | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [convertOpen, setConvertOpen] = useState(false);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const completed = doc.status === "ACCEPTED" || doc.status === "SIGNED";
  const open = OPEN.includes(doc.status);

  const openComposer = (kind: "initial" | "reminder") =>
    startTransition(async () => {
      const res = await emailDraftAction(doc.id, kind);
      if (res?.ok && res.data) setComposer({ draft: res.data, kind });
      else if (res && !res.ok) setMessage({ tone: "error", text: res.error });
    });

  const publishAndSend = () =>
    startTransition(async () => {
      const res = await publishAndPrepareSendAction(doc.id);
      if (res?.ok && res.data) {
        setComposer({ draft: res.data, kind: "initial" });
        router.refresh();
      } else if (res && !res.ok) setMessage({ tone: "error", text: res.error });
    });

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-start gap-2">
        {can.edit && !doc.archived && doc.hasDraft ? <ButtonLink href={`/documents/${doc.id}/edit`}>Edit</ButtonLink> : null}
        {can.edit && !doc.archived && !doc.hasDraft && doc.hasPublished && (!completed || can.reviseCompleted) ? (
          <FormAction action={revisionAction} id={doc.id} confirm={completed ? "This document is completed. A new revision will be created; the completed version stays unchanged in the history. Continue?" : undefined}>
            Create revision
          </FormAction>
        ) : null}
        <ButtonLink variant="secondary" href={`/documents/${doc.id}/preview`}>Preview</ButtonLink>
        {can.publish && !doc.archived && doc.hasDraft ? (
          <>
            <FormAction action={publishAction} id={doc.id} variant="primary">Publish</FormAction>
            {can.send ? <Button onClick={publishAndSend} disabled={pending}>{pending ? "Working…" : "Publish & Send"}</Button> : null}
          </>
        ) : null}
        {can.send && !doc.archived && doc.hasPublished && open ? (
          <Button variant="secondary" onClick={() => openComposer(doc.sent ? "reminder" : "initial")} disabled={pending}>
            {doc.sent ? "Send reminder" : "Send"}
          </Button>
        ) : null}
        {doc.pdfUrl ? <ButtonLink variant="secondary" href={doc.pdfUrl} prefetch={false}>Download PDF</ButtonLink> : null}
        <details className="relative">
          <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">More ▾</summary>
          <div className="absolute right-0 z-20 mt-1 flex w-64 flex-col gap-2 rounded-md border border-slate-200 bg-white p-3 shadow-lg sm:left-0 sm:right-auto">
            <ButtonLink variant="ghost" href={`/documents/${doc.id}?tab=activity`} className="justify-start">View history</ButtonLink>
            {can.create ? <FormAction action={duplicateAction} id={doc.id}>Duplicate</FormAction> : null}
            {can.create && doc.type === "QUOTE" ? <Button variant="secondary" onClick={() => setConvertOpen(true)}>Convert to contract</Button> : null}
            {can.edit && doc.hasDeal && !doc.isPrimary && !doc.archived ? <FormAction action={primaryAction} id={doc.id}>Mark as primary</FormAction> : null}
            {can.edit && doc.hasDraft && doc.hasPublished ? <FormAction action={discardDraftAction} id={doc.id} confirm="Discard the unpublished changes?">Discard draft</FormAction> : null}
            {can.edit && !doc.hasDraft && doc.hasPublished && can.reviseFromTemplate ? (
              <FormAction action={revisionAction} id={doc.id} extra={{ fromLatestTemplate: "1" }} confirm="Create a new revision using the latest version of the template? Editable content will be reset to the template.">
                Revise from latest template
              </FormAction>
            ) : null}
            {can.reassign ? <Button variant="secondary" onClick={() => setOwnerOpen(true)}>Change owner</Button> : null}
            {can.edit && (open || doc.status === "DRAFT") && !doc.archived ? <FormAction action={cancelAction} id={doc.id} variant="danger" confirm="Cancel this document? The client will no longer be able to accept or sign it.">Cancel document</FormAction> : null}
            {can.archive ? (
              doc.archived ? <FormAction action={archiveAction} id={doc.id} extra={{ archived: "0" }}>Restore</FormAction> : <FormAction action={archiveAction} id={doc.id} confirm="Archive this document? It stays in your records and can be restored.">Archive</FormAction>
            ) : null}
          </div>
        </details>
      </div>
      {message ? <div className="mt-3"><Alert tone={message.tone}>{message.text}</Alert></div> : null}

      <Modal open={Boolean(composer)} onClose={() => setComposer(null)} title={composer?.kind === "reminder" ? "Send reminder" : "Send document"} wide>
        {composer ? (
          <EmailComposer
            draft={composer.draft}
            kind={composer.kind}
            onCancel={() => setComposer(null)}
            onSend={async (d) => {
              const res = await sendAction({ documentId: doc.id, ...d, kind: composer.kind });
              if (!res?.ok) return res?.error ?? "Could not send";
              setComposer(null);
              setMessage({ tone: "success", text: res.message ?? "Sent." });
              router.refresh();
              return null;
            }}
          />
        ) : null}
      </Modal>

      <Modal open={convertOpen} onClose={() => setConvertOpen(false)} title="Convert quote to contract">
        <ConvertForm id={doc.id} templates={contractTemplates} />
      </Modal>
      <Modal open={ownerOpen} onClose={() => setOwnerOpen(false)} title="Change owner">
        <OwnerForm id={doc.id} members={members} current={doc.ownerId} onDone={() => setOwnerOpen(false)} />
      </Modal>
    </div>
  );
}

function ConvertForm({ id, templates }: { id: string; templates: { id: string; name: string; isDefault: boolean }[] }) {
  const [state, action] = useActionState(convertAction, null);
  if (!templates.length) return <Alert tone="warning">Publish a contract template first.</Alert>;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="documentId" value={id} />
      <p className="text-sm text-slate-600">A new contract is created from this quote (client, deal, products, prices and custom fields). The quote itself is not modified.</p>
      <div>
        <Label htmlFor="convert-template">Contract template</Label>
        <Select id="convert-template" name="templateId" defaultValue={(templates.find((t) => t.isDefault) ?? templates[0])!.id}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </div>
      {state && !state.ok ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton pendingLabel="Creating contract…">Create contract</SubmitButton>
    </form>
  );
}

function OwnerForm({ id, members, current, onDone }: { id: string; members: { id: string; name: string }[]; current: string; onDone: () => void }) {
  const [state, action] = useActionState(changeOwnerAction, null);
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) {
      router.refresh();
      onDone();
    }
  }, [state, router, onDone]);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="documentId" value={id} />
      <Select name="ownerId" defaultValue={current} aria-label="New owner">
        {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </Select>
      {state && !state.ok ? <Alert tone="error">{state.error}</Alert> : null}
      <SubmitButton>Save</SubmitButton>
    </form>
  );
}
