import { z } from "zod";
import { D } from "./money";

/**
 * Conditional visibility rules: "Show this section when [field] [operator] [value]".
 * Fields are variable keys (e.g. "document.total", "custom.warranty") or the special
 * collection field "lineItems.category" / "lineItems.name" which matches when ANY line
 * item satisfies the rule.
 */
export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "less_than",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  greater_than: "greater than",
  less_than: "less than",
};

export const VALUELESS_OPERATORS: readonly ConditionOperator[] = ["is_empty", "is_not_empty"];

export const conditionRuleSchema = z.object({
  field: z.string().min(1).max(120),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.string().max(500).default(""),
});

export const conditionSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  rules: z.array(conditionRuleSchema).max(20),
});

export type ConditionRule = z.infer<typeof conditionRuleSchema>;
export type Condition = z.infer<typeof conditionSchema>;

export interface ConditionContext {
  /** Flat variable map, values as display-independent raw strings. */
  values: Record<string, string>;
  /** Collection values for lineItems.* fields. */
  lineItems: Record<string, string>[];
}

function toNumber(value: string): InstanceType<typeof D> | null {
  const cleaned = value.replace(/[\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return new D(cleaned);
}

export function evaluateRuleOnValue(raw: string | undefined, operator: ConditionOperator, expected: string): boolean {
  const value = (raw ?? "").trim();
  const target = expected.trim();
  switch (operator) {
    case "is_empty":
      return value === "";
    case "is_not_empty":
      return value !== "";
    case "equals": {
      const a = toNumber(value);
      const b = toNumber(target);
      if (a && b) return a.equals(b);
      return value.toLowerCase() === target.toLowerCase();
    }
    case "not_equals": {
      const a = toNumber(value);
      const b = toNumber(target);
      if (a && b) return !a.equals(b);
      return value.toLowerCase() !== target.toLowerCase();
    }
    case "contains":
      return target !== "" && value.toLowerCase().includes(target.toLowerCase());
    case "greater_than":
    case "less_than": {
      const a = toNumber(value);
      const b = toNumber(target);
      if (a && b) return operator === "greater_than" ? a.greaterThan(b) : a.lessThan(b);
      // ISO dates compare lexicographically.
      if (/^\d{4}-\d{2}-\d{2}/.test(value) && /^\d{4}-\d{2}-\d{2}/.test(target)) {
        return operator === "greater_than" ? value > target : value < target;
      }
      return false;
    }
  }
}

export function evaluateRule(rule: ConditionRule, ctx: ConditionContext): boolean {
  if (rule.field.startsWith("lineItems.")) {
    const prop = rule.field.slice("lineItems.".length);
    const values = ctx.lineItems.map((li) => li[prop]);
    if (rule.operator === "is_empty") return values.every((v) => evaluateRuleOnValue(v, "is_empty", ""));
    if (rule.operator === "not_equals") return values.every((v) => evaluateRuleOnValue(v, "not_equals", rule.value));
    return values.some((v) => evaluateRuleOnValue(v, rule.operator, rule.value));
  }
  return evaluateRuleOnValue(ctx.values[rule.field], rule.operator, rule.value);
}

export function evaluateCondition(condition: Condition | null | undefined, ctx: ConditionContext): boolean {
  if (!condition || condition.rules.length === 0) return true;
  return condition.match === "any"
    ? condition.rules.some((r) => evaluateRule(r, ctx))
    : condition.rules.every((r) => evaluateRule(r, ctx));
}
