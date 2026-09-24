"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Block, BlockProps, BlockType } from "@/domain/blocks";
import { createBlock } from "@/domain/blocks";
import type { DocumentData, RecipientData } from "@/domain/document-data";
import { calculatePricing, PricingError, type PricingConfig, type PricingTotals } from "@/domain/pricing";
import { resolveDocument, type ResolveInput } from "@/domain/resolve";
import { renderDocumentHtml } from "@/domain/render-html";
import { formatMoney } from "@/domain/money";
import { CURRENCY_CODES } from "@/domain/currencies";
import type { VariableDefinition } from "@/domain/variables";
import { Alert, Badge, Button, Input, Label, Select, Textarea, cn } from "../ui";
import { DocumentFrame } from "../document-frame";
import { BLOCK_LABELS, BlockPropsEditor } from "./block-fields";

export interface EditorLine {
  id: string;
  source: "HUBSPOT_LINE_ITEM" | "HUBSPOT_PRODUCT" | "CUSTOM";
  hubspotLineItemId: string | null;
  hubspotProductId: string | null;
  sku: string | null;
  name: string;
  description: string | null;
  category: string | null;
  quantity: string;
  unitPrice: string;
  discountType: "NONE" | "PERCENT" | "AMOUNT";
  discountValue: string;
  taxKeys: string[];
  optional: boolean;
}

export interface CustomFieldDef {
  key: string;
  label: string;
  type: "TEXT" | "LONG_TEXT" | "NUMBER" | "DATE" | "BOOLEAN" | "SELECT";
  options: string[];
  required: boolean;
}

export interface DocumentEditorProps {
  documentId: string;
  number: string;
  type: "QUOTE" | "CONTRACT";
  versionNumber: number;
  publicToken: string;
  acceptanceMode: "ACCEPTANCE_ONLY" | "SIGNATURE_REQUIRED";
  hasPublished: boolean;
  initial: {
    title: string;
    blocks: Block[];
    data: DocumentData;
    lines: EditorLine[];
    pricing: PricingConfig;
    currency: string;
    expiresAt: string | null;
    updatedAt: string;
  };
  organization: ResolveInput["organization"];
  timezone: string;
  variables: VariableDefinition[];
  customFields: CustomFieldDef[];
  /** HubSpot deal data (via Zapier): NOT_REQUESTED | REQUESTED | APPLIED | PENDING_REVIEW */
  dealData: { dealId: string | null; status: string };
  canPublish: boolean;
}

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

const ADDABLE: BlockType[] = ["heading", "paragraph", "richText", "clause", "customTable", "image", "divider", "spacer", "pageBreak"];

const uuid = () => crypto.randomUUID();
const decimalOk = (v: string) => /^\d{1,14}(\.\d{1,6})?$/.test(v.trim());

function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  const map: Record<SaveState, { text: string; cls: string }> = {
    saved: { text: "Saved", cls: "text-emerald-700" },
    dirty: { text: "Unsaved changes", cls: "text-slate-500" },
    saving: { text: "Saving…", cls: "text-slate-500" },
    error: { text: "Save failed", cls: "text-red-600" },
    conflict: { text: "Save failed", cls: "text-red-600" },
  };
  return (
    <span className={cn("text-sm font-medium", map[state].cls)} role="status" aria-live="polite" title={error ?? undefined}>
      {map[state].text}
    </span>
  );
}

export function DocumentEditor(props: DocumentEditorProps) {
  const router = useRouter();
  const [title, setTitle] = useState(props.initial.title);
  const [blocks, setBlocks] = useState<Block[]>(props.initial.blocks);
  const [data, setData] = useState<DocumentData>(props.initial.data);
  const [lines, setLines] = useState<EditorLine[]>(props.initial.lines);
  const [pricing, setPricing] = useState<PricingConfig>(props.initial.pricing);
  const [currency, setCurrency] = useState(props.initial.currency);
  const [expiresAt, setExpiresAt] = useState<string | null>(props.initial.expiresAt);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [dealDataStatus, setDealDataStatus] = useState(props.dealData.status);
  const baseUpdatedAt = useRef(props.initial.updatedAt);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const inFlight = useRef(false);

  const markDirty = useCallback(() => {
    version.current += 1;
    setSaveState((s) => (s === "conflict" ? s : "dirty"));
  }, []);

  // Wrap setters so every edit schedules an autosave.
  const edit = <T,>(setter: React.Dispatch<React.SetStateAction<T>>) => (value: React.SetStateAction<T>) => {
    setter(value);
    markDirty();
  };
  const setTitleE = edit(setTitle);
  const setBlocksE = edit(setBlocks);
  const setDataE = edit(setData);
  const setLinesE = edit(setLines);
  const setPricingE = edit(setPricing);
  const setCurrencyE = edit(setCurrency);
  const setExpiresE = edit(setExpiresAt);

  const lineProblems = useMemo(() => lines.filter((l) => !l.name.trim() || !decimalOk(l.quantity) || !decimalOk(l.unitPrice) || (l.discountType !== "NONE" && !decimalOk(l.discountValue))).map((l) => l.id), [lines]);

  const totals: PricingTotals | null = useMemo(() => {
    try {
      const valid = lines.filter((l) => !lineProblems.includes(l.id));
      return calculatePricing(valid.map((l) => ({ key: l.id, quantity: l.quantity, unitPrice: l.unitPrice, discountType: l.discountType, discountValue: l.discountValue || "0", taxKeys: l.taxKeys, optional: l.optional })), pricing, currency);
    } catch (e) {
      if (e instanceof PricingError) return null;
      return null;
    }
  }, [lines, pricing, currency, lineProblems]);

  const save = useCallback(async () => {
    if (inFlight.current || savedVersion.current === version.current) return;
    if (lineProblems.length) {
      setSaveState("error");
      setSaveError("Fix the highlighted product lines to save.");
      return;
    }
    inFlight.current = true;
    const target = version.current;
    setSaveState("saving");
    try {
      const res = await fetch(`/api/documents/${props.documentId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUpdatedAt: baseUpdatedAt.current,
          title,
          blocks,
          data,
          pricingConfig: pricing,
          currency,
          expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
          lineItems: lines.map((l) => ({ ...l, discountValue: l.discountType === "NONE" ? "0" : l.discountValue })),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const code = json?.error?.code;
        setSaveState(code === "STALE_DRAFT" || code === "NO_DRAFT" ? "conflict" : "error");
        const violations = json?.error?.details?.violations as string[] | undefined;
        setSaveError((json?.error?.message ?? "Save failed") + (violations?.length ? ` ${violations[0]}` : ""));
        return;
      }
      baseUpdatedAt.current = json.updatedAt;
      savedVersion.current = target;
      setSaveError(null);
      setSaveState(version.current === target ? "saved" : "dirty");
    } catch {
      setSaveState("error");
      setSaveError("Connection lost — changes will be retried.");
    } finally {
      inFlight.current = false;
    }
  }, [props.documentId, title, blocks, data, pricing, currency, expiresAt, lines, lineProblems]);

  // Debounced autosave + retry after failures.
  useEffect(() => {
    if (saveState === "dirty") {
      const t = setTimeout(() => void save(), 1200);
      return () => clearTimeout(t);
    }
    if (saveState === "error" && !lineProblems.length) {
      const t = setTimeout(() => void save(), 5000);
      return () => clearTimeout(t);
    }
  }, [saveState, save, lineProblems.length]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (savedVersion.current !== version.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // HubSpot data is delivered asynchronously by Zapier: poll while it is being requested.
  useEffect(() => {
    if (dealDataStatus !== "REQUESTED") return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/documents/${props.documentId}/deal-data`).catch(() => null);
      const json = res?.ok ? await res.json().catch(() => null) : null;
      if (!json || json.status === "REQUESTED") return;
      setDealDataStatus(json.status);
      // Imported into an untouched draft: reload to show it (nothing local to lose).
      if (json.status === "APPLIED" && savedVersion.current === version.current) window.location.reload();
    }, 4000);
    return () => clearInterval(timer);
  }, [dealDataStatus, props.documentId]);

  // ── Preview ──
  const previewHtml = useMemo(() => {
    if (!totals) return "";
    try {
      const resolved = resolveDocument({
        blocks,
        data,
        lineItems: lines.filter((l) => !lineProblems.includes(l.id)).map((l) => ({ key: l.id, name: l.name, description: l.description, sku: l.sku, category: l.category, quantity: l.quantity, unitPrice: l.unitPrice, discountType: l.discountType, discountValue: l.discountValue || "0", taxKeys: l.taxKeys, optional: l.optional })),
        pricingConfig: pricing,
        totals,
        currency,
        organization: props.organization,
        document: { type: props.type, number: props.number, title, versionNumber: props.versionNumber, date: new Date(), expiresAt: expiresAt ? new Date(`${expiresAt}T12:00:00Z`) : null, url: `/d/${props.publicToken}`, acceptanceMode: props.acceptanceMode },
        recipients: data.recipients.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, signingOrder: r.signingOrder })),
        signatures: [],
        timezone: props.timezone,
        imageUrl: (id) => `/api/files/${id}`,
        showMissingVariables: true,
      });
      return renderDocumentHtml(resolved, { blockAttributes: true });
    } catch {
      return "";
    }
  }, [blocks, data, lines, lineProblems, pricing, totals, currency, title, expiresAt, props]);

  // ── Blocks ──
  const updateBlock = (id: string, patch: (b: Block) => Block) => {
    const walk = (list: Block[]): Block[] => list.map((b) => (b.id === id ? patch(b) : b.children ? { ...b, children: walk(b.children) } : b));
    setBlocksE((prev) => walk(prev));
  };
  const removeBlock = (id: string) => {
    const walk = (list: Block[]): Block[] => list.filter((b) => b.id !== id).map((b) => (b.children ? { ...b, children: walk(b.children) } : b));
    setBlocksE((prev) => walk(prev));
  };
  const moveBlock = (id: string, dir: -1 | 1) => {
    const walk = (list: Block[]): Block[] => {
      const i = list.findIndex((b) => b.id === id);
      if (i >= 0) {
        const j = i + dir;
        if (j < 0 || j >= list.length) return list;
        const next = [...list];
        [next[i], next[j]] = [next[j]!, next[i]!];
        return next;
      }
      return list.map((b) => (b.children ? { ...b, children: walk(b.children) } : b));
    };
    setBlocksE((prev) => walk(prev));
  };

  const setContact = (patch: Partial<DocumentData["contact"]>) => setDataE((d) => ({ ...d, contact: { ...d.contact, ...patch } }));
  const setCompany = (patch: Partial<DocumentData["company"]>) => setDataE((d) => ({ ...d, company: { ...d.company, ...patch } }));
  const setRecipients = (recipients: RecipientData[]) => setDataE((d) => ({ ...d, recipients }));

  const updateLine = (id: string, patch: Partial<EditorLine>) => setLinesE((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const defaultTaxKeys = pricing.taxes.map((t) => t.key);
  const addCustomLine = () =>
    setLinesE((prev) => [...prev, { id: uuid(), source: "CUSTOM", hubspotLineItemId: null, hubspotProductId: null, sku: null, name: "New item", description: null, category: null, quantity: "1", unitPrice: "0", discountType: "NONE", discountValue: "0", taxKeys: defaultTaxKeys, optional: false }]);

  const lineTotal = (id: string) => totals?.lines.find((l) => l.key === id)?.net;

  const renderBlockCard = (block: Block, depth = 0): React.ReactNode => {
    const isSelected = selected === block.id;
    return (
      <div key={block.id} className={cn("rounded-md border bg-white", block.locked ? "locked-block border-slate-300" : "border-slate-200", isSelected && !block.locked ? "ring-2 ring-brand-500/40" : "", depth ? "ml-4" : "")}>
        <div className="flex items-center gap-2 px-3 py-2">
          <button type="button" className="flex-1 text-left text-sm" onClick={() => setSelected(isSelected ? null : block.id)} aria-expanded={isSelected} disabled={block.locked}>
            <span className="font-medium">{BLOCK_LABELS[block.type]}</span>
            {block.condition ? <span className="ml-2"><Badge tone="purple">Conditional</Badge></span> : null}
            {block.locked ? (
              <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-slate-600" title="Locked by your administrator — cannot be edited">
                <LockIcon /> Locked
              </span>
            ) : null}
            <span className="ml-2 truncate text-xs text-slate-500">{summary(block)}</span>
          </button>
          {!block.locked ? (
            <div className="flex items-center gap-0.5">
              <IconButton label="Move up" onClick={() => moveBlock(block.id, -1)}>↑</IconButton>
              <IconButton label="Move down" onClick={() => moveBlock(block.id, 1)}>↓</IconButton>
              <IconButton label="Remove block" onClick={() => { if (window.confirm("Remove this section?")) removeBlock(block.id); }} danger>✕</IconButton>
            </div>
          ) : null}
        </div>
        {isSelected && !block.locked ? (
          <div className="border-t border-slate-100 px-3 py-3">
            <BlockPropsEditor block={block} variables={props.variables} onChange={(p) => updateBlock(block.id, (b) => ({ ...b, props: p as BlockProps<BlockType> }))} />
          </div>
        ) : null}
        {block.children?.length ? <div className="space-y-2 px-3 pb-3">{block.children.map((c) => renderBlockCard(c, depth + 1))}</div> : null}
      </div>
    );
  };

  const signers = data.recipients;

  return (
    <div>
      <div className="sticky top-0 z-30 -mx-4 mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="min-w-0">
          <Link href={`/documents/${props.documentId}`} className="text-sm text-slate-500 hover:text-slate-800">← {props.number}</Link>
          <p className="text-xs text-slate-500">Editing version {props.versionNumber} · draft</p>
        </div>
        <div className="flex items-center gap-3">
          <SaveIndicator state={saveState} error={saveError} />
          <Button variant="secondary" size="sm" className="xl:hidden" onClick={() => setShowPreview((s) => !s)}>{showPreview ? "Edit" : "Preview"}</Button>
          <Button
            size="sm"
            onClick={async () => {
              await save();
              router.push(`/documents/${props.documentId}`);
            }}
          >
            {props.canPublish ? "Review & publish" : "Done"}
          </Button>
        </div>
      </div>
      {props.dealData.dealId && dealDataStatus === "REQUESTED" ? (
        <div className="mb-4"><Alert tone="info" title="Importing HubSpot data…">Waiting for Zapier to send the deal’s contact, company and line items (HubSpot deal #{props.dealData.dealId}). This page updates automatically — edits you make now are kept, and the HubSpot data will then wait for your review.</Alert></div>
      ) : dealDataStatus === "PENDING_REVIEW" ? (
        <div className="mb-4"><Alert tone="warning" title="New HubSpot data available">HubSpot data arrived for this document. Your edits were kept. <Link className="font-semibold underline" href={`/documents/${props.documentId}?tab=hubspot`}>Review and choose what to update</Link></Alert></div>
      ) : null}
      {saveState === "conflict" ? (
        <div className="mb-4"><Alert tone="error" title="Could not save">{saveError} <button className="font-semibold underline" onClick={() => router.refresh()}>Reload</button></Alert></div>
      ) : saveState === "error" && saveError ? (
        <div className="mb-4"><Alert tone="error">{saveError}</Alert></div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <div className={cn("space-y-5", showPreview ? "hidden xl:block" : "")}>
          <Section title="Details">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label htmlFor="doc-title">Title</Label>
                <Input id="doc-title" value={title} maxLength={200} onChange={(e) => setTitleE(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="doc-currency">Currency</Label>
                <Select id="doc-currency" value={currency} onChange={(e) => setCurrencyE(e.target.value)}>
                  {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
                {currency !== props.initial.currency ? <p className="mt-1 text-xs text-amber-700">Prices are not converted — review them.</p> : null}
              </div>
              <div>
                <Label htmlFor="doc-expires">Expiration date</Label>
                <Input id="doc-expires" type="date" value={expiresAt ?? ""} onChange={(e) => setExpiresE(e.target.value || null)} />
              </div>
            </div>
          </Section>

          <Section title={props.type === "CONTRACT" || props.acceptanceMode === "SIGNATURE_REQUIRED" ? "Recipients & signatories" : "Recipients"}>
            <p className="mb-3 text-xs text-slate-500">
              {props.type === "QUOTE" && props.acceptanceMode === "ACCEPTANCE_ONLY" ? "Any signer can accept the quote after verifying their email." : "Every required signer must sign. Order applies when the template uses sequential signing."}
            </p>
            <div className="space-y-2">
              {signers.map((r, i) => (
                <div key={r.id} className="grid grid-cols-12 items-end gap-2 rounded border border-slate-200 p-2">
                  <div className="col-span-12 sm:col-span-4">
                    <Label htmlFor={`r-name-${r.id}`}>Name</Label>
                    <Input id={`r-name-${r.id}`} value={r.name} onChange={(e) => setRecipients(signers.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))} />
                  </div>
                  <div className="col-span-12 sm:col-span-4">
                    <Label htmlFor={`r-email-${r.id}`}>Email</Label>
                    <Input id={`r-email-${r.id}`} type="email" value={r.email} onChange={(e) => setRecipients(signers.map((x) => (x.id === r.id ? { ...x, email: e.target.value.trim().toLowerCase() } : x)))} />
                  </div>
                  <div className="col-span-5 sm:col-span-2">
                    <Label htmlFor={`r-role-${r.id}`}>Role</Label>
                    <Select id={`r-role-${r.id}`} value={r.role} onChange={(e) => setRecipients(signers.map((x) => (x.id === r.id ? { ...x, role: e.target.value as RecipientData["role"] } : x)))}>
                      <option value="SIGNER">Signer</option>
                      <option value="CC">CC</option>
                    </Select>
                  </div>
                  <div className="col-span-4 sm:col-span-1">
                    <Label htmlFor={`r-order-${r.id}`}>Order</Label>
                    <Input id={`r-order-${r.id}`} type="number" min={1} max={20} value={r.signingOrder} onChange={(e) => setRecipients(signers.map((x) => (x.id === r.id ? { ...x, signingOrder: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } : x)))} />
                  </div>
                  <div className="col-span-3 flex justify-end sm:col-span-1">
                    <IconButton label={`Remove recipient ${i + 1}`} danger onClick={() => setRecipients(signers.filter((x) => x.id !== r.id))}>✕</IconButton>
                  </div>
                </div>
              ))}
              <Button type="button" size="sm" variant="secondary" onClick={() => setRecipients([...signers, { id: uuid(), name: "", email: "", role: "SIGNER", signingOrder: signers.length + 1, required: true, hubspotContactId: null }])}>
                + Add recipient
              </Button>
            </div>
          </Section>

          <Section title="Products & pricing">
            <div className="space-y-2">
              {lines.map((l, i) => {
                const bad = lineProblems.includes(l.id);
                return (
                  <div key={l.id} className={cn("rounded border p-2", bad ? "border-red-300 bg-red-50" : "border-slate-200")}>
                    <div className="grid grid-cols-12 gap-2">
                      <div className="col-span-12 sm:col-span-6">
                        <Label htmlFor={`l-name-${l.id}`}>Item {l.source !== "CUSTOM" ? <span className="text-xs font-normal text-slate-500">(from HubSpot — edits stay in this document)</span> : null}</Label>
                        <Input id={`l-name-${l.id}`} value={l.name} onChange={(e) => updateLine(l.id, { name: e.target.value })} />
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <Label htmlFor={`l-qty-${l.id}`}>Qty</Label>
                        <Input id={`l-qty-${l.id}`} inputMode="decimal" value={l.quantity} onChange={(e) => updateLine(l.id, { quantity: e.target.value.replace(",", ".") })} />
                      </div>
                      <div className="col-span-8 sm:col-span-4">
                        <Label htmlFor={`l-price-${l.id}`}>Unit price ({currency})</Label>
                        <Input id={`l-price-${l.id}`} inputMode="decimal" value={l.unitPrice} onChange={(e) => updateLine(l.id, { unitPrice: e.target.value.replace(",", ".") })} />
                      </div>
                      <div className="col-span-12">
                        <Label htmlFor={`l-desc-${l.id}`}>Description</Label>
                        <Textarea id={`l-desc-${l.id}`} rows={2} value={l.description ?? ""} onChange={(e) => updateLine(l.id, { description: e.target.value || null })} />
                      </div>
                      <div className="col-span-6 sm:col-span-3">
                        <Label htmlFor={`l-dt-${l.id}`}>Discount</Label>
                        <Select id={`l-dt-${l.id}`} value={l.discountType} onChange={(e) => updateLine(l.id, { discountType: e.target.value as EditorLine["discountType"] })}>
                          <option value="NONE">None</option>
                          <option value="PERCENT">Percent</option>
                          <option value="AMOUNT">Amount</option>
                        </Select>
                      </div>
                      {l.discountType !== "NONE" ? (
                        <div className="col-span-6 sm:col-span-3">
                          <Label htmlFor={`l-dv-${l.id}`}>{l.discountType === "PERCENT" ? "Discount %" : `Discount (${currency})`}</Label>
                          <Input id={`l-dv-${l.id}`} inputMode="decimal" value={l.discountValue} onChange={(e) => updateLine(l.id, { discountValue: e.target.value.replace(",", ".") })} />
                        </div>
                      ) : null}
                      <div className="col-span-12 sm:col-span-4">
                        <Label htmlFor={`l-cat-${l.id}`} hint="(for conditional sections)">Category</Label>
                        <Input id={`l-cat-${l.id}`} value={l.category ?? ""} onChange={(e) => updateLine(l.id, { category: e.target.value || null })} />
                      </div>
                      {pricing.taxes.length ? (
                        <fieldset className="col-span-12 flex flex-wrap gap-3 text-sm">
                          <legend className="sr-only">Taxes</legend>
                          {pricing.taxes.map((t) => (
                            <label key={t.key} className="flex items-center gap-1">
                              <input type="checkbox" checked={l.taxKeys.includes(t.key)} onChange={(e) => updateLine(l.id, { taxKeys: e.target.checked ? [...l.taxKeys, t.key] : l.taxKeys.filter((k) => k !== t.key) })} />
                              {t.name} {t.rate}%
                            </label>
                          ))}
                        </fieldset>
                      ) : null}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <label className="flex items-center gap-1 text-xs text-slate-600">
                        <input type="checkbox" checked={l.optional} onChange={(e) => updateLine(l.id, { optional: e.target.checked })} /> Optional (excluded from totals)
                      </label>
                      <div className="flex items-center gap-1">
                        <span className="mr-2 text-sm font-semibold tabular-nums">{lineTotal(l.id) ? formatMoney(lineTotal(l.id)!, currency) : "—"}</span>
                        <IconButton label="Move up" onClick={() => setLinesE((prev) => { const n = [...prev]; if (i > 0) [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; return n; })}>↑</IconButton>
                        <IconButton label="Move down" onClick={() => setLinesE((prev) => { const n = [...prev]; if (i < n.length - 1) [n[i + 1], n[i]] = [n[i]!, n[i + 1]!]; return n; })}>↓</IconButton>
                        <IconButton label="Remove item" danger onClick={() => setLinesE((prev) => prev.filter((x) => x.id !== l.id))}>✕</IconButton>
                      </div>
                    </div>
                    {bad ? <p className="mt-1 text-xs text-red-600">Enter a name, and positive numbers for quantity, price and discount.</p> : null}
                  </div>
                );
              })}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={addCustomLine}>+ Custom item</Button>
              </div>
            </div>

            <div className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-sm font-semibold">Global discount</p>
                <div className="flex gap-2">
                  <Select aria-label="Global discount type" value={pricing.globalDiscountType} onChange={(e) => setPricingE({ ...pricing, globalDiscountType: e.target.value as PricingConfig["globalDiscountType"] })}>
                    <option value="NONE">None</option>
                    <option value="PERCENT">Percent</option>
                    <option value="AMOUNT">Amount</option>
                  </Select>
                  {pricing.globalDiscountType !== "NONE" ? (
                    <Input aria-label="Global discount value" inputMode="decimal" value={pricing.globalDiscountValue} onChange={(e) => setPricingE({ ...pricing, globalDiscountValue: e.target.value.replace(",", ".") })} />
                  ) : null}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold">Taxes</p>
                <div className="space-y-1">
                  {pricing.taxes.map((t, i) => (
                    <div key={t.key} className="flex gap-1">
                      <Input aria-label="Tax name" value={t.name} onChange={(e) => setPricingE({ ...pricing, taxes: pricing.taxes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                      <Input aria-label="Tax rate %" className="w-20" inputMode="decimal" value={t.rate} onChange={(e) => setPricingE({ ...pricing, taxes: pricing.taxes.map((x, j) => (j === i ? { ...x, rate: e.target.value.replace(",", ".") } : x)) })} />
                      <IconButton label="Remove tax" danger onClick={() => { setPricingE({ ...pricing, taxes: pricing.taxes.filter((_, j) => j !== i) }); setLines((prev) => prev.map((l) => ({ ...l, taxKeys: l.taxKeys.filter((k) => k !== t.key) }))); }}>✕</IconButton>
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="ghost" onClick={() => {
                    const key = `tax_${Date.now().toString(36)}`;
                    setPricingE({ ...pricing, taxes: [...pricing.taxes, { key, name: "VAT", rate: "20" }] });
                    setLines((prev) => prev.map((l) => ({ ...l, taxKeys: [...l.taxKeys, key] })));
                  }}>+ Add tax</Button>
                </div>
              </div>
              <div className="sm:col-span-2">
                <p className="mb-2 text-sm font-semibold">Additional fees</p>
                <div className="space-y-1">
                  {pricing.fees.map((f, i) => (
                    <div key={f.key} className="flex flex-wrap items-center gap-1">
                      <Input aria-label="Fee name" className="flex-1" value={f.name} onChange={(e) => setPricingE({ ...pricing, fees: pricing.fees.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                      <Input aria-label="Fee amount" className="w-32" inputMode="decimal" value={f.amount} onChange={(e) => setPricingE({ ...pricing, fees: pricing.fees.map((x, j) => (j === i ? { ...x, amount: e.target.value.replace(",", ".") } : x)) })} />
                      {pricing.taxes.length ? (
                        <label className="flex items-center gap-1 text-xs">
                          <input type="checkbox" checked={f.taxKeys.length > 0} onChange={(e) => setPricingE({ ...pricing, fees: pricing.fees.map((x, j) => (j === i ? { ...x, taxKeys: e.target.checked ? pricing.taxes.map((t) => t.key) : [] } : x)) })} /> Taxable
                        </label>
                      ) : null}
                      <IconButton label="Remove fee" danger onClick={() => setPricingE({ ...pricing, fees: pricing.fees.filter((_, j) => j !== i) })}>✕</IconButton>
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPricingE({ ...pricing, fees: [...pricing.fees, { key: `fee_${Date.now().toString(36)}`, name: "Shipping", amount: "0", taxKeys: [] }] })}>+ Add fee</Button>
                </div>
              </div>
            </div>

            {totals ? (
              <dl className="mt-4 ml-auto max-w-xs space-y-1 border-t border-slate-100 pt-3 text-sm">
                <Row label="Subtotal" value={formatMoney(totals.subtotal, currency)} />
                {totals.discountTotal !== "0.00" ? <Row label="Discounts" value={`-${formatMoney(totals.discountTotal, currency)}`} /> : null}
                {totals.fees.map((f) => <Row key={f.key} label={f.name} value={formatMoney(f.amount, currency)} />)}
                {totals.taxes.map((t) => <Row key={t.key} label={`${t.name} ${t.rate}%`} value={formatMoney(t.amount, currency)} />)}
                <Row label="Total" value={formatMoney(totals.grandTotal, currency)} strong />
              </dl>
            ) : (
              <p className="mt-3 text-sm text-red-600">Pricing is invalid — check discount and tax values.</p>
            )}
          </Section>

          <Section title="Client & company">
            <p className="mb-3 text-xs text-slate-500">Imported from HubSpot. Changes apply to this document only — HubSpot records are not modified.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Contact first name" value={data.contact.firstName} onChange={(v) => setContact({ firstName: v })} />
              <Field label="Contact last name" value={data.contact.lastName} onChange={(v) => setContact({ lastName: v })} />
              <Field label="Contact email" value={data.contact.email} onChange={(v) => setContact({ email: v })} />
              <Field label="Contact phone" value={data.contact.phone} onChange={(v) => setContact({ phone: v })} />
              <Field label="Job title" value={data.contact.jobTitle} onChange={(v) => setContact({ jobTitle: v })} />
              <Field label="Company name" value={data.company.name} onChange={(v) => setCompany({ name: v })} />
              <Field label="Company address" value={data.company.address} onChange={(v) => setCompany({ address: v })} />
              <Field label="City" value={data.company.city} onChange={(v) => setCompany({ city: v })} />
              <Field label="Postal code" value={data.company.zip} onChange={(v) => setCompany({ zip: v })} />
              <Field label="Country" value={data.company.country} onChange={(v) => setCompany({ country: v })} />
            </div>
            {data.deal.hubspotId ? <p className="mt-3 text-xs text-slate-500">Deal: {data.deal.name} · {data.deal.pipeline} / {data.deal.stage}</p> : null}
          </Section>

          {props.customFields.length ? (
            <Section title="Custom fields">
              <div className="grid gap-3 sm:grid-cols-2">
                {props.customFields.map((f) => {
                  const value = data.customFields[f.key] ?? "";
                  const setValue = (v: string) => setDataE((d) => ({ ...d, customFields: { ...d.customFields, [f.key]: v } }));
                  const id = `cf-${f.key}`;
                  return (
                    <div key={f.key} className={f.type === "LONG_TEXT" ? "sm:col-span-2" : ""}>
                      <Label htmlFor={id} hint={f.required ? "(required)" : undefined}>{f.label}</Label>
                      {f.type === "LONG_TEXT" ? (
                        <Textarea id={id} rows={3} value={value} onChange={(e) => setValue(e.target.value)} />
                      ) : f.type === "BOOLEAN" ? (
                        <Select id={id} value={value} onChange={(e) => setValue(e.target.value)}>
                          <option value="">—</option>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </Select>
                      ) : f.type === "SELECT" ? (
                        <Select id={id} value={value} onChange={(e) => setValue(e.target.value)}>
                          <option value="">—</option>
                          {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </Select>
                      ) : (
                        <Input id={id} type={f.type === "DATE" ? "date" : f.type === "NUMBER" ? "number" : "text"} value={value} onChange={(e) => setValue(e.target.value)} />
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>
          ) : null}

          <Section title="Content">
            <p className="mb-3 text-xs text-slate-500">Click a section to edit it. <LockIcon /> Locked sections come from your template and cannot be changed.</p>
            <div className="space-y-2">{blocks.map((b) => renderBlockCard(b))}</div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Label htmlFor="add-block">Add section</Label>
              <Select
                id="add-block"
                className="w-auto"
                value=""
                onChange={(e) => {
                  const type = e.target.value as BlockType;
                  if (!type) return;
                  const block = createBlock(type);
                  setBlocksE((prev) => [...prev, block]);
                  setSelected(block.id);
                }}
              >
                <option value="">Choose…</option>
                {ADDABLE.map((t) => <option key={t} value={t}>{BLOCK_LABELS[t]}</option>)}
              </Select>
            </div>
          </Section>
        </div>

        <div className={cn("xl:block", showPreview ? "" : "hidden")}>
          <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-slate-400">Live preview</p>
            {previewHtml ? <DocumentFrame html={previewHtml} /> : <p className="text-sm text-slate-500">Fix pricing errors to see the preview.</p>}
          </div>
        </div>
      </div>

    </div>
  );
}

function summary(block: Block): string {
  const p = block.props as Record<string, unknown>;
  const text = (p.text ?? p.title ?? p.html ?? "") as string;
  return String(text).replace(/<[^>]+>/g, " ").slice(0, 60);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" aria-label={title}>
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = `f-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between gap-4", strong ? "border-t border-slate-200 pt-1 text-base font-semibold" : "")}>
      <dt className="text-slate-600">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function IconButton({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cn("rounded px-1.5 py-0.5 text-sm text-slate-500 hover:bg-slate-100", danger ? "hover:text-red-600" : "hover:text-slate-900")}>
      {children}
    </button>
  );
}

export function LockIcon() {
  return (
    <svg className="inline h-3.5 w-3.5 align-[-2px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
