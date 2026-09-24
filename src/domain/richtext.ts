import sanitizeHtml from "sanitize-html";
import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/**
 * Rich text is stored as a strict HTML subset. It is sanitised on every write
 * and again at render time (defence in depth against stored XSS).
 */
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "h3", "h4", "a", "span"],
  allowedAttributes: { a: ["href", "target", "rel"], span: ["data-variable"] },
  allowedSchemes: ["https", "http", "mailto"],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer nofollow" }),
    b: "strong",
    i: "em",
  },
};

export function sanitizeRichText(html: string): string {
  return sanitizeHtml(html, RICH_TEXT_OPTIONS);
}

export function plainTextToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  href?: string;
}

export interface RichParagraph {
  kind: "p" | "h3" | "h4" | "li";
  /** Bullet for list items: "•" or "1." */
  marker?: string;
  depth?: number;
  runs: TextRun[];
}

/** Convert sanitised rich text into paragraphs/runs (used by the PDF renderer). */
export function richTextToParagraphs(html: string): RichParagraph[] {
  const doc = parseDocument(sanitizeRichText(html), { decodeEntities: true });
  const paragraphs: RichParagraph[] = [];
  let current: RichParagraph | null = null;

  const ensure = (): RichParagraph => {
    if (!current) {
      current = { kind: "p", runs: [] };
      paragraphs.push(current);
    }
    return current;
  };
  const close = () => {
    current = null;
  };

  const walk = (nodes: ChildNode[], style: Omit<TextRun, "text">, listCtx: { ordered: boolean; index: number; depth: number } | null) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const text = (node as unknown as { data: string }).data.replace(/\s+/g, " ");
        if (text.trim() === "" && !current) continue;
        ensure().runs.push({ text, ...style });
        continue;
      }
      if (node.type !== "tag") continue;
      const el = node as Element;
      switch (el.name) {
        case "p":
        case "h3":
        case "h4":
          close();
          current = { kind: el.name as RichParagraph["kind"], runs: [] };
          paragraphs.push(current);
          walk(el.children, el.name === "p" ? style : { ...style, bold: true }, listCtx);
          close();
          break;
        case "br":
          ensure().runs.push({ text: "\n", ...style });
          break;
        case "strong":
          walk(el.children, { ...style, bold: true }, listCtx);
          break;
        case "em":
          walk(el.children, { ...style, italic: true }, listCtx);
          break;
        case "u":
          walk(el.children, { ...style, underline: true }, listCtx);
          break;
        case "a":
          walk(el.children, { ...style, underline: true, href: el.attribs.href }, listCtx);
          break;
        case "ul":
        case "ol": {
          close();
          const ctx = { ordered: el.name === "ol", index: 0, depth: (listCtx?.depth ?? -1) + 1 };
          walk(el.children, style, ctx);
          close();
          break;
        }
        case "li": {
          close();
          if (listCtx) listCtx.index += 1;
          current = {
            kind: "li",
            marker: listCtx?.ordered ? `${listCtx.index}.` : "•",
            depth: listCtx?.depth ?? 0,
            runs: [],
          };
          paragraphs.push(current);
          walk(el.children, style, listCtx);
          close();
          break;
        }
        default:
          walk(el.children, style, listCtx);
      }
    }
  };
  walk(doc.children, {}, null);
  return paragraphs
    .map((p) => ({ ...p, runs: p.runs.filter((r) => r.text !== "") }))
    .filter((p) => p.runs.some((r) => r.text.trim() !== ""));
}
