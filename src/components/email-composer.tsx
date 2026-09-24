"use client";

import { useState } from "react";
import { Alert, Button, Input, Label, Textarea } from "./ui";

export interface EmailDraft {
  to: string[];
  cc: string[];
  subject: string;
  message: string;
}

function parseList(value: string): string[] {
  return value.split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean);
}

export function EmailComposer({ draft, onSend, onCancel, kind }: { draft: EmailDraft; kind: "initial" | "reminder"; onSend: (d: EmailDraft & { attachPdf: boolean }) => Promise<string | null>; onCancel: () => void }) {
  const [to, setTo] = useState(draft.to.join(", "));
  const [cc, setCc] = useState(draft.cc.join(", "));
  const [subject, setSubject] = useState(draft.subject);
  const [message, setMessage] = useState(draft.message);
  const [attachPdf, setAttachPdf] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setSending(true);
        setError(null);
        const err = await onSend({ to: parseList(to), cc: parseList(cc), subject, message, attachPdf });
        setSending(false);
        if (err) setError(err);
      }}
    >
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div>
        <Label htmlFor="mail-to">To</Label>
        <Input id="mail-to" value={to} onChange={(e) => setTo(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="mail-cc" hint="(optional)">CC</Label>
        <Input id="mail-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="mail-subject">Subject</Label>
        <Input id="mail-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={300} />
      </div>
      <div>
        <Label htmlFor="mail-message">Message</Label>
        <Textarea id="mail-message" rows={9} value={message} onChange={(e) => setMessage(e.target.value)} required />
        <p className="mt-1 text-xs text-slate-500">A secure “View document” button is added automatically. Variables like {"{{contact.firstName}}"} are replaced.</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} /> Attach PDF (if generated)
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={sending}>{sending ? "Sending…" : kind === "reminder" ? "Send reminder" : "Send email"}</Button>
      </div>
    </form>
  );
}
