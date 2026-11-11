"use client";

import { useEffect, useRef } from "react";
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link as LinkIcon,
  Heading2,
  RemoveFormatting,
} from "lucide-react";
import { cn } from "@/lib/utils";

type RichTextEditorProps = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
};

const TOOLBAR_BUTTONS: Array<{
  command: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  arg?: string;
}> = [
  { command: "bold", label: "Bold", icon: Bold },
  { command: "italic", label: "Italic", icon: Italic },
  { command: "underline", label: "Underline", icon: Underline },
  { command: "formatBlock", label: "Heading", icon: Heading2, arg: "h3" },
  { command: "insertUnorderedList", label: "Bullet list", icon: List },
  { command: "insertOrderedList", label: "Numbered list", icon: ListOrdered },
];

/**
 * A small WYSIWYG editor for rich-text product descriptions. It edits real
 * HTML (bold/italic/underline/headings/lists/links) via a contentEditable
 * region, not a plain `<textarea>` — the saved `value` is HTML, and the
 * public product page renders it with `dangerouslySetInnerHTML`.
 *
 * Deliberately built without a rich-text library (Tiptap/Quill/etc): this
 * sandbox has no network access to install and verify a new dependency,
 * and the project's instructions call for avoiding unnecessary third-party
 * libraries where a simpler solution fits. `document.execCommand` is
 * deprecated but still implemented by all current major browsers for this
 * exact set of basic formatting commands, which is all this admin form
 * needs — this is not a plan for long-term architecture, just the
 * pragmatic choice for this project's scope.
 *
 * Content is only trusted-admin-authored (this form is behind
 * `requireAdmin()`), which is the same trust boundary as the rest of the
 * admin panel — there is no untrusted user input flowing into this HTML.
 */
export function RichTextEditor({ value, onChange, placeholder, className }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isFocused = useRef(false);

  // Only push external `value` changes into the DOM when the editor isn't
  // focused — otherwise every keystroke's onChange -> value -> re-sync
  // round-trip would reset the cursor position to the start.
  useEffect(() => {
    if (editorRef.current && !isFocused.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value || "";
    }
  }, [value]);

  function exec(command: string, arg?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    if (editorRef.current) onChange(editorRef.current.innerHTML);
  }

  function handleLink() {
    const url = window.prompt("Link URL");
    if (url) exec("createLink", url);
  }

  return (
    <div className={cn("rounded-lg border border-input bg-card", className)}>
      <div className="flex flex-wrap gap-1 border-b border-input p-1.5">
        {TOOLBAR_BUTTONS.map(({ command, label, icon: Icon, arg }) => (
          <button
            key={command + (arg ?? "")}
            type="button"
            aria-label={label}
            title={label}
            onMouseDown={(e) => e.preventDefault()} // keep focus/selection in the editor
            onClick={() => exec(command, arg)}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Icon className="size-4" />
          </button>
        ))}
        <button
          type="button"
          aria-label="Insert link"
          title="Insert link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleLink}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <LinkIcon className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Clear formatting"
          title="Clear formatting"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => exec("removeFormat")}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <RemoveFormatting className="size-4" />
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onFocus={() => (isFocused.current = true)}
        onBlur={() => (isFocused.current = false)}
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
        data-placeholder={placeholder}
        className={cn(
          "min-h-40 max-w-none px-4 py-3 text-sm outline-none",
          "[&_h3]:font-heading [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1",
          "[&_p]:mb-3 [&_p:last-child]:mb-0",
          "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-3",
          "[&_a]:text-primary [&_a]:underline",
          "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
        )}
      />
    </div>
  );
}
