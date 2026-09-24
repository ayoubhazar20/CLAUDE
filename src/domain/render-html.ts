import type { ResolvedBlock, ResolvedDocument } from "./resolve";
import { escapeHtml } from "./variables";

/**
 * The single HTML renderer for documents. Used by the editor preview, the
 * public client page and the immutable HTML snapshot stored at publication.
 * All text is escaped; rich text was sanitised during resolution.
 */

const e = escapeHtml;

function nl2br(text: string): string {
  return e(text).replace(/\n/g, "<br>");
}

function safeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#2563eb";
}

function renderBlock(block: ResolvedBlock, opts: RenderOptions): string {
  const attrs = opts.blockAttributes ? ` data-block-id="${e(block.id)}"` : "";
  switch (block.type) {
    case "heading": {
      const tag = `h${block.level}`;
      return `<${tag} class="dd-h dd-h${block.level} dd-align-${e(block.align)}"${attrs}>${e(block.text)}</${tag}>`;
    }
    case "paragraph":
      return block.text.trim() ? `<p class="dd-p dd-align-${e(block.align)}"${attrs}>${nl2br(block.text)}</p>` : opts.blockAttributes ? `<p class="dd-p dd-empty"${attrs}></p>` : "";
    case "richText":
      return `<div class="dd-rich"${attrs}>${block.html}</div>`;
    case "logo":
      return block.url
        ? `<div class="dd-logo dd-align-${e(block.align)}"${attrs}><img src="${e(block.url)}" alt="${e(block.alt)}" style="max-height:${Number(block.maxHeight)}px"></div>`
        : opts.blockAttributes
          ? `<div class="dd-logo dd-placeholder"${attrs}>Company logo</div>`
          : "";
    case "image":
      return block.url
        ? `<figure class="dd-image dd-w-${e(block.width)} dd-align-${e(block.align)}"${attrs}><img src="${e(block.url)}" alt="${e(block.alt)}"></figure>`
        : opts.blockAttributes
          ? `<div class="dd-image dd-placeholder"${attrs}>Image</div>`
          : "";
    case "divider":
      return `<hr class="dd-divider"${attrs}>`;
    case "spacer":
      return `<div class="dd-spacer dd-spacer-${e(block.size)}"${attrs}></div>`;
    case "pageBreak":
      return `<div class="dd-page-break"${attrs}></div>`;
    case "infoCard": {
      const lines = block.lines
        .map((l) => `<div class="dd-info-line">${l.label ? `<span class="dd-info-label">${e(l.label)}</span> ` : ""}<span>${e(l.value)}</span></div>`)
        .join("");
      return `<section class="dd-info dd-info-${block.variant}"${attrs}>${block.title ? `<div class="dd-info-title">${e(block.title)}</div>` : ""}${lines || '<div class="dd-muted">—</div>'}</section>`;
    }
    case "dynamicProperty":
      return `<div class="dd-prop"${attrs}>${block.label ? `<span class="dd-prop-label">${e(block.label)}</span> ` : ""}<span class="dd-prop-value">${e(block.value)}</span></div>`;
    case "productTable": {
      const head = block.columns.map((c) => `<th class="dd-${c.align}">${e(c.label)}</th>`).join("");
      const rows = block.rows.length
        ? block.rows
            .map((r) => {
              const cells = block.columns
                .map((c) => {
                  if (c.key === "name") {
                    return `<td><div class="dd-item-name">${e(r.name)}${r.optional ? ' <span class="dd-badge">Optional</span>' : ""}</div>${r.description ? `<div class="dd-item-desc">${nl2br(r.description)}</div>` : ""}</td>`;
                  }
                  return `<td class="dd-${c.align}">${e(r[c.key])}</td>`;
                })
                .join("");
              return `<tr>${cells}</tr>`;
            })
            .join("")
        : `<tr><td colspan="${block.columns.length}" class="dd-muted">No items</td></tr>`;
      return `<section class="dd-table-wrap"${attrs}>${block.title ? `<h3 class="dd-section-title">${e(block.title)}</h3>` : ""}<div class="dd-scroll"><table class="dd-table dd-products"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
    }
    case "pricingSummary": {
      const rows = block.rows
        .map((r) => `<tr class="${r.emphasis ? "dd-total" : ""}"><td>${e(r.label)}</td><td class="dd-right">${e(r.value)}</td></tr>`)
        .join("");
      return `<section class="dd-summary"${attrs}>${block.title ? `<h3 class="dd-section-title">${e(block.title)}</h3>` : ""}<table class="dd-table dd-summary-table"><tbody>${rows}</tbody></table></section>`;
    }
    case "simpleTable": {
      if (!block.rows.length && !opts.blockAttributes) return "";
      const n = block.columns.length;
      const head = block.columns.map((c, i) => `<th class="${block.alignLastRight && i === n - 1 ? "dd-right" : ""}">${e(c)}</th>`).join("");
      const rows = block.rows.length
        ? block.rows.map((r) => `<tr>${r.map((c, i) => `<td class="${block.alignLastRight && i === n - 1 ? "dd-right" : ""}">${nl2br(c)}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${n}" class="dd-muted">Nothing to show</td></tr>`;
      return `<section class="dd-table-wrap"${attrs}>${block.title ? `<h3 class="dd-section-title">${e(block.title)}</h3>` : ""}<div class="dd-scroll"><table class="dd-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
    }
    case "section":
      return `<section class="dd-legal dd-${block.variant}"${attrs}>${block.title ? `<h3 class="dd-section-title">${e(block.title)}</h3>` : ""}<div class="dd-rich">${block.html}</div></section>`;
    case "container": {
      const inner = block.children.map((c) => renderBlock(c, opts)).join("");
      if (!inner && !opts.blockAttributes) return "";
      return `<section class="dd-container"${attrs}>${block.title ? `<h3 class="dd-section-title">${e(block.title)}</h3>` : ""}${inner}</section>`;
    }
    case "signatureArea": {
      const signers = block.signers.length
        ? block.signers
            .map((s) => {
              let sig = `<div class="dd-sig-line dd-muted">Awaiting signature</div>`;
              if (s.signature) {
                sig =
                  s.signature.method === "DRAWN" && s.signature.signatureData?.startsWith("data:image/png;base64,")
                    ? `<img class="dd-sig-img" src="${e(s.signature.signatureData)}" alt="Signature of ${e(s.name)}">`
                    : `<div class="dd-sig-typed">${e(s.signature.signatureData ?? s.name)}</div>`;
              }
              return `<div class="dd-signer">${sig}<div class="dd-signer-name">${e(s.name)}</div><div class="dd-muted">${e(s.email)}</div>${s.signedAtLabel ? `<div class="dd-muted">Signed ${e(s.signedAtLabel)}</div>` : ""}</div>`;
            })
            .join("")
        : `<div class="dd-muted">Signatories will appear here.</div>`;
      return `<section class="dd-signatures"${attrs}>${block.title ? `<h3 class="dd-section-title">${e(block.title)}</h3>` : ""}${block.text ? `<p class="dd-p">${nl2br(block.text)}</p>` : ""}<div class="dd-signers">${signers}</div></section>`;
    }
    case "acceptanceArea": {
      const status = block.acceptance
        ? `<div class="dd-accepted">Accepted by ${e(block.acceptance.name)} (${e(block.acceptance.email)}) on ${e(block.acceptance.signedAtLabel)}</div>`
        : "";
      return `<section class="dd-acceptance"${attrs}>${block.title ? `<h3 class="dd-section-title">${e(block.title)}</h3>` : ""}${block.text ? `<p class="dd-p">${nl2br(block.text)}</p>` : ""}${status}</section>`;
    }
  }
}

export interface RenderOptions {
  /** Adds data-block-id attributes (editor selection). */
  blockAttributes?: boolean;
}

export function renderDocumentHtml(doc: ResolvedDocument, opts: RenderOptions = {}): string {
  const body = doc.blocks.map((b) => renderBlock(b, opts)).join("\n");
  return `<article class="dd-doc" style="--dd-brand:${safeColor(doc.brandColor)}">${body}</article>`;
}

/** Self-contained HTML snapshot (stored as publication evidence). */
export function renderStandaloneHtml(doc: ResolvedDocument, title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${e(title)}</title><style>${DOCUMENT_CSS}</style></head><body>${renderDocumentHtml(doc)}</body></html>`;
}

export const DOCUMENT_CSS = `
.dd-doc{--dd-brand:#2563eb;color:#111827;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;display:flex;flex-direction:column;gap:18px;word-wrap:break-word}
.dd-doc *{box-sizing:border-box}
.dd-h{margin:0;line-height:1.25;color:#0f172a}
.dd-h1{font-size:28px;font-weight:700}
.dd-h2{font-size:21px;font-weight:650;border-bottom:2px solid var(--dd-brand);padding-bottom:4px}
.dd-h3{font-size:17px;font-weight:600}
.dd-p{margin:0}
.dd-align-center{text-align:center}.dd-align-right{text-align:right}
.dd-rich p{margin:0 0 8px}.dd-rich ul,.dd-rich ol{margin:0 0 8px;padding-left:22px}.dd-rich ul{list-style:disc}.dd-rich ol{list-style:decimal}.dd-rich li{display:list-item}.dd-rich h3{font-size:16px;margin:8px 0 4px}.dd-rich h4{font-size:15px;margin:8px 0 4px}
.dd-rich a{color:var(--dd-brand)}
.dd-logo img{max-width:240px;object-fit:contain}
.dd-image{margin:0}.dd-image img{max-width:100%;height:auto;border-radius:4px}.dd-w-small img{max-width:33%}.dd-w-medium img{max-width:60%}
.dd-divider{border:0;border-top:1px solid #e5e7eb;margin:4px 0;width:100%}
.dd-spacer-sm{height:8px}.dd-spacer-md{height:24px}.dd-spacer-lg{height:48px}
.dd-page-break{border-top:1px dashed #d1d5db;height:0}
.dd-info{border:1px solid #e5e7eb;border-left:3px solid var(--dd-brand);border-radius:6px;padding:12px 14px;background:#fafafa}
.dd-info-title{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;font-weight:600;margin-bottom:4px}
.dd-info-label{color:#6b7280}
.dd-prop-label{color:#6b7280}.dd-prop-value{font-weight:600}
.dd-section-title{font-size:16px;font-weight:650;margin:0 0 8px;color:#0f172a}
.dd-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.dd-table{width:100%;border-collapse:collapse;font-size:14px}
.dd-table th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;border-bottom:2px solid #e5e7eb;padding:8px}
.dd-table td{border-bottom:1px solid #f1f5f9;padding:10px 8px;vertical-align:top}
.dd-right{text-align:right !important;white-space:nowrap}
.dd-item-name{font-weight:600}.dd-item-desc{color:#4b5563;font-size:13px;margin-top:2px}
.dd-badge{display:inline-block;font-size:11px;font-weight:600;color:#92400e;background:#fef3c7;border-radius:4px;padding:0 6px}
.dd-summary{margin-left:auto;width:100%;max-width:380px}
.dd-summary-table td{border-bottom:1px solid #f1f5f9}
.dd-summary-table .dd-total td{font-weight:700;font-size:16px;border-top:2px solid var(--dd-brand);border-bottom:none}
.dd-legal{border-top:1px solid #e5e7eb;padding-top:12px}
.dd-container{display:flex;flex-direction:column;gap:14px}
.dd-signers{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:8px}
.dd-signer{border:1px solid #e5e7eb;border-radius:6px;padding:12px}
.dd-sig-line{border-bottom:1px solid #9ca3af;height:48px;margin-bottom:6px;display:flex;align-items:flex-end;font-size:12px}
.dd-sig-img{max-height:64px;max-width:100%;display:block;margin-bottom:6px}
.dd-sig-typed{font-family:"Brush Script MT","Segoe Script",cursive;font-size:28px;line-height:48px;border-bottom:1px solid #9ca3af;margin-bottom:6px}
.dd-signer-name{font-weight:600}
.dd-accepted{margin-top:8px;padding:10px 12px;border-radius:6px;background:#ecfdf5;color:#065f46;font-weight:600}
.dd-muted{color:#6b7280;font-size:13px}
.dd-placeholder{border:1px dashed #cbd5e1;border-radius:6px;padding:14px;color:#94a3b8;text-align:center;font-size:13px}
.dd-empty{min-height:20px}
[data-variable]{background:#fef3c7;border-radius:3px;padding:0 3px;font-size:.92em}
@media (max-width:640px){.dd-doc{font-size:14px}.dd-h1{font-size:23px}.dd-table td,.dd-table th{padding:8px 6px}}
@media print{.dd-page-break{page-break-after:always;border:0}}
`;
