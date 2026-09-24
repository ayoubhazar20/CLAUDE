import fs from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import type { ResolvedBlock, ResolvedDocument } from "@/domain/resolve";
import { richTextToParagraphs, type RichParagraph, type TextRun } from "@/domain/richtext";

/**
 * PDF renderer. Walks the same resolved block tree as the HTML renderer so the
 * PDF matches the online document. Pure layout code: no DB access.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 50;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 60;
const CONTENT_W = PAGE_W - MARGIN_X * 2;
const BLOCK_GAP = 12;

const INK = rgb(0.067, 0.094, 0.153);
const MUTED = rgb(0.42, 0.45, 0.5);
const BORDER = rgb(0.9, 0.91, 0.92);
const LIGHT_BG = rgb(0.98, 0.98, 0.98);
const GREEN_BG = rgb(0.925, 0.992, 0.961);
const GREEN = rgb(0.024, 0.373, 0.275);

export type ImageLoader = (url: string) => Promise<{ bytes: Uint8Array; type: "png" | "jpeg" } | null>;

export interface CertificateEntry {
  signerName: string;
  signerEmail: string;
  kind: "ACCEPTANCE" | "SIGNATURE";
  method: string;
  signedAt: string;
  otpVerifiedAt: string | null;
  ip: string | null;
  userAgent: string | null;
  consentText: string | null;
}

export interface PdfMeta {
  title: string;
  number: string;
  versionNumber: number;
  organizationName: string;
  contentHash: string | null;
  footerNote?: string;
  certificate?: {
    completedAt: string;
    entries: CertificateEntry[];
    events: { at: string; label: string }[];
  };
}

function hexToRgb(hex: string): RGB {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return rgb(0.145, 0.388, 0.922);
  return rgb(parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255);
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  semibold: PDFFont;
}

let fontCache: Record<string, Uint8Array> | null = null;
async function loadFontBytes() {
  if (fontCache) return fontCache;
  const dir = path.join(process.cwd(), "assets", "fonts");
  const [regular, bold, italic, boldItalic, semibold] = await Promise.all(
    ["Inter_400Regular.ttf", "Inter_700Bold.ttf", "Inter_400Regular_Italic.ttf", "Inter_700Bold_Italic.ttf", "Inter_600SemiBold.ttf"].map((f) => fs.readFile(path.join(dir, f))),
  );
  fontCache = { regular: regular!, bold: bold!, italic: italic!, boldItalic: boldItalic!, semibold: semibold! };
  return fontCache;
}

/** Remove characters that cannot be drawn (control chars) and normalise whitespace. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

interface Word {
  text: string;
  font: PDFFont;
  size: number;
  color: RGB;
  underline?: boolean;
  width: number;
  space: boolean;
}

class Layout {
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  constructor(private pdf: PDFDocument, public fonts: Fonts, public brand: RGB) {
    this.newPage();
  }
  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN_TOP;
  }
  ensure(height: number) {
    if (this.y - height < MARGIN_BOTTOM) this.newPage();
  }
  get remaining() {
    return this.y - MARGIN_BOTTOM;
  }

  measure(text: string, font: PDFFont, size: number) {
    try {
      return font.widthOfTextAtSize(text, size);
    } catch {
      return text.length * size * 0.5;
    }
  }

  runsToWords(runs: TextRun[], size: number, color: RGB, baseBold = false): Word[][] {
    // Returns lines split by explicit newlines, each a list of words.
    const lines: Word[][] = [[]];
    for (const run of runs) {
      const bold = baseBold || Boolean(run.bold);
      const font = bold && run.italic ? this.fonts.boldItalic : bold ? this.fonts.bold : run.italic ? this.fonts.italic : this.fonts.regular;
      const parts = clean(run.text).split("\n");
      parts.forEach((part, pi) => {
        if (pi > 0) lines.push([]);
        const tokens = part.split(/(\s+)/).filter((t) => t !== "");
        for (const t of tokens) {
          const space = /^\s+$/.test(t);
          const text = space ? " " : t;
          lines[lines.length - 1]!.push({ text, font, size, color: run.href ? this.brand : color, underline: run.underline, width: this.measure(text, font, size), space });
        }
      });
    }
    return lines;
  }

  /** Word-wrap into visual lines no wider than maxWidth. */
  wrap(paragraphLines: Word[][], maxWidth: number): Word[][] {
    const out: Word[][] = [];
    for (const words of paragraphLines) {
      let line: Word[] = [];
      let width = 0;
      for (const w of words) {
        if (w.space && line.length === 0) continue;
        if (!w.space && width + w.width > maxWidth && line.length) {
          while (line.length && line[line.length - 1]!.space) line.pop();
          out.push(line);
          line = [];
          width = 0;
        }
        if (!w.space && w.width > maxWidth) {
          // Break very long words (URLs…) by characters.
          let chunk = "";
          for (const ch of w.text) {
            const cw = this.measure(chunk + ch, w.font, w.size);
            if (cw > maxWidth && chunk) {
              out.push([{ ...w, text: chunk, width: this.measure(chunk, w.font, w.size) }]);
              chunk = ch;
            } else chunk += ch;
          }
          line = [{ ...w, text: chunk, width: this.measure(chunk, w.font, w.size) }];
          width = line[0]!.width;
          continue;
        }
        line.push(w);
        width += w.width;
      }
      while (line.length && line[line.length - 1]!.space) line.pop();
      out.push(line);
    }
    return out;
  }

  lineWidth(line: Word[]) {
    return line.reduce((s, w) => s + w.width, 0);
  }

  /** Draw wrapped text at the cursor, handling page breaks. */
  drawRuns(runs: TextRun[], opts: { x?: number; width?: number; size?: number; color?: RGB; bold?: boolean; align?: string; lineHeight?: number } = {}) {
    const size = opts.size ?? 10;
    const lh = (opts.lineHeight ?? 1.45) * size;
    const x0 = opts.x ?? MARGIN_X;
    const width = opts.width ?? CONTENT_W;
    const lines = this.wrap(this.runsToWords(runs, size, opts.color ?? INK, opts.bold), width);
    for (const line of lines) {
      this.ensure(lh);
      const lw = this.lineWidth(line);
      let x = opts.align === "center" ? x0 + (width - lw) / 2 : opts.align === "right" ? x0 + width - lw : x0;
      const baseline = this.y - size;
      for (const w of line) {
        if (!w.space) {
          this.page.drawText(w.text, { x, y: baseline, size: w.size, font: w.font, color: w.color });
          if (w.underline) this.page.drawLine({ start: { x, y: baseline - 1.5 }, end: { x: x + w.width, y: baseline - 1.5 }, thickness: 0.5, color: w.color });
        }
        x += w.width;
      }
      this.y -= lh;
    }
  }

  text(text: string, opts: Parameters<Layout["drawRuns"]>[1] & { italic?: boolean } = {}) {
    this.drawRuns([{ text, italic: opts.italic }], opts);
  }

  /** Measure the height of text in a box without drawing. */
  textHeight(text: string, width: number, size: number, bold = false, lineHeight = 1.45) {
    const lines = this.wrap(this.runsToWords([{ text }], size, INK, bold), width);
    return lines.length * size * lineHeight;
  }

  /** Draw text inside a fixed box (no page breaks) — used in table cells. */
  textInBox(text: string, x: number, top: number, width: number, opts: { size?: number; bold?: boolean; color?: RGB; align?: "left" | "right"; lineHeight?: number } = {}) {
    const size = opts.size ?? 9.5;
    const lh = (opts.lineHeight ?? 1.4) * size;
    const lines = this.wrap(this.runsToWords([{ text }], size, opts.color ?? INK, opts.bold), width);
    let y = top;
    for (const line of lines) {
      const lw = this.lineWidth(line);
      let cx = opts.align === "right" ? x + width - lw : x;
      for (const w of line) {
        if (!w.space) this.page.drawText(w.text, { x: cx, y: y - size, size: w.size, font: w.font, color: w.color });
        cx += w.width;
      }
      y -= lh;
    }
    return lines.length * lh;
  }

  gap(h: number) {
    this.y -= h;
    if (this.y < MARGIN_BOTTOM) this.newPage();
  }

  hr(color: RGB = BORDER, thickness = 0.75) {
    this.ensure(6);
    this.page.drawLine({ start: { x: MARGIN_X, y: this.y }, end: { x: PAGE_W - MARGIN_X, y: this.y }, thickness, color });
    this.y -= 4;
  }
}

async function drawRich(layout: Layout, html: string) {
  const paragraphs: RichParagraph[] = richTextToParagraphs(html);
  for (const p of paragraphs) {
    if (p.kind === "li") {
      const indent = 14 + (p.depth ?? 0) * 14;
      layout.ensure(15);
      const startY = layout.y;
      const startPage = layout.page;
      layout.drawRuns(p.runs, { x: MARGIN_X + indent, width: CONTENT_W - indent, size: 10 });
      startPage.drawText(p.marker ?? "•", { x: MARGIN_X + indent - 11, y: startY - 10, size: 10, font: layout.fonts.regular, color: INK });
      layout.y -= 2;
    } else {
      const size = p.kind === "h3" ? 12 : p.kind === "h4" ? 11 : 10;
      layout.drawRuns(p.runs, { size, bold: p.kind !== "p" });
      layout.y -= 5;
    }
  }
}

async function embedImage(pdf: PDFDocument, loader: ImageLoader, url: string, cache: Map<string, PDFImage | null>): Promise<PDFImage | null> {
  if (cache.has(url)) return cache.get(url)!;
  let image: PDFImage | null = null;
  try {
    const data = url.startsWith("data:image/png;base64,") ? { bytes: Buffer.from(url.slice(22), "base64"), type: "png" as const } : await loader(url);
    if (data) image = data.type === "png" ? await pdf.embedPng(data.bytes) : await pdf.embedJpg(data.bytes);
  } catch {
    image = null;
  }
  cache.set(url, image);
  return image;
}

function sectionTitle(layout: Layout, title: string) {
  if (!title) return;
  layout.ensure(40);
  layout.text(title, { size: 12, bold: true });
  layout.y -= 3;
}

async function renderBlock(block: ResolvedBlock, layout: Layout, pdf: PDFDocument, loader: ImageLoader, images: Map<string, PDFImage | null>) {
  const f = layout.fonts;
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? 20 : block.level === 2 ? 15 : 12.5;
      layout.ensure(size * 2.5);
      layout.text(block.text, { size, bold: true, align: block.align, lineHeight: 1.3 });
      if (block.level === 2) {
        layout.page.drawLine({ start: { x: MARGIN_X, y: layout.y + 2 }, end: { x: PAGE_W - MARGIN_X, y: layout.y + 2 }, thickness: 1.5, color: layout.brand });
        layout.y -= 3;
      }
      break;
    }
    case "paragraph":
      if (block.text.trim()) layout.text(block.text, { size: 10, align: block.align });
      break;
    case "richText":
      await drawRich(layout, block.html);
      break;
    case "logo":
    case "image": {
      if (!block.url) break;
      const img = await embedImage(pdf, loader, block.url, images);
      if (!img) break;
      const maxH = block.type === "logo" ? block.maxHeight * 0.75 : 320;
      const maxW = block.type === "logo" ? 180 : block.width === "small" ? CONTENT_W / 3 : block.width === "medium" ? CONTENT_W * 0.6 : CONTENT_W;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      layout.ensure(h + 4);
      const x = block.align === "center" ? MARGIN_X + (CONTENT_W - w) / 2 : block.align === "right" ? PAGE_W - MARGIN_X - w : MARGIN_X;
      layout.page.drawImage(img, { x, y: layout.y - h, width: w, height: h });
      layout.y -= h;
      break;
    }
    case "divider":
      layout.hr();
      break;
    case "spacer":
      layout.gap(block.size === "sm" ? 4 : block.size === "md" ? 14 : 32);
      break;
    case "pageBreak":
      layout.newPage();
      break;
    case "infoCard": {
      const inner = CONTENT_W - 24;
      const lineTexts = block.lines.map((l) => (l.label ? `${l.label}: ${l.value}` : l.value));
      const height = 16 + (block.title ? 14 : 0) + lineTexts.reduce((s, t) => s + layout.textHeight(t, inner, 9.5, false, 1.4), 0);
      layout.ensure(Math.min(height, layout.remaining + 1));
      const top = layout.y;
      layout.page.drawRectangle({ x: MARGIN_X, y: top - height, width: CONTENT_W, height, color: LIGHT_BG, borderColor: BORDER, borderWidth: 0.75 });
      layout.page.drawRectangle({ x: MARGIN_X, y: top - height, width: 2.5, height, color: layout.brand });
      let y = top - 8;
      if (block.title) {
        layout.page.drawText(block.title.toUpperCase(), { x: MARGIN_X + 12, y: y - 8, size: 7.5, font: f.semibold, color: MUTED });
        y -= 14;
      }
      for (const [i, t] of lineTexts.entries()) {
        y -= layout.textInBox(t, MARGIN_X + 12, y, inner, { size: 9.5, bold: i === 0 && block.variant !== "deal" });
      }
      layout.y = top - height;
      break;
    }
    case "dynamicProperty":
      layout.drawRuns([{ text: block.label ? `${block.label} ` : "" }, { text: block.value, bold: true }], { size: 10 });
      break;
    case "productTable": {
      sectionTitle(layout, block.title);
      const numericCols = block.columns.filter((c) => c.key !== "name");
      const colW: Record<string, number> = { sku: 60, quantity: 38, unitPrice: 78, discount: 58, taxes: 70, total: 82 };
      const fixed = numericCols.reduce((s, c) => s + (colW[c.key] ?? 60), 0);
      const nameW = Math.max(120, CONTENT_W - fixed);
      const widths = block.columns.map((c) => (c.key === "name" ? nameW : colW[c.key] ?? 60));
      const drawHeader = () => {
        layout.ensure(22);
        let x = MARGIN_X;
        block.columns.forEach((c, i) => {
          const w = widths[i]!;
          layout.textInBox(c.label.toUpperCase(), x + 3, layout.y, w - 6, { size: 7.5, bold: true, color: MUTED, align: c.align });
          x += w;
        });
        layout.y -= 14;
        layout.page.drawLine({ start: { x: MARGIN_X, y: layout.y }, end: { x: PAGE_W - MARGIN_X, y: layout.y }, thickness: 1.2, color: BORDER });
        layout.y -= 4;
      };
      drawHeader();
      if (!block.rows.length) {
        layout.text("No items", { size: 9.5, color: MUTED });
      }
      for (const row of block.rows) {
        const nameText = row.name + (row.optional ? " (optional)" : "");
        const h = Math.max(
          layout.textHeight(nameText, nameW - 6, 9.5, true, 1.4) + (row.description ? layout.textHeight(row.description, nameW - 6, 8.5, false, 1.4) : 0),
          14,
        ) + 8;
        if (layout.y - h < MARGIN_BOTTOM) {
          layout.newPage();
          drawHeader();
        }
        const top = layout.y;
        let x = MARGIN_X;
        block.columns.forEach((c, i) => {
          const w = widths[i]!;
          if (c.key === "name") {
            const used = layout.textInBox(nameText, x + 3, top, w - 6, { size: 9.5, bold: true });
            if (row.description) layout.textInBox(row.description, x + 3, top - used, w - 6, { size: 8.5, color: MUTED });
          } else {
            layout.textInBox(row[c.key], x + 3, top, w - 6, { size: 9.5, align: c.align });
          }
          x += w;
        });
        layout.y = top - h;
        layout.page.drawLine({ start: { x: MARGIN_X, y: layout.y + 3 }, end: { x: PAGE_W - MARGIN_X, y: layout.y + 3 }, thickness: 0.5, color: BORDER });
      }
      break;
    }
    case "pricingSummary": {
      const width = 240;
      const x = PAGE_W - MARGIN_X - width;
      layout.ensure(block.rows.length * 18 + 20);
      if (block.title) {
        layout.textInBox(block.title, x, layout.y, width, { size: 11, bold: true });
        layout.y -= 18;
      }
      for (const r of block.rows) {
        layout.ensure(20);
        if (r.emphasis) {
          layout.page.drawLine({ start: { x, y: layout.y }, end: { x: x + width, y: layout.y }, thickness: 1.5, color: layout.brand });
          layout.y -= 4;
        }
        const size = r.emphasis ? 11.5 : 9.5;
        const h = Math.max(layout.textInBox(r.label, x, layout.y, width * 0.55, { size, bold: r.emphasis }), layout.textInBox(r.value, x + width * 0.45, layout.y, width * 0.55, { size, bold: r.emphasis, align: "right" }));
        layout.y -= h + 3;
      }
      break;
    }
    case "simpleTable": {
      if (!block.rows.length) break;
      sectionTitle(layout, block.title);
      const n = block.columns.length;
      const w = CONTENT_W / n;
      const header = () => {
        layout.ensure(22);
        block.columns.forEach((c, i) => layout.textInBox(c.toUpperCase(), MARGIN_X + i * w + 3, layout.y, w - 6, { size: 7.5, bold: true, color: MUTED, align: block.alignLastRight && i === n - 1 ? "right" : "left" }));
        layout.y -= 14;
        layout.page.drawLine({ start: { x: MARGIN_X, y: layout.y }, end: { x: PAGE_W - MARGIN_X, y: layout.y }, thickness: 1.2, color: BORDER });
        layout.y -= 4;
      };
      header();
      for (const row of block.rows) {
        const h = Math.max(...row.map((c) => layout.textHeight(c, w - 6, 9.5)), 12) + 6;
        if (layout.y - h < MARGIN_BOTTOM) {
          layout.newPage();
          header();
        }
        const top = layout.y;
        row.forEach((c, i) => layout.textInBox(c, MARGIN_X + i * w + 3, top, w - 6, { size: 9.5, align: block.alignLastRight && i === n - 1 ? "right" : "left" }));
        layout.y = top - h;
      }
      break;
    }
    case "section":
      layout.ensure(40);
      layout.hr();
      layout.y -= 4;
      sectionTitle(layout, block.title);
      await drawRich(layout, block.html);
      break;
    case "container":
      sectionTitle(layout, block.title);
      for (const child of block.children) {
        await renderBlock(child, layout, pdf, loader, images);
        layout.y -= BLOCK_GAP * 0.8;
      }
      break;
    case "signatureArea": {
      sectionTitle(layout, block.title);
      if (block.text) {
        layout.text(block.text, { size: 9.5 });
        layout.y -= 6;
      }
      const colW = (CONTENT_W - 16) / 2;
      for (let i = 0; i < block.signers.length; i += 2) {
        const pair = block.signers.slice(i, i + 2);
        const h = 104;
        layout.ensure(h + 8);
        const top = layout.y;
        for (const [j, s] of pair.entries()) {
          const x = MARGIN_X + j * (colW + 16);
          layout.page.drawRectangle({ x, y: top - h, width: colW, height: h, borderColor: BORDER, borderWidth: 0.75 });
          const lineY = top - 52;
          if (s.signature) {
            if (s.signature.method === "DRAWN" && s.signature.signatureData) {
              const img = await embedImage(pdf, loader, s.signature.signatureData, images);
              if (img) {
                const scale = Math.min((colW - 20) / img.width, 38 / img.height, 1);
                layout.page.drawImage(img, { x: x + 10, y: lineY + 3, width: img.width * scale, height: img.height * scale });
              }
            } else {
              layout.page.drawText(clean(s.signature.signatureData ?? s.name).slice(0, 60), { x: x + 10, y: lineY + 8, size: 18, font: f.boldItalic, color: INK });
            }
          } else {
            layout.page.drawText("Awaiting signature", { x: x + 10, y: lineY + 6, size: 8, font: f.italic, color: MUTED });
          }
          layout.page.drawLine({ start: { x: x + 10, y: lineY }, end: { x: x + colW - 10, y: lineY }, thickness: 0.75, color: MUTED });
          layout.textInBox(s.name, x + 10, lineY - 5, colW - 20, { size: 9.5, bold: true });
          layout.textInBox(s.email, x + 10, lineY - 18, colW - 20, { size: 8.5, color: MUTED });
          if (s.signedAtLabel) layout.textInBox(`Signed ${s.signedAtLabel}`, x + 10, lineY - 30, colW - 20, { size: 8, color: MUTED });
        }
        layout.y = top - h - 8;
      }
      if (!block.signers.length) layout.text("Signatories will appear here.", { size: 9.5, color: MUTED });
      break;
    }
    case "acceptanceArea": {
      sectionTitle(layout, block.title);
      if (block.text) layout.text(block.text, { size: 9.5 });
      if (block.acceptance) {
        const text = `Accepted by ${block.acceptance.name} (${block.acceptance.email}) on ${block.acceptance.signedAtLabel}`;
        const h = layout.textHeight(text, CONTENT_W - 20, 9.5, true) + 12;
        layout.ensure(h + 6);
        layout.y -= 4;
        layout.page.drawRectangle({ x: MARGIN_X, y: layout.y - h, width: CONTENT_W, height: h, color: GREEN_BG });
        layout.textInBox(text, MARGIN_X + 10, layout.y - 6, CONTENT_W - 20, { size: 9.5, bold: true, color: GREEN });
        layout.y -= h;
      }
      break;
    }
  }
}

function drawCertificate(layout: Layout, meta: PdfMeta) {
  const cert = meta.certificate!;
  layout.newPage();
  layout.text("Certificate of completion", { size: 18, bold: true });
  layout.y -= 4;
  layout.hr(layout.brand, 1.5);
  layout.y -= 6;
  const rows: [string, string][] = [
    ["Document", meta.title],
    ["Number", meta.number],
    ["Version", String(meta.versionNumber)],
    ["Issued by", meta.organizationName],
    ["Completed", cert.completedAt],
    ["Document hash (SHA-256)", meta.contentHash ?? "—"],
  ];
  for (const [k, v] of rows) {
    layout.ensure(16);
    const top = layout.y;
    layout.textInBox(k, MARGIN_X, top, 150, { size: 9, color: MUTED });
    const h = layout.textInBox(v, MARGIN_X + 160, top, CONTENT_W - 160, { size: 9 });
    layout.y = top - Math.max(h, 13) - 2;
  }
  layout.y -= 10;
  layout.text("Signatories", { size: 13, bold: true });
  layout.y -= 4;
  for (const e of cert.entries) {
    const lines: [string, string][] = [
      ["Name", e.signerName],
      ["Email (verified by one-time code)", e.signerEmail],
      ["Action", e.kind === "ACCEPTANCE" ? "Accepted" : `Signed (${e.method === "DRAWN" ? "drawn signature" : "typed signature"})`],
      ["Date", e.signedAt],
      ["Email verification", e.otpVerifiedAt ?? "—"],
      ["IP address", e.ip ?? "—"],
      ["Device", (e.userAgent ?? "—").slice(0, 160)],
      ["Consent", e.consentText ?? "—"],
    ];
    layout.ensure(130);
    layout.hr();
    layout.y -= 4;
    for (const [k, v] of lines) {
      layout.ensure(14);
      const top = layout.y;
      layout.textInBox(k, MARGIN_X, top, 150, { size: 8.5, color: MUTED });
      const h = layout.textInBox(v, MARGIN_X + 160, top, CONTENT_W - 160, { size: 8.5 });
      layout.y = top - Math.max(h, 12) - 1;
    }
    layout.y -= 6;
  }
  if (cert.events.length) {
    layout.y -= 6;
    layout.text("Audit trail", { size: 13, bold: true });
    layout.y -= 4;
    for (const ev of cert.events) {
      layout.ensure(13);
      const top = layout.y;
      layout.textInBox(ev.at, MARGIN_X, top, 170, { size: 8, color: MUTED });
      const h = layout.textInBox(ev.label, MARGIN_X + 175, top, CONTENT_W - 175, { size: 8 });
      layout.y = top - Math.max(h, 11);
    }
  }
  layout.y -= 10;
  layout.text(
    "This document was completed electronically with DealDocs. Signatories were identified by a one-time code sent to their email address. This certificate records the evidence collected; it does not by itself constitute a qualified electronic signature.",
    { size: 8, color: MUTED },
  );
}

export async function renderPdf(doc: ResolvedDocument, meta: PdfMeta, loader: ImageLoader): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const bytes = await loadFontBytes();
  const fonts: Fonts = {
    regular: await pdf.embedFont(bytes.regular!, { subset: true }),
    bold: await pdf.embedFont(bytes.bold!, { subset: true }),
    italic: await pdf.embedFont(bytes.italic!, { subset: true }),
    boldItalic: await pdf.embedFont(bytes.boldItalic!, { subset: true }),
    semibold: await pdf.embedFont(bytes.semibold!, { subset: true }),
  };
  pdf.setTitle(`${meta.title} (${meta.number})`);
  pdf.setAuthor(meta.organizationName);
  pdf.setCreator("DealDocs");
  pdf.setProducer("DealDocs");
  // Deterministic metadata dates are not required; creation date reflects generation time.

  const layout = new Layout(pdf, fonts, hexToRgb(doc.brandColor));
  const images = new Map<string, PDFImage | null>();
  for (const block of doc.blocks) {
    await renderBlock(block, layout, pdf, loader, images);
    layout.y -= BLOCK_GAP;
  }
  if (meta.certificate) drawCertificate(layout, meta);

  const total = layout.pages.length;
  layout.pages.forEach((page, i) => {
    const footer = `${meta.number} · Version ${meta.versionNumber}${meta.footerNote ? ` · ${meta.footerNote}` : ""}`;
    page.drawText(clean(footer).slice(0, 140), { x: MARGIN_X, y: 30, size: 7.5, font: fonts.regular, color: MUTED });
    const label = `Page ${i + 1} of ${total}`;
    page.drawText(label, { x: PAGE_W - MARGIN_X - fonts.regular.widthOfTextAtSize(label, 7.5), y: 30, size: 7.5, font: fonts.regular, color: MUTED });
  });
  return pdf.save();
}
