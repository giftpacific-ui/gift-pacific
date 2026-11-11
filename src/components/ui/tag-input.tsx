"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { addKeywords, MAX_KEYWORDS, MAX_KEYWORD_LENGTH } from "@/lib/seo-keywords";
import { cn } from "@/lib/utils";

/**
 * Multi-value tag input. Enter or comma commits the typed text; pasting "a, b, c" creates three tags;
 * Backspace on an empty field removes the last tag; each tag has its own remove button.
 */
export function TagInput({
  value, onChange, label = "Keywords", placeholder = "Type a keyword, press Enter or comma", disabled, className,
}: { value: string[]; onChange: (next: string[]) => void; label?: string; placeholder?: string; disabled?: boolean; className?: string }) {
  const [draft, setDraft] = useState("");
  const id = useId();
  const full = value.length >= MAX_KEYWORDS;

  function commit(raw = draft) {
    if (raw.trim()) onChange(addKeywords(value, raw));
    setDraft("");
  }

  return (
    <div className={cn("space-y-2", className)}>
      <ul aria-label={`${label} (${value.length} of ${MAX_KEYWORDS})`} className="flex flex-wrap gap-1.5">
        {value.map((k, i) => (
          <li key={k} className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs">
            {k}
            <button
              type="button" disabled={disabled} aria-label={`Remove keyword ${k}`}
              className="rounded-full p-0.5 hover:bg-background focus-visible:outline focus-visible:outline-2"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            ><X className="size-3" aria-hidden /></button>
          </li>
        ))}
      </ul>
      <input
        id={id} type="text" value={draft} disabled={disabled || full} maxLength={MAX_KEYWORD_LENGTH * 10}
        aria-label={label} aria-describedby={`${id}-hint`}
        placeholder={full ? `Maximum of ${MAX_KEYWORDS} keywords` : placeholder}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
        onChange={(e) => {
          const v = e.target.value;
          // A comma (typed or pasted) commits everything before it; the remainder stays as the draft.
          if (v.includes(",") || v.includes("\n")) {
            const last = v.lastIndexOf(",");
            const head = v.slice(0, Math.max(last, v.lastIndexOf("\n")) + 1);
            onChange(addKeywords(value, head));
            setDraft(v.slice(head.length));
          } else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => commit()}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Separate keywords with Enter or a comma. Up to {MAX_KEYWORDS} keywords, {MAX_KEYWORD_LENGTH} characters each. Titles and descriptions matter far more for search than keywords.
      </p>
    </div>
  );
}
