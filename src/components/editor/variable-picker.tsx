"use client";

import { useEffect, useRef, useState } from "react";
import type { VariableDefinition } from "@/domain/variables";

/**
 * "Insert variable" menu: users pick Contact → First name instead of typing {{contact.firstName}}.
 */
export function VariablePicker({ variables, onPick, label = "Insert variable", compact }: { variables: VariableDefinition[]; onPick: (key: string) => void; label?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const groups = [...new Set(variables.map((v) => v.group))];
  const q = filter.toLowerCase();
  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className={compact ? "rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-50" : "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"}
      >
        {"{ }"} {label}
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 z-40 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-slate-200 bg-white p-2 shadow-xl">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search variables…"
            aria-label="Search variables"
            className="mb-2 w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
          {groups.map((g) => {
            const items = variables.filter((v) => v.group === g && (!q || v.label.toLowerCase().includes(q) || v.key.toLowerCase().includes(q)));
            if (!items.length) return null;
            return (
              <div key={g} className="mb-1">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g}</p>
                {items.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onPick(v.key);
                      setOpen(false);
                      setFilter("");
                    }}
                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-brand-50"
                  >
                    <span>{v.label}</span>
                    <span className="font-mono text-[10px] text-slate-400">{v.key}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Insert text at the caret of an input/textarea and return the new value. */
export function insertAtCaret(el: HTMLInputElement | HTMLTextAreaElement | null, current: string, text: string): string {
  if (!el) return current + text;
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  const next = current.slice(0, start) + text + current.slice(end);
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(start + text.length, start + text.length);
  });
  return next;
}
