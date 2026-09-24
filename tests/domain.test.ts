import { describe, expect, it } from "vitest";
import { createBlock, parseBlocks, validateLockedBlocks } from "@/domain/blocks";
import { evaluateCondition } from "@/domain/conditions";
import { interpolate, escapeHtml } from "@/domain/variables";
import { sanitizeRichText } from "@/domain/richtext";
import { canTransition } from "@/domain/status";
import { formatDocumentNumber } from "@/domain/numbering";
import { SYSTEM_ROLES, viewScope, editScope } from "@/domain/permissions";

describe("variables", () => {
  it("interpolates and escapes values", () => {
    expect(interpolate("Hi {{contact.firstName}}!", { "contact.firstName": "Amina" })).toBe("Hi Amina!");
    expect(interpolate("{{ x }}", { x: "<b>" }, escapeHtml)).toBe("&lt;b&gt;");
    expect(interpolate("{{missing}}", {})).toBe("");
  });
});

describe("rich text sanitisation", () => {
  it("strips scripts, handlers and javascript URLs", () => {
    const html = sanitizeRichText('<p onclick="x()">ok<script>alert(1)</script><a href="javascript:alert(1)">l</a><img src=x onerror=1></p>');
    expect(html).not.toMatch(/script|onclick|onerror|javascript|<img/i);
    expect(html).toContain("ok");
  });
});

describe("conditions", () => {
  const ctx = { values: { "document.total": "12500.00", "custom.flag": "true", "company.name": "" }, lineItems: [{ category: "Consulting", name: "A" }, { category: "Hardware", name: "B" }] };
  it("supports all operators", () => {
    const rule = (field: string, operator: never, value = "") => ({ match: "all" as const, rules: [{ field, operator, value }] });
    expect(evaluateCondition(rule("document.total", "greater_than" as never, "10000"), ctx)).toBe(true);
    expect(evaluateCondition(rule("document.total", "less_than" as never, "10000"), ctx)).toBe(false);
    expect(evaluateCondition(rule("custom.flag", "equals" as never, "TRUE"), ctx)).toBe(true);
    expect(evaluateCondition(rule("custom.flag", "not_equals" as never, "false"), ctx)).toBe(true);
    expect(evaluateCondition(rule("company.name", "is_empty" as never), ctx)).toBe(true);
    expect(evaluateCondition(rule("document.total", "is_not_empty" as never), ctx)).toBe(true);
    expect(evaluateCondition(rule("lineItems.category", "equals" as never, "consulting"), ctx)).toBe(true);
    expect(evaluateCondition(rule("lineItems.category", "contains" as never, "soft"), ctx)).toBe(false);
  });
  it("supports any/all matching", () => {
    const any = { match: "any" as const, rules: [{ field: "document.total", operator: "less_than" as const, value: "1" }, { field: "custom.flag", operator: "equals" as const, value: "true" }] };
    expect(evaluateCondition(any, ctx)).toBe(true);
    expect(evaluateCondition({ ...any, match: "all" }, ctx)).toBe(false);
  });
});

describe("locked blocks", () => {
  const legal = { ...createBlock("clause", { title: "Legal", html: "<p>Binding</p>" }), locked: true };
  const intro = createBlock("paragraph", { text: "Editable" });
  const original = [intro, legal];

  it("allows editing unlocked blocks and adding new ones", () => {
    const updated = [{ ...intro, props: { ...intro.props, text: "Changed" } }, legal, createBlock("paragraph", { text: "new" })];
    expect(validateLockedBlocks(original, updated)).toEqual([]);
  });
  it("rejects edits, removal, unlocking and reordering of locked blocks", () => {
    expect(validateLockedBlocks(original, [intro, { ...legal, props: { ...legal.props, html: "<p>Changed</p>" } }])).not.toEqual([]);
    expect(validateLockedBlocks(original, [intro])).not.toEqual([]);
    expect(validateLockedBlocks(original, [intro, { ...legal, locked: false }])).not.toEqual([]);
    const legal2 = { ...createBlock("clause", { title: "L2" }), locked: true };
    expect(validateLockedBlocks([legal, legal2], [legal2, legal])).toContain("Locked blocks cannot be reordered");
  });
  it("rejects locking new blocks from a document", () => {
    expect(validateLockedBlocks(original, [...original, { ...createBlock("paragraph"), locked: true }])).not.toEqual([]);
  });
  it("parses and validates untrusted block trees", () => {
    expect(() => parseBlocks([{ id: "x", type: "heading", props: {} }])).toThrow();
    expect(() => parseBlocks([{ id: "abcd1234", type: "evil", props: {} }])).toThrow();
    const parsed = parseBlocks([{ id: "abcd1234", type: "heading", props: { text: "Hi" } }]);
    expect(parsed[0]!.props).toMatchObject({ text: "Hi", level: 2 });
  });
});

describe("status machine", () => {
  it("enforces document-type statuses and transitions", () => {
    expect(canTransition("QUOTE", "SENT", "ACCEPTED")).toBe(true);
    expect(canTransition("QUOTE", "SENT", "SIGNED")).toBe(false);
    expect(canTransition("CONTRACT", "VIEWED", "AWAITING_SIGNATURE")).toBe(true);
    expect(canTransition("CONTRACT", "DRAFT", "SIGNED")).toBe(false);
    expect(canTransition("CONTRACT", "SIGNED", "PUBLISHED")).toBe(true); // revision after signature
    expect(canTransition("QUOTE", "ACCEPTED", "REJECTED")).toBe(false);
  });
});

describe("numbering", () => {
  it("formats numbers with prefix, year and padding", () => {
    expect(formatDocumentNumber({ prefix: "Q", includeYear: true, padding: 6, startNumber: 1 }, 21, 2026)).toBe("Q-2026-000021");
    expect(formatDocumentNumber({ prefix: "CTR", includeYear: false, padding: 4, startNumber: 1 }, 7, 2026)).toBe("CTR-0007");
  });
});

describe("permissions", () => {
  it("derives access scopes from permissions, not role names", () => {
    expect(viewScope(new Set(SYSTEM_ROLES.admin.permissions))).toBe("all");
    expect(viewScope(new Set(SYSTEM_ROLES.manager.permissions))).toBe("team");
    expect(viewScope(new Set(SYSTEM_ROLES.user.permissions))).toBe("own");
    expect(editScope(new Set(SYSTEM_ROLES.viewer.permissions))).toBe("none");
  });
});
