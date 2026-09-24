"use client";

import { useRef, useState } from "react";
import type { Block, BlockProps, BlockType } from "@/domain/blocks";
import type { VariableDefinition } from "@/domain/variables";
import { Button, Input, Label, Select, Textarea } from "../ui";
import { RichTextEditor } from "./rich-text";
import { VariablePicker, insertAtCaret } from "./variable-picker";

export const BLOCK_LABELS: Record<BlockType, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  richText: "Rich text",
  logo: "Logo",
  image: "Image",
  divider: "Divider",
  spacer: "Spacer",
  companyInfo: "Company information",
  clientInfo: "Client information",
  dealInfo: "Deal information",
  dynamicProperty: "Dynamic property",
  productTable: "Product table",
  pricingSummary: "Pricing summary",
  taxes: "Taxes",
  discount: "Discount",
  fees: "Fees",
  customTable: "Custom table",
  terms: "Terms & conditions",
  clause: "Clause",
  conditionalSection: "Conditional section",
  signatureArea: "Signature area",
  acceptanceArea: "Acceptance area",
  pageBreak: "Page break",
  customSection: "Custom section",
};

type Props<T extends BlockType> = {
  block: Block<T>;
  onChange: (props: BlockProps<T>) => void;
  variables: VariableDefinition[];
};

function TextWithVariables({ id, label, value, onChange, variables, multiline, rows = 4 }: { id: string; label: string; value: string; onChange: (v: string) => void; variables: VariableDefinition[]; multiline?: boolean; rows?: number }) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <VariablePicker compact variables={variables} onPick={(key) => onChange(insertAtCaret(ref.current, value, `{{${key}}}`))} label="Variable" />
      </div>
      {multiline ? (
        <Textarea id={id} ref={ref} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} ref={ref} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function AlignSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: "left" | "center" | "right") => void }) {
  return (
    <div>
      <Label htmlFor={id}>Alignment</Label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as "left" | "center" | "right")}>
        <option value="left">Left</option>
        <option value="center">Center</option>
        <option value="right">Right</option>
      </Select>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function ImageUpload({ fileId, onUploaded }: { fileId: string | null; onUploaded: (id: string | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      {fileId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/files/${fileId}`} alt="" className="max-h-32 rounded border border-slate-200" />
      ) : null}
      <input
        type="file"
        accept="image/png,image/jpeg"
        aria-label="Upload image"
        className="text-sm"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          const body = new FormData();
          body.set("file", file);
          const res = await fetch("/api/uploads/image", { method: "POST", body });
          const json = await res.json().catch(() => null);
          setBusy(false);
          if (!res.ok) setError(json?.error?.message ?? "Upload failed");
          else onUploaded(json.fileId);
        }}
      />
      {busy ? <p className="text-xs text-slate-500">Uploading…</p> : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {fileId ? <Button type="button" size="sm" variant="ghost" onClick={() => onUploaded(null)}>Remove image</Button> : null}
    </div>
  );
}

/** Property editor for one block (shared by the template builder and the document editor). */
export function BlockPropsEditor({ block, onChange, variables }: Props<BlockType>) {
  const id = `blk-${block.id}`;
  const p = block.props as Record<string, unknown>;
  const set = (patch: Record<string, unknown>) => onChange({ ...p, ...patch } as BlockProps<BlockType>);
  switch (block.type) {
    case "heading":
      return (
        <div className="space-y-3">
          <TextWithVariables id={`${id}-text`} label="Text" value={String(p.text)} onChange={(v) => set({ text: v })} variables={variables} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor={`${id}-level`}>Size</Label>
              <Select id={`${id}-level`} value={String(p.level)} onChange={(e) => set({ level: Number(e.target.value) })}>
                <option value="1">Title</option>
                <option value="2">Section</option>
                <option value="3">Subsection</option>
              </Select>
            </div>
            <AlignSelect id={`${id}-align`} value={String(p.align)} onChange={(v) => set({ align: v })} />
          </div>
        </div>
      );
    case "paragraph":
      return (
        <div className="space-y-3">
          <TextWithVariables id={`${id}-text`} label="Text" value={String(p.text)} onChange={(v) => set({ text: v })} variables={variables} multiline />
          <AlignSelect id={`${id}-align`} value={String(p.align)} onChange={(v) => set({ align: v })} />
        </div>
      );
    case "richText":
      return <RichTextEditor label="Content" value={String(p.html)} onChange={(html) => set({ html })} variables={variables} />;
    case "terms":
    case "clause":
      return (
        <div className="space-y-3">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <RichTextEditor label="Content" value={String(p.html)} onChange={(html) => set({ html })} variables={variables} />
        </div>
      );
    case "logo":
      return (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">Uses the company logo from Settings → Branding.</p>
          <AlignSelect id={`${id}-align`} value={String(p.align)} onChange={(v) => set({ align: v })} />
          <div>
            <Label htmlFor={`${id}-h`}>Max height (px)</Label>
            <Input id={`${id}-h`} type="number" min={16} max={200} value={Number(p.maxHeight)} onChange={(e) => set({ maxHeight: Math.min(200, Math.max(16, Number(e.target.value) || 56)) })} />
          </div>
        </div>
      );
    case "image":
      return (
        <div className="space-y-3">
          <ImageUpload fileId={(p.fileId as string | null) ?? null} onUploaded={(fileId) => set({ fileId })} />
          <div>
            <Label htmlFor={`${id}-alt`}>Alternative text</Label>
            <Input id={`${id}-alt`} value={String(p.alt)} onChange={(e) => set({ alt: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor={`${id}-w`}>Width</Label>
              <Select id={`${id}-w`} value={String(p.width)} onChange={(e) => set({ width: e.target.value })}>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="full">Full width</option>
              </Select>
            </div>
            <AlignSelect id={`${id}-align`} value={String(p.align)} onChange={(v) => set({ align: v })} />
          </div>
        </div>
      );
    case "spacer":
      return (
        <div>
          <Label htmlFor={`${id}-size`}>Size</Label>
          <Select id={`${id}-size`} value={String(p.size)} onChange={(e) => set({ size: e.target.value })}>
            <option value="sm">Small</option>
            <option value="md">Medium</option>
            <option value="lg">Large</option>
          </Select>
        </div>
      );
    case "divider":
    case "pageBreak":
      return <p className="text-sm text-slate-500">No settings.</p>;
    case "companyInfo":
      return (
        <div className="space-y-2">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <Check label="Show address" checked={Boolean(p.showAddress)} onChange={(v) => set({ showAddress: v })} />
          <Check label="Show contact details" checked={Boolean(p.showContact)} onChange={(v) => set({ showContact: v })} />
          <Check label="Show registration / VAT" checked={Boolean(p.showTaxIds)} onChange={(v) => set({ showTaxIds: v })} />
        </div>
      );
    case "clientInfo":
      return (
        <div className="space-y-2">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <Check label="Show address" checked={Boolean(p.showAddress)} onChange={(v) => set({ showAddress: v })} />
          <Check label="Show email" checked={Boolean(p.showEmail)} onChange={(v) => set({ showEmail: v })} />
          <Check label="Show phone" checked={Boolean(p.showPhone)} onChange={(v) => set({ showPhone: v })} />
        </div>
      );
    case "dealInfo": {
      const fields = (p.fields as string[]) ?? [];
      return (
        <div className="space-y-2">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <p className="text-sm font-medium text-slate-700">Fields</p>
          <ul className="space-y-1">
            {fields.map((f, i) => (
              <li key={`${f}-${i}`} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1 text-sm">
                <span>{variables.find((v) => v.key === f)?.label ?? f} <span className="font-mono text-[10px] text-slate-400">{f}</span></span>
                <button type="button" aria-label={`Remove ${f}`} className="text-slate-400 hover:text-red-600" onClick={() => set({ fields: fields.filter((_, j) => j !== i) })}>✕</button>
              </li>
            ))}
          </ul>
          <VariablePicker variables={variables} onPick={(key) => set({ fields: [...fields, key] })} label="Add field" />
        </div>
      );
    }
    case "dynamicProperty":
      return (
        <div className="space-y-3">
          <div>
            <Label htmlFor={`${id}-label`}>Label</Label>
            <Input id={`${id}-label`} value={String(p.label)} onChange={(e) => set({ label: e.target.value })} />
          </div>
          <div>
            <Label htmlFor={`${id}-var`}>Property</Label>
            <Select id={`${id}-var`} value={String(p.variable)} onChange={(e) => set({ variable: e.target.value })}>
              <option value="">Select…</option>
              {variables.map((v) => <option key={v.key} value={v.key}>{v.group} → {v.label}</option>)}
            </Select>
          </div>
        </div>
      );
    case "productTable":
      return (
        <div className="space-y-2">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <Check label="Show descriptions" checked={Boolean(p.showDescription)} onChange={(v) => set({ showDescription: v })} />
          <Check label="Show SKU" checked={Boolean(p.showSku)} onChange={(v) => set({ showSku: v })} />
          <Check label="Show discounts" checked={Boolean(p.showDiscount)} onChange={(v) => set({ showDiscount: v })} />
          <Check label="Show taxes per line" checked={Boolean(p.showTaxes)} onChange={(v) => set({ showTaxes: v })} />
        </div>
      );
    case "pricingSummary":
      return (
        <div className="space-y-2">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <Check label="Show each tax separately" checked={Boolean(p.showTaxBreakdown)} onChange={(v) => set({ showTaxBreakdown: v })} />
        </div>
      );
    case "taxes":
    case "discount":
    case "fees":
    case "conditionalSection":
    case "customSection":
      return <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />;
    case "signatureArea":
    case "acceptanceArea":
      return (
        <div className="space-y-3">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <TextWithVariables id={`${id}-text`} label="Text" value={String(p.text)} onChange={(v) => set({ text: v })} variables={variables} multiline rows={3} />
        </div>
      );
    case "customTable": {
      const columns = (p.columns as string[]) ?? [];
      const rows = (p.rows as string[][]) ?? [];
      return (
        <div className="space-y-2">
          <TextWithVariables id={`${id}-title`} label="Title" value={String(p.title)} onChange={(v) => set({ title: v })} variables={variables} />
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  {columns.map((c, ci) => (
                    <th key={ci} className="p-0.5">
                      <Input aria-label={`Column ${ci + 1}`} value={c} onChange={(e) => set({ columns: columns.map((x, j) => (j === ci ? e.target.value : x)) })} className="px-1 py-1 text-xs font-semibold" />
                    </th>
                  ))}
                  <th>
                    <button type="button" className="px-1 text-slate-500" aria-label="Add column" disabled={columns.length >= 12} onClick={() => set({ columns: [...columns, `Column ${columns.length + 1}`], rows: rows.map((r) => [...r, ""]) })}>+</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    {columns.map((_, ci) => (
                      <td key={ci} className="p-0.5">
                        <Input aria-label={`Row ${ri + 1} column ${ci + 1}`} value={r[ci] ?? ""} onChange={(e) => set({ rows: rows.map((row, j) => (j === ri ? columns.map((__, k) => (k === ci ? e.target.value : row[k] ?? "")) : row)) })} className="px-1 py-1 text-xs" />
                      </td>
                    ))}
                    <td>
                      <button type="button" className="px-1 text-slate-400 hover:text-red-600" aria-label={`Remove row ${ri + 1}`} onClick={() => set({ rows: rows.filter((_, j) => j !== ri) })}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => set({ rows: [...rows, columns.map(() => "")] })}>+ Row</Button>
            {columns.length > 1 ? <Button type="button" size="sm" variant="ghost" onClick={() => set({ columns: columns.slice(0, -1), rows: rows.map((r) => r.slice(0, columns.length - 1)) })}>Remove last column</Button> : null}
          </div>
        </div>
      );
    }
  }
}
