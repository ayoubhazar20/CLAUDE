"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { attachmentAction } from "@/app/actions/documents";
import { InlineAction } from "@/components/forms";
import { Alert, Badge, Button, EmptyState, Select, Table, Td, Th } from "@/components/ui";

interface Item {
  id: string;
  name: string;
  visibility: "INTERNAL" | "CLIENT";
  fileId: string;
  size: number;
  createdAt: string;
}

export function AttachmentsPanel({ documentId, canEdit, attachments }: { documentId: string; canEdit: boolean; attachments: Item[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [visibility, setVisibility] = useState<"INTERNAL" | "CLIENT">("INTERNAL");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const router = useRouter();

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    const body = new FormData();
    body.set("file", file);
    body.set("visibility", visibility);
    const res = await fetch(`/api/documents/${documentId}/attachments`, { method: "POST", body });
    setUploading(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error?.message ?? "Upload failed");
      return;
    }
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {canEdit ? (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
          <label className="sr-only" htmlFor="attachment-file">File</label>
          <input id="attachment-file" ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.xlsx,.pptx,.txt,.csv" className="text-sm" />
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as "INTERNAL" | "CLIENT")} className="sm:w-48" aria-label="Visibility">
            <option value="INTERNAL">Internal only</option>
            <option value="CLIENT">Visible to client</option>
          </Select>
          <Button onClick={upload} disabled={uploading}>{uploading ? "Uploading…" : "Upload"}</Button>
          <p className="text-xs text-slate-500 sm:ml-auto">PDF, images, Office documents · max 15 MB</p>
        </div>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {attachments.length === 0 ? (
        <EmptyState title="No attachments" description="Attach specifications, brochures or supporting documents." />
      ) : (
        <Table>
          <thead className="bg-slate-50"><tr><Th>File</Th><Th>Visibility</Th><Th>Added</Th><Th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {attachments.map((a) => (
              <tr key={a.id}>
                <Td><a href={`/api/files/${a.fileId}`} className="font-medium text-brand-700 underline">{a.name}</a><div className="text-xs text-slate-500">{Math.ceil(a.size / 1024)} KB</div></Td>
                <Td><Badge tone={a.visibility === "CLIENT" ? "blue" : "gray"}>{a.visibility === "CLIENT" ? "Visible to client" : "Internal only"}</Badge></Td>
                <Td className="text-xs">{a.createdAt}</Td>
                <Td className="space-x-2 whitespace-nowrap text-right">
                  {canEdit ? (
                    <>
                      <InlineAction action={attachmentAction} hidden={{ attachmentId: a.id, op: a.visibility === "CLIENT" ? "internal" : "client" }}>
                        {a.visibility === "CLIENT" ? "Make internal" : "Share with client"}
                      </InlineAction>
                      <InlineAction action={attachmentAction} hidden={{ attachmentId: a.id, op: "archive" }} variant="danger" confirm="Remove this attachment?">Remove</InlineAction>
                    </>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
