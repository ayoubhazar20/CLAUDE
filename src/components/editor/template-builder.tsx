"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BLOCK_LIBRARY, CONTAINER_BLOCK_TYPES, createBlock, findBlock, newBlockId, type Block, type BlockProps, type BlockType } from "@/domain/blocks";
import { emptyDocumentData } from "@/domain/document-data";
import { calculatePricing } from "@/domain/pricing";
import { resolveDocument, type ResolveInput } from "@/domain/resolve";
import { renderDocumentHtml } from "@/domain/render-html";
import { CURRENCY_CODES } from "@/domain/currencies";
import type { VariableDefinition } from "@/domain/variables";
import { Alert, Badge, Button, Input, Label, Select, cn } from "../ui";
import { DocumentFrame } from "../document-frame";
import { Modal } from "../modal";
import { BLOCK_LABELS, BlockPropsEditor } from "./block-fields";
import { ConditionBuilder } from "./condition-builder";
import { LockIcon } from "./document-editor";
import { templateOpAction } from "@/app/actions/templates";

export interface TemplateSettingsValue {
  acceptanceMode: "ACCEPTANCE_ONLY" | "SIGNATURE_REQUIRED";
  expirationDays: number;
  signingOrder: "ANY" | "SEQUENTIAL";
  defaultTaxes: { key: string; name: string; rate: string }[];
  applyDefaultTaxes: boolean;
  currency: string | null;
}

interface Props {
  templateId: string;
  name: string;
  documentType: "QUOTE" | "CONTRACT";
  versionNumber: number;
  versionStatus: "DRAFT" | "PUBLISHED";
  updatedAt: string;
  blocks: Block[];
  settings: TemplateSettingsValue;
  organization: ResolveInput["organization"];
  variables: VariableDefinition[];
  readOnly: boolean;
}

type SaveState = "saved" | "dirty" | "saving" | "error";

function sampleInput(blocks: Block[], props: Props, settings: TemplateSettingsValue): ResolveInput {
  const data = emptyDocumentData();
  data.contact = { hubspotId: null, firstName: "Jane", lastName: "Doe", email: "jane.doe@example.com", phone: "+1 555 0100", jobTitle: "Head of Operations" };
  data.company = { hubspotId: null, name: "Acme Corporation", address: "1 Market Street", city: "Springfield", zip: "12345", country: "United States", phone: "", domain: "acme.example" };
  data.deal = { hubspotId: "1", name: "Website redesign", amount: "12000", pipeline: "Sales Pipeline", pipelineId: "", stage: "Proposal", stageId: "", closeDate: "2026-12-31", owner: { hubspotId: null, name: "Sam Seller", email: "sam@example.com" } };
  data.sender = { name: "Sam Seller", email: "sam@example.com" };
  data.recipients = [{ id: "00000000-0000-4000-8000-000000000001", name: "Jane Doe", email: "jane.doe@example.com", role: "SIGNER", signingOrder: 1, required: true, hubspotContactId: null }];
  const currency = settings.currency ?? "USD";
  const taxes = settings.defaultTaxes.length ? settings.defaultTaxes : [];
  const lineItems = [
    { key: "a", name: "Discovery workshop", description: "Two-day on-site workshop", sku: "WS-01", category: "Consulting", quantity: "2", unitPrice: "1500", discountType: "NONE" as const, discountValue: "0", taxKeys: taxes.map((t) => t.key), optional: false },
    { key: "b", name: "Design & build", description: null, sku: "DB-02", category: "Services", quantity: "1", unitPrice: "9000", discountType: "PERCENT" as const, discountValue: "10", taxKeys: taxes.map((t) => t.key), optional: false },
  ];
  const pricingConfig = { globalDiscountType: "NONE" as const, globalDiscountValue: "0", taxes, fees: [] };
  let totals;
  try {
    totals = calculatePricing(lineItems, pricingConfig, currency);
  } catch {
    totals = calculatePricing(lineItems, { ...pricingConfig, taxes: [] }, currency);
  }
  return {
    blocks,
    data,
    lineItems,
    pricingConfig,
    totals,
    currency,
    organization: props.organization,
    document: { type: props.documentType, number: props.documentType === "QUOTE" ? "Q-2026-000123" : "C-2026-000045", title: props.name, versionNumber: 1, date: new Date(), expiresAt: new Date(Date.now() + settings.expirationDays * 86400000), url: "#", acceptanceMode: settings.acceptanceMode },
    recipients: [{ id: "00000000-0000-4000-8000-000000000001", name: "Jane Doe", email: "jane.doe@example.com", role: "SIGNER", signingOrder: 1 }],
    signatures: [],
    timezone: "UTC",
    imageUrl: (id) => `/api/files/${id}`,
  };
}

function stripConditions(blocks: Block[]): Block[] {
  return blocks.map((b) => ({ ...b, condition: null, children: b.children ? stripConditions(b.children) : undefined }));
}

function cloneWithNewIds(block: Block): Block {
  return { ...structuredClone(block), id: newBlockId(), children: block.children?.map(cloneWithNewIds) };
}

export function TemplateBuilder(props: Props) {
  const router = useRouter();
  const [name, setName] = useState(props.name);
  const [blocks, setBlocks] = useState<Block[]>(props.blocks);
  const [settings, setSettings] = useState<TemplateSettingsValue>(props.settings);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState({ number: props.versionNumber, status: props.versionStatus });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragOver, setDragOver] = useState<{ id: string | null; container: string | null } | null>(null);
  const updatedAt = useRef<string | undefined>(props.versionStatus === "DRAFT" ? props.updatedAt : undefined);
  const counter = useRef(0);
  const saved = useRef(0);
  const drag = useRef<{ kind: "new"; type: BlockType } | { kind: "move"; id: string } | null>(null);

  const change = <T,>(setter: React.Dispatch<React.SetStateAction<T>>) => (v: React.SetStateAction<T>) => {
    if (props.readOnly) return;
    setter(v);
    counter.current += 1;
    setSaveState("dirty");
  };
  const setBlocksE = change(setBlocks);
  const setSettingsE = change(setSettings);
  const setNameE = change(setName);

  const save = useCallback(async () => {
    if (props.readOnly || saved.current === counter.current) return true;
    const target = counter.current;
    setSaveState("saving");
    const res = await fetch(`/api/templates/${props.templateId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, blocks, settings, expectedUpdatedAt: updatedAt.current }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    if (!res?.ok) {
      setSaveState("error");
      setError(json?.error?.message ?? "Save failed — check your connection.");
      return false;
    }
    updatedAt.current = json.updatedAt;
    setVersionInfo({ number: json.version, status: json.status });
    saved.current = target;
    setError(null);
    setSaveState(counter.current === target ? "saved" : "dirty");
    return true;
  }, [props.readOnly, props.templateId, name, blocks, settings]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(() => void save(), 1500);
    return () => clearTimeout(t);
  }, [saveState, save]);

  const selected = selectedId ? findBlock(blocks, selectedId) : null;

  // ── Tree helpers ──
  const mapTree = (list: Block[], fn: (b: Block) => Block): Block[] => list.map((b) => fn(b.children ? { ...b, children: mapTree(b.children, fn) } : b));
  const removeFromTree = (list: Block[], id: string): [Block[], Block | null] => {
    let removed: Block | null = null;
    const walk = (l: Block[]): Block[] =>
      l.filter((b) => {
        if (b.id === id) {
          removed = b;
          return false;
        }
        return true;
      }).map((b) => (b.children ? { ...b, children: walk(b.children) } : b));
    return [walk(list), removed];
  };
  const insertIntoTree = (list: Block[], block: Block, beforeId: string | null, containerId: string | null): Block[] => {
    if (containerId) {
      return list.map((b) => {
        if (b.id === containerId) {
          const children = [...(b.children ?? [])];
          const idx = beforeId ? children.findIndex((c) => c.id === beforeId) : -1;
          children.splice(idx >= 0 ? idx : children.length, 0, block);
          return { ...b, children };
        }
        return b.children ? { ...b, children: insertIntoTree(b.children, block, beforeId, containerId) } : b;
      });
    }
    const next = [...list];
    const idx = beforeId ? next.findIndex((b) => b.id === beforeId) : -1;
    next.splice(idx >= 0 ? idx : next.length, 0, block);
    return next;
  };

  const addBlock = (type: BlockType, beforeId: string | null = null, containerId: string | null = null) => {
    const block = createBlock(type);
    setBlocksE((prev) => insertIntoTree(prev, block, beforeId, containerId));
    setSelectedId(block.id);
  };

  const moveTo = (id: string, beforeId: string | null, containerId: string | null) => {
    if (id === beforeId || id === containerId) return;
    setBlocksE((prev) => {
      const [without, moved] = removeFromTree(prev, id);
      if (!moved) return prev;
      // Never drop a container into itself or its descendants.
      if (containerId && findBlock([moved], containerId)) return prev;
      return insertIntoTree(without, moved, beforeId, containerId);
    });
  };

  const moveStep = (id: string, dir: -1 | 1) => {
    const step = (l: Block[]): Block[] => {
      const i = l.findIndex((b) => b.id === id);
      if (i >= 0) {
        const j = i + dir;
        if (j < 0 || j >= l.length) return l;
        const n = [...l];
        [n[i], n[j]] = [n[j]!, n[i]!];
        return n;
      }
      return l.map((b) => (b.children ? { ...b, children: step(b.children) } : b));
    };
    setBlocksE((prev) => step(prev));
  };

  const updateSelected = (fn: (b: Block) => Block) => {
    if (!selectedId) return;
    setBlocksE((prev) => mapTree(prev, (b) => (b.id === selectedId ? fn(b) : b)));
  };

  // ── Rendering ──
  const input = useMemo(() => sampleInput(stripConditions(blocks), { ...props, name }, settings), [blocks, props, name, settings]);
  const blockHtml = useMemo(() => {
    const map = new Map<string, string>();
    try {
      const resolved = resolveDocument(input);
      const walk = (list: typeof resolved.blocks) => {
        for (const rb of list) {
          if (rb.type === "container") {
            map.set(rb.id, renderDocumentHtml({ ...resolved, blocks: [{ ...rb, children: [] }] }));
            walk(rb.children);
          } else {
            map.set(rb.id, renderDocumentHtml({ ...resolved, blocks: [rb] }, { blockAttributes: true }));
          }
        }
      };
      walk(resolved.blocks);
    } catch {
      /* invalid intermediate state */
    }
    return map;
  }, [input]);
  const fullPreview = useMemo(() => {
    try {
      return renderDocumentHtml(resolveDocument(sampleInput(blocks, { ...props, name }, settings)));
    } catch {
      return "";
    }
  }, [blocks, props, name, settings]);

  const onDrop = (e: React.DragEvent, beforeId: string | null, containerId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const d = drag.current;
    drag.current = null;
    if (!d || props.readOnly) return;
    if (d.kind === "new") addBlock(d.type, beforeId, containerId);
    else moveTo(d.id, beforeId, containerId);
  };

  const renderCanvasBlock = (block: Block, parent: string | null): React.ReactNode => {
    const isSel = block.id === selectedId;
    const isContainer = CONTAINER_BLOCK_TYPES.includes(block.type);
    return (
      <div key={block.id}>
        <div
          className={cn("h-2 rounded transition-all", dragOver?.id === block.id && dragOver.container === parent ? "my-1 h-3 bg-brand-200" : "")}
          onDragOver={(e) => { e.preventDefault(); setDragOver({ id: block.id, container: parent }); }}
          onDrop={(e) => onDrop(e, block.id, parent)}
        />
        <div
          draggable={!props.readOnly}
          onDragStart={(e) => { drag.current = { kind: "move", id: block.id }; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", block.id); }}
          onDragEnd={() => setDragOver(null)}
          onClick={(e) => { e.stopPropagation(); setSelectedId(block.id); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(block.id); } }}
          tabIndex={0}
          role="button"
          aria-pressed={isSel}
          aria-label={`${BLOCK_LABELS[block.type]} block${block.locked ? ", locked" : ""}`}
          className={cn(
            "group relative cursor-pointer rounded-md border-2 bg-white p-3 transition",
            isSel ? "border-brand-500" : "border-transparent hover:border-slate-300",
            block.locked ? "locked-block" : "",
          )}
        >
          <div className="pointer-events-none absolute -top-2.5 left-2 hidden gap-1 group-hover:flex group-focus:flex" style={isSel ? { display: "flex" } : undefined}>
            <span className="rounded bg-slate-800 px-1.5 text-[10px] font-medium text-white">{BLOCK_LABELS[block.type]}</span>
            {block.locked ? <span className="rounded bg-slate-600 px-1.5 text-[10px] font-medium text-white"><LockIcon /> Locked</span> : null}
            {block.condition ? <span className="rounded bg-purple-600 px-1.5 text-[10px] font-medium text-white">Conditional</span> : null}
          </div>
          {block.locked ? <span className="absolute right-2 top-2 text-slate-500" title="Locked — users cannot edit this block"><LockIcon /></span> : null}
          <div className="pointer-events-none">
            {blockHtml.get(block.id) ? <DocumentFrame html={blockHtml.get(block.id)!} /> : <p className="text-sm text-slate-400">{BLOCK_LABELS[block.type]}</p>}
          </div>
          {isContainer ? (
            <div
              className={cn("mt-2 rounded border border-dashed p-2", dragOver?.container === block.id && dragOver.id === null ? "border-brand-500 bg-brand-50" : "border-slate-300")}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver({ id: null, container: block.id }); }}
              onDrop={(e) => onDrop(e, null, block.id)}
            >
              {(block.children ?? []).length === 0 ? <p className="py-3 text-center text-xs text-slate-400">Drop blocks here</p> : null}
              {(block.children ?? []).map((c) => renderCanvasBlock(c, block.id))}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const saveLabel = { saved: "Saved", dirty: "Unsaved changes", saving: "Saving…", error: "Save failed" }[saveState];

  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-8">
      <div className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/templates" className="whitespace-nowrap text-sm text-slate-500 hover:text-slate-800">← Templates</Link>
          <label htmlFor="tpl-name" className="sr-only">Template name</label>
          <Input id="tpl-name" value={name} onChange={(e) => setNameE(e.target.value)} className="w-40 py-1 font-semibold sm:w-56" disabled={props.readOnly} />
          <Badge tone={props.documentType === "QUOTE" ? "blue" : "indigo"}>{props.documentType === "QUOTE" ? "Quote" : "Contract"}</Badge>
          <span className="whitespace-nowrap text-xs text-slate-500">v{versionInfo.number} · {versionInfo.status === "DRAFT" ? "draft" : "published"}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("text-sm", saveState === "error" ? "text-red-600" : saveState === "saved" ? "text-emerald-700" : "text-slate-500")} role="status" aria-live="polite">{props.readOnly ? "Read-only" : saveLabel}</span>
          <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true)}>Settings</Button>
          <Button variant="secondary" size="sm" onClick={() => setPreviewOpen(true)}>Preview</Button>
          {!props.readOnly ? (
            <Button
              size="sm"
              onClick={async () => {
                if (!(await save())) return;
                const form = new FormData();
                form.set("templateId", props.templateId);
                form.set("op", "publish");
                const res = await templateOpAction(null, form);
                if (res && !res.ok) setError(res.error);
                else {
                  setVersionInfo((v) => ({ ...v, status: "PUBLISHED" }));
                  updatedAt.current = undefined;
                  setError(null);
                  router.refresh();
                }
              }}
              disabled={versionInfo.status === "PUBLISHED" && saveState === "saved"}
            >
              Publish
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <div className="px-4 pt-3 sm:px-6 lg:px-8"><Alert tone="error">{error}</Alert></div> : null}
      {versionInfo.status === "PUBLISHED" && !props.readOnly ? (
        <p className="px-4 pt-2 text-xs text-slate-500 sm:px-6 lg:px-8">Your next change creates version {versionInfo.number + 1} as a draft. Documents already created keep their version.</p>
      ) : null}

      <div className="grid min-h-[calc(100vh-8rem)] grid-cols-1 items-start lg:grid-cols-[220px_1fr_340px]">
        {/* Block library */}
        <aside className="border-b border-slate-200 bg-white p-3 lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto lg:border-b-0 lg:border-r" aria-label="Block library">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Blocks</p>
          {!props.readOnly ? (
            ["Basic", "Business", "Pricing", "Legal", "Layout"].map((group) => (
              <div key={group} className="mb-3">
                <p className="mb-1 text-[11px] font-medium text-slate-400">{group}</p>
                <div className="grid grid-cols-2 gap-1 lg:grid-cols-1">
                  {BLOCK_LIBRARY.filter((b) => b.group === group).map((b) => (
                    <button
                      key={b.type}
                      type="button"
                      draggable
                      onDragStart={() => { drag.current = { kind: "new", type: b.type }; }}
                      onClick={() => addBlock(b.type, null, selected && CONTAINER_BLOCK_TYPES.includes(selected.type) ? selected.id : null)}
                      className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-left text-xs font-medium text-slate-700 hover:border-brand-300 hover:bg-brand-50"
                      title="Click to add, or drag onto the canvas"
                    >
                      {BLOCK_LABELS[b.type]}
                    </button>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-slate-500">You can view this template but not edit it.</p>
          )}
        </aside>

        {/* Canvas */}
        <main className="bg-slate-100 p-4 sm:p-6" onClick={() => setSelectedId(null)} aria-label="Document canvas">
          <div className="mx-auto max-w-3xl rounded-lg bg-white p-6 shadow-sm sm:p-10" style={{ ["--dd-brand" as string]: props.organization.brandColor }}>
            {blocks.map((b) => renderCanvasBlock(b, null))}
            <div
              className={cn("mt-2 rounded border-2 border-dashed p-4 text-center text-xs text-slate-400", dragOver?.id === null && dragOver.container === null ? "border-brand-500 bg-brand-50" : "border-slate-200")}
              onDragOver={(e) => { e.preventDefault(); setDragOver({ id: null, container: null }); }}
              onDrop={(e) => onDrop(e, null, null)}
            >
              {blocks.length ? "Drop here to add at the end" : "Drag blocks here or click a block in the library"}
            </div>
          </div>
        </main>

        {/* Properties */}
        <aside className="border-t border-slate-200 bg-white p-4 lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto lg:border-l lg:border-t-0" aria-label="Block settings">
          {selected ? (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{BLOCK_LABELS[selected.type]}</h2>
                <div className="flex gap-1">
                  <button type="button" className="rounded px-1.5 text-slate-500 hover:bg-slate-100" aria-label="Move up" onClick={() => moveStep(selected.id, -1)} disabled={props.readOnly}>↑</button>
                  <button type="button" className="rounded px-1.5 text-slate-500 hover:bg-slate-100" aria-label="Move down" onClick={() => moveStep(selected.id, 1)} disabled={props.readOnly}>↓</button>
                </div>
              </div>
              <fieldset disabled={props.readOnly} className="space-y-5">
                <BlockPropsEditor block={selected} variables={props.variables} onChange={(p) => updateSelected((b) => ({ ...b, props: p as BlockProps<BlockType> }))} />
                <div className="border-t border-slate-100 pt-4">
                  <p className="mb-2 text-sm font-semibold">Editing in documents</p>
                  <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Editing in documents">
                    {[
                      { v: false, label: "Editable", hint: "Users can edit" },
                      { v: true, label: "Locked", hint: "Read-only in documents" },
                    ].map((o) => (
                      <button
                        key={o.label}
                        type="button"
                        role="radio"
                        aria-checked={selected.locked === o.v}
                        onClick={() => updateSelected((b) => ({ ...b, locked: o.v }))}
                        className={cn("rounded border-2 px-2 py-1.5 text-left text-xs", selected.locked === o.v ? "border-brand-600 bg-brand-50" : "border-slate-200")}
                      >
                        <span className="block font-semibold">{o.v ? <><LockIcon /> </> : null}{o.label}</span>
                        <span className="text-slate-500">{o.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="border-t border-slate-100 pt-4">
                  <p className="mb-2 text-sm font-semibold">Visibility</p>
                  <ConditionBuilder value={selected.condition} onChange={(c) => updateSelected((b) => ({ ...b, condition: c }))} variables={props.variables} />
                </div>
                <div className="flex gap-2 border-t border-slate-100 pt-4">
                  <Button type="button" size="sm" variant="secondary" onClick={() => {
                    const copy = cloneWithNewIds(selected);
                    setBlocksE((prev) => {
                      const insertAfter = (l: Block[]): Block[] => {
                        const i = l.findIndex((b) => b.id === selected.id);
                        if (i >= 0) return [...l.slice(0, i + 1), copy, ...l.slice(i + 1)];
                        return l.map((b) => (b.children ? { ...b, children: insertAfter(b.children) } : b));
                      };
                      return insertAfter(prev);
                    });
                    setSelectedId(copy.id);
                  }}>Duplicate</Button>
                  <Button type="button" size="sm" variant="danger" onClick={() => { setBlocksE((prev) => removeFromTree(prev, selected.id)[0]); setSelectedId(null); }}>Delete</Button>
                </div>
              </fieldset>
            </div>
          ) : (
            <div className="text-sm text-slate-600">
              <p className="font-semibold text-slate-800">Block settings</p>
              <p className="mt-1">Select a block on the canvas to edit its content, lock it for documents, or make it conditional.</p>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-500">
                <li>Drag blocks to reorder them.</li>
                <li>Use “Insert variable” to add HubSpot and document data.</li>
                <li>The canvas uses sample data.</li>
              </ul>
            </div>
          )}
        </aside>
      </div>

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Preview with sample data" wide>
        <p className="mb-3 text-xs text-slate-500">Visibility rules are applied (sample total and products).</p>
        <DocumentFrame html={fullPreview} />
      </Modal>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Template settings">
        <fieldset disabled={props.readOnly} className="space-y-4">
          {props.documentType === "QUOTE" ? (
            <div>
              <Label htmlFor="ts-accept">Client action</Label>
              <Select id="ts-accept" value={settings.acceptanceMode} onChange={(e) => setSettingsE({ ...settings, acceptanceMode: e.target.value as TemplateSettingsValue["acceptanceMode"] })}>
                <option value="ACCEPTANCE_ONLY">Acceptance only (Accept button + email code)</option>
                <option value="SIGNATURE_REQUIRED">Signature required</option>
              </Select>
            </div>
          ) : (
            <p className="text-sm text-slate-600">Contracts always require electronic signatures.</p>
          )}
          <div>
            <Label htmlFor="ts-sign">Signing order</Label>
            <Select id="ts-sign" value={settings.signingOrder} onChange={(e) => setSettingsE({ ...settings, signingOrder: e.target.value as "ANY" | "SEQUENTIAL" })}>
              <option value="ANY">Any order</option>
              <option value="SEQUENTIAL">Sequential (by signing order)</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ts-exp">Valid for (days)</Label>
              <Input id="ts-exp" type="number" min={0} max={3650} value={settings.expirationDays} onChange={(e) => setSettingsE({ ...settings, expirationDays: Math.max(0, Math.min(3650, Number(e.target.value) || 0)) })} />
              <p className="mt-1 text-xs text-slate-500">0 = no expiration</p>
            </div>
            <div>
              <Label htmlFor="ts-cur">Currency</Label>
              <Select id="ts-cur" value={settings.currency ?? ""} onChange={(e) => setSettingsE({ ...settings, currency: e.target.value || null })}>
                <option value="">Deal / company default</option>
                {CURRENCY_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700">Default taxes</p>
            {settings.defaultTaxes.map((t, i) => (
              <div key={t.key} className="mb-1 flex gap-1">
                <Input aria-label="Tax name" value={t.name} onChange={(e) => setSettingsE({ ...settings, defaultTaxes: settings.defaultTaxes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <Input aria-label="Tax rate %" className="w-24" value={t.rate} onChange={(e) => setSettingsE({ ...settings, defaultTaxes: settings.defaultTaxes.map((x, j) => (j === i ? { ...x, rate: e.target.value.replace(",", ".") } : x)) })} />
                <button type="button" aria-label="Remove tax" className="px-2 text-slate-400 hover:text-red-600" onClick={() => setSettingsE({ ...settings, defaultTaxes: settings.defaultTaxes.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => setSettingsE({ ...settings, defaultTaxes: [...settings.defaultTaxes, { key: `vat_${Date.now().toString(36)}`, name: "VAT", rate: "20" }] })}>+ Add tax</Button>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={settings.applyDefaultTaxes} onChange={(e) => setSettingsE({ ...settings, applyDefaultTaxes: e.target.checked })} /> Apply to imported products
            </label>
          </div>
        </fieldset>
      </Modal>
    </div>
  );
}
