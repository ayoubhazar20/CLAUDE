import { z } from "zod";
import { conditionSchema, type Condition } from "./conditions";

/**
 * Document / template block model. The same block tree is used by the template
 * builder, the document editor, the public page and the PDF renderer.
 */
export const BLOCK_TYPES = [
  "heading",
  "paragraph",
  "richText",
  "logo",
  "image",
  "divider",
  "spacer",
  "companyInfo",
  "clientInfo",
  "dealInfo",
  "dynamicProperty",
  "productTable",
  "pricingSummary",
  "taxes",
  "discount",
  "fees",
  "customTable",
  "terms",
  "clause",
  "conditionalSection",
  "signatureArea",
  "acceptanceArea",
  "pageBreak",
  "customSection",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export const CONTAINER_BLOCK_TYPES: readonly BlockType[] = ["conditionalSection", "customSection"];

const align = z.enum(["left", "center", "right"]).default("left");
const shortText = z.string().max(500);
const longText = z.string().max(50_000);

export const blockPropsSchemas = {
  heading: z.object({ text: shortText.default("Heading"), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2), align }),
  paragraph: z.object({ text: longText.default(""), align }),
  richText: z.object({ html: longText.default("") }),
  logo: z.object({ align, maxHeight: z.number().int().min(16).max(200).default(56) }),
  image: z.object({ fileId: z.string().uuid().nullable().default(null), alt: shortText.default(""), width: z.enum(["small", "medium", "full"]).default("full"), align }),
  divider: z.object({}),
  spacer: z.object({ size: z.enum(["sm", "md", "lg"]).default("md") }),
  companyInfo: z.object({ title: shortText.default("From"), showAddress: z.boolean().default(true), showTaxIds: z.boolean().default(true), showContact: z.boolean().default(true) }),
  clientInfo: z.object({ title: shortText.default("Prepared for"), showEmail: z.boolean().default(true), showPhone: z.boolean().default(true), showAddress: z.boolean().default(true) }),
  dealInfo: z.object({ title: shortText.default("Details"), fields: z.array(z.string().max(120)).max(30).default(["document.number", "document.date", "document.expirationDate", "deal.owner.name"]) }),
  dynamicProperty: z.object({ label: shortText.default(""), variable: z.string().max(120).default("") }),
  productTable: z.object({
    title: shortText.default("Products & services"),
    showDescription: z.boolean().default(true),
    showSku: z.boolean().default(false),
    showDiscount: z.boolean().default(true),
    showTaxes: z.boolean().default(false),
  }),
  pricingSummary: z.object({ title: shortText.default("Summary"), showTaxBreakdown: z.boolean().default(true) }),
  taxes: z.object({ title: shortText.default("Taxes") }),
  discount: z.object({ title: shortText.default("Discounts") }),
  fees: z.object({ title: shortText.default("Additional fees") }),
  customTable: z.object({
    title: shortText.default(""),
    columns: z.array(shortText).min(1).max(12).default(["Column 1", "Column 2"]),
    rows: z.array(z.array(z.string().max(2000)).max(12)).max(200).default([["", ""]]),
  }),
  terms: z.object({ title: shortText.default("Terms & Conditions"), html: longText.default("") }),
  clause: z.object({ title: shortText.default("Clause"), html: longText.default("") }),
  conditionalSection: z.object({ title: shortText.default("") }),
  signatureArea: z.object({ title: shortText.default("Signatures"), text: z.string().max(2000).default("") }),
  acceptanceArea: z.object({ title: shortText.default("Acceptance"), text: z.string().max(2000).default("By accepting this quote you agree to the terms above.") }),
  pageBreak: z.object({}),
  customSection: z.object({ title: shortText.default("") }),
} satisfies Record<BlockType, z.ZodTypeAny>;

export type BlockProps<T extends BlockType> = z.infer<(typeof blockPropsSchemas)[T]>;

export interface Block<T extends BlockType = BlockType> {
  id: string;
  type: T;
  /** Locked blocks cannot be edited, moved or removed in documents. */
  locked: boolean;
  condition: Condition | null;
  props: BlockProps<T>;
  children?: Block[];
}

export type AnyBlock = { [K in BlockType]: Block<K> }[BlockType];

const blockIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/);

const baseBlockSchema = z.object({
  id: blockIdSchema,
  type: z.enum(BLOCK_TYPES),
  locked: z.boolean().default(false),
  condition: conditionSchema.nullable().default(null),
  props: z.record(z.unknown()).default({}),
  children: z.array(z.unknown()).optional(),
});

const MAX_DEPTH = 3;
const MAX_BLOCKS = 500;

/** Parse and normalise an untrusted block tree (from the editor / DB). */
export function parseBlocks(input: unknown): Block[] {
  let count = 0;
  const parseLevel = (value: unknown, depth: number): Block[] => {
    const arr = z.array(z.unknown()).max(MAX_BLOCKS).parse(value);
    return arr.map((raw) => {
      count += 1;
      if (count > MAX_BLOCKS) throw new Error("Too many blocks");
      const base = baseBlockSchema.parse(raw);
      const props = blockPropsSchemas[base.type].parse(base.props) as BlockProps<BlockType>;
      const block: Block = { id: base.id, type: base.type, locked: base.locked, condition: base.condition, props };
      if (CONTAINER_BLOCK_TYPES.includes(base.type)) {
        if (depth >= MAX_DEPTH) throw new Error("Blocks are nested too deeply");
        block.children = parseLevel(base.children ?? [], depth + 1);
      }
      return block;
    });
  };
  return parseLevel(input, 0);
}

export function newBlockId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "b_";
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

export function createBlock<T extends BlockType>(type: T, props?: Partial<BlockProps<T>>): Block<T> {
  const parsed = blockPropsSchemas[type].parse(props ?? {}) as BlockProps<T>;
  const block: Block<T> = { id: newBlockId(), type, locked: false, condition: null, props: parsed };
  if (CONTAINER_BLOCK_TYPES.includes(type)) block.children = [];
  return block;
}

export function walkBlocks(blocks: Block[], visit: (block: Block, parent: Block | null) => void, parent: Block | null = null) {
  for (const block of blocks) {
    visit(block, parent);
    if (block.children) walkBlocks(block.children, visit, block);
  }
}

export function findBlock(blocks: Block[], id: string): Block | null {
  let found: Block | null = null;
  walkBlocks(blocks, (b) => {
    if (b.id === id) found = b;
  });
  return found;
}

/** Human labels for the block library (localisation-ready keys live in i18n). */
export const BLOCK_LIBRARY: { type: BlockType; group: "Basic" | "Business" | "Pricing" | "Legal" | "Layout" }[] = [
  { type: "heading", group: "Basic" },
  { type: "paragraph", group: "Basic" },
  { type: "richText", group: "Basic" },
  { type: "logo", group: "Basic" },
  { type: "image", group: "Basic" },
  { type: "companyInfo", group: "Business" },
  { type: "clientInfo", group: "Business" },
  { type: "dealInfo", group: "Business" },
  { type: "dynamicProperty", group: "Business" },
  { type: "customTable", group: "Business" },
  { type: "productTable", group: "Pricing" },
  { type: "pricingSummary", group: "Pricing" },
  { type: "taxes", group: "Pricing" },
  { type: "discount", group: "Pricing" },
  { type: "fees", group: "Pricing" },
  { type: "terms", group: "Legal" },
  { type: "clause", group: "Legal" },
  { type: "signatureArea", group: "Legal" },
  { type: "acceptanceArea", group: "Legal" },
  { type: "divider", group: "Layout" },
  { type: "spacer", group: "Layout" },
  { type: "pageBreak", group: "Layout" },
  { type: "conditionalSection", group: "Layout" },
  { type: "customSection", group: "Layout" },
];

/**
 * Document-level editing rules: users may edit/remove/reorder editable blocks and
 * add new ones, but locked blocks from the template must be preserved exactly and
 * keep their relative order. Returns a list of violations (empty = valid).
 */
export function validateLockedBlocks(original: Block[], updated: Block[]): string[] {
  const errors: string[] = [];
  const originalLocked = new Map<string, Block>();
  const originalLockedOrder: string[] = [];
  walkBlocks(original, (b) => {
    if (b.locked) {
      originalLocked.set(b.id, b);
      originalLockedOrder.push(b.id);
    }
  });
  const updatedById = new Map<string, Block>();
  const updatedLockedOrder: string[] = [];
  const updatedParent = new Map<string, string | null>();
  walkBlocks(updated, (b, parent) => {
    updatedById.set(b.id, b);
    updatedParent.set(b.id, parent?.id ?? null);
    if (originalLocked.has(b.id)) updatedLockedOrder.push(b.id);
  });
  const originalParent = new Map<string, string | null>();
  walkBlocks(original, (b, parent) => originalParent.set(b.id, parent?.id ?? null));

  for (const [id, block] of originalLocked) {
    const next = updatedById.get(id);
    if (!next) {
      errors.push(`Locked block "${id}" cannot be removed`);
      continue;
    }
    if (!next.locked) errors.push(`Locked block "${id}" cannot be unlocked`);
    if (next.type !== block.type) errors.push(`Locked block "${id}" cannot change type`);
    if (JSON.stringify(next.props) !== JSON.stringify(block.props)) errors.push(`Locked block "${id}" cannot be edited`);
    if (JSON.stringify(next.condition) !== JSON.stringify(block.condition)) errors.push(`Locked block "${id}" visibility rules cannot be edited`);
    if (updatedParent.get(id) !== originalParent.get(id)) errors.push(`Locked block "${id}" cannot be moved to another section`);
    // Locking a section locks everything inside it.
    if (block.children && JSON.stringify(block.children) !== JSON.stringify(next.children ?? [])) {
      errors.push(`Locked section "${id}" content cannot be changed`);
    }
  }
  if (originalLockedOrder.filter((id) => updatedById.has(id)).join(",") !== updatedLockedOrder.join(",")) {
    errors.push("Locked blocks cannot be reordered");
  }
  // New blocks added by the user can never be marked locked (only template admins lock content).
  walkBlocks(updated, (b) => {
    if (b.locked && !originalLocked.has(b.id)) errors.push(`Block "${b.id}" cannot be locked from a document`);
  });
  return [...new Set(errors)];
}
