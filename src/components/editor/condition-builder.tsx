"use client";

import type { Condition } from "@/domain/conditions";
import { CONDITION_OPERATORS, OPERATOR_LABELS, VALUELESS_OPERATORS } from "@/domain/conditions";
import type { VariableDefinition } from "@/domain/variables";
import { Button, Input, Select } from "../ui";

/** "Show this section when [Field] [Operator] [Value]" rule builder. */
export function ConditionBuilder({ value, onChange, variables }: { value: Condition | null; onChange: (c: Condition | null) => void; variables: VariableDefinition[] }) {
  const fields = [
    ...variables,
    { key: "lineItems.category", label: "Any product category", group: "Products" },
    { key: "lineItems.name", label: "Any product name", group: "Products" },
  ];
  if (!value) {
    return (
      <div>
        <p className="mb-2 text-xs text-slate-500">Always visible.</p>
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ match: "all", rules: [{ field: "document.total", operator: "greater_than", value: "10000" }] })}>
          + Add visibility rule
        </Button>
      </div>
    );
  }
  const update = (index: number, patch: Partial<Condition["rules"][number]>) =>
    onChange({ ...value, rules: value.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-slate-600">
        Show this block when
        <Select aria-label="Match" value={value.match} onChange={(e) => onChange({ ...value, match: e.target.value as "all" | "any" })} className="w-auto py-1 text-xs">
          <option value="all">all rules match</option>
          <option value="any">any rule matches</option>
        </Select>
      </div>
      {value.rules.map((rule, i) => (
        <div key={i} className="space-y-1 rounded border border-slate-200 p-2">
          <Select aria-label="Field" value={rule.field} onChange={(e) => update(i, { field: e.target.value })} className="py-1 text-xs">
            {fields.map((f) => <option key={f.key} value={f.key}>{f.group} → {f.label}</option>)}
          </Select>
          <div className="flex gap-1">
            <Select aria-label="Operator" value={rule.operator} onChange={(e) => update(i, { operator: e.target.value as (typeof CONDITION_OPERATORS)[number] })} className="py-1 text-xs">
              {CONDITION_OPERATORS.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
            </Select>
            {!VALUELESS_OPERATORS.includes(rule.operator) ? <Input aria-label="Value" value={rule.value} onChange={(e) => update(i, { value: e.target.value })} className="py-1 text-xs" /> : null}
            <button type="button" aria-label="Remove rule" onClick={() => onChange(value.rules.length > 1 ? { ...value, rules: value.rules.filter((_, j) => j !== i) } : null)} className="px-1 text-slate-400 hover:text-red-600">✕</button>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => onChange({ ...value, rules: [...value.rules, { field: "document.total", operator: "greater_than", value: "" }] })}>+ Rule</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>Remove visibility rules</Button>
      </div>
    </div>
  );
}
