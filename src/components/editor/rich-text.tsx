"use client";

import { useEffect, useRef } from "react";
import type { VariableDefinition } from "@/domain/variables";
import { VariablePicker } from "./variable-picker";

/**
 * Lightweight rich-text editor (bold, italic, underline, lists, links, variables).
 * Output is sanitised again on the server before it is stored.
 */
export function RichTextEditor({ value, onChange, variables, placeholder, label }: { value: string; onChange: (html: string) => void; variables: VariableDefinition[]; placeholder?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el && el.innerHTML !== value) el.innerHTML = value;
  }, [value]);

  const exec = (command: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, arg);
    onChange(ref.current?.innerHTML ?? "");
  };
  const tool = (label: string, command: string, text: string, arg?: string) => (
    <button type="button" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(command, arg)} className="rounded px-2 py-0.5 text-sm text-slate-700 hover:bg-slate-200">
      {text}
    </button>
  );
  return (
    <div className="rounded-md border border-slate-300 bg-white focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/30">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50 px-1.5 py-1" role="toolbar" aria-label={`${label} formatting`}>
        {tool("Bold", "bold", "B")}
        {tool("Italic", "italic", "I")}
        {tool("Underline", "underline", "U")}
        {tool("Bulleted list", "insertUnorderedList", "• List")}
        {tool("Numbered list", "insertOrderedList", "1. List")}
        <button
          type="button"
          aria-label="Link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt("Link URL (https://…)");
            if (url && /^(https?:\/\/|mailto:)/i.test(url)) exec("createLink", url);
          }}
          className="rounded px-2 py-0.5 text-sm text-slate-700 hover:bg-slate-200"
        >
          Link
        </button>
        <span className="ml-auto">
          <VariablePicker compact variables={variables} onPick={(key) => exec("insertText", `{{${key}}}`)} label="Variable" />
        </span>
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder ?? "Write here…"}
        onInput={() => onChange(ref.current?.innerHTML ?? "")}
        onBlur={() => onChange(ref.current?.innerHTML ?? "")}
        className="rich-editor min-h-[90px] px-3 py-2 text-sm leading-relaxed outline-none"
      />
    </div>
  );
}
