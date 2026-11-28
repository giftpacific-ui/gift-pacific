/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  addBlock,
  BLOCK_LABELS,
  BLOCK_TYPES,
  CTA_SUGGESTIONS,
  duplicateBlock,
  FIELD_SPEC,
  moveBlock,
  removeBlock,
  type Block,
  type BlockType,
  type Design,
  type FieldSpec,
} from "@/lib/email-template-blocks";
import {
  previewEmailDesignAction,
  saveEmailTemplateAction,
} from "@/server/actions/admin-email-template.actions";
import type { PickerProduct } from "@/server/services/email-template-designer.service";
import { EmailPreview } from "./email-preview";
import { ProductPicker } from "./product-picker";
import { SendTestDialog } from "./send-test-dialog";

type Meta = {
  id: string | null;
  name: string;
  category: string;
  subject: string;
  status: "draft" | "active" | "archived" | "new";
  campaignCount: number;
};
type FieldIssue = { field: string; message: string };

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/**
 * Block-based e-mail designer built from the project's own UI primitives (no third-party editor). The editor holds a DESIGN (blocks with settings); it never
 * holds or sends HTML. Every change is validated and rendered by the server (preview action), and save sends the design to the server, which validates it
 * again, reads product data from the product table, renders the HTML + text and stores them through the existing template service.
 */
export function TemplateEditor({
  initial,
  initialDesign,
  initialProducts,
  categories,
}: {
  categories: readonly string[];
  initial: Meta;
  initialDesign: Design;
  initialProducts: Record<string, PickerProduct | null>;
}) {
  const router = useRouter();
  const [meta, setMeta] = useState({
    name: initial.name,
    category: initial.category,
    subject: initial.subject,
  });
  const [design, setDesign] = useState<Design>(initialDesign);
  const [products, setProducts] = useState(initialProducts);
  const [selected, setSelected] = useState<string | null>(
    initialDesign.blocks[1]?.id ?? initialDesign.blocks[0]?.id ?? null,
  );
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<{
    html: string | null;
    subject: string | null;
    error: string | null;
    loading: boolean;
  }>({ html: null, subject: null, error: null, loading: true });
  const [pending, start] = useTransition();
  const [dirty, setDirty] = useState(false);
  const seq = useRef(0);

  const touch = () => setDirty(true);
  const update = (fn: (d: Design) => Design) => {
    setDesign(fn);
    touch();
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Live preview: the server renders the real e-mail from the current design (debounced; a late answer for an older design is dropped).
  useEffect(() => {
    const mine = ++seq.current;
    setPreview((p) => ({ ...p, loading: true }));
    const t = setTimeout(async () => {
      const res = await previewEmailDesignAction({
        subject: meta.subject,
        design,
      });
      if (mine !== seq.current) return;
      setPreview(
        res.success
          ? {
              html: res.html,
              subject: res.subject,
              error: null,
              loading: false,
            }
          : { html: null, subject: null, error: res.message, loading: false },
      );
    }, 500);
    return () => clearTimeout(t);
  }, [design, meta.subject]);

  const sel = design.blocks.find((b) => b.id === selected) ?? null;
  const labelOf = (b: Block, i: number) => `${i + 1}. ${BLOCK_LABELS[b.type]}`;
  const issueFor = (path: string) =>
    issues.find((i) => i.field === path)?.message;
  const selIndex = sel ? design.blocks.findIndex((b) => b.id === sel.id) : -1;

  function act(
    res:
      | { ok: true; blocks: Block[]; id?: string }
      | { ok: false; message: string },
  ) {
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    update((d) => ({ ...d, blocks: res.blocks }));
    if (res.id) setSelected(res.id);
  }
  function setField(id: string, name: string, value: string | boolean) {
    update((d) => ({
      ...d,
      blocks: d.blocks.map((b) => (b.id === id ? { ...b, [name]: value } : b)),
    }));
  }

  function save(status: "draft" | "ready") {
    setNotice(null);
    setIssues([]);
    start(async () => {
      const res = await saveEmailTemplateAction({
        ...(initial.id ? { id: initial.id } : {}),
        name: meta.name,
        category: meta.category,
        subject: meta.subject,
        status,
        design,
      });
      if (res.success) {
        setDirty(false);
        setNotice({ ok: true, text: res.message });
        toast.success(res.message);
        if (res.created)
          router.replace(`/admin/email-marketing/templates/${res.id}`);
        else router.refresh();
      } else {
        setNotice({ ok: false, text: res.message });
        setIssues(
          (res.errors ?? []).map((e) => ({
            field: e.field,
            message: e.message,
          })),
        );
      }
    });
  }

  const summary = useMemo(
    () =>
      issues
        .map((i) => i.message)
        .filter((m, idx, a) => a.indexOf(m) === idx)
        .slice(0, 6),
    [issues],
  );
  const archived = initial.status === "archived";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">
            {initial.id ? "Edit template" : "New template"}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Build the e-mail from blocks. The footer is always last and always
            contains the unsubscribe link. Product names, prices and links are
            read from your shop when you save.
            {initial.campaignCount > 0 &&
              ` ${initial.campaignCount} campaign(s) already use this template; they keep their own copy and will not change.`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="ghost">
            <Link href="/admin/email-marketing/templates">
              Back to templates
            </Link>
          </Button>
          <SendTestDialog source={{ subject: meta.subject, design }} />
          <Button
            type="button"
            variant="outline"
            disabled={pending || archived}
            onClick={() => save("draft")}
          >
            {pending ? "Saving…" : "Save draft"}
          </Button>
          <Button
            type="button"
            disabled={pending || archived}
            onClick={() => save("ready")}
          >
            Save as ready
          </Button>
        </div>
      </div>

      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={`rounded-md border p-3 text-sm ${notice.ok ? "border-success/40 bg-success/10" : "border-destructive/40 bg-destructive/10 text-destructive"}`}
        >
          {notice.text}
        </p>
      )}
      {summary.length > 1 && (
        <ul
          role="alert"
          className="list-disc rounded-md border border-destructive/40 bg-destructive/10 p-3 pl-7 text-sm text-destructive"
        >
          {summary.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <Card>
        <CardContent className="grid gap-4 p-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="t-name">Template name</Label>
            <Input
              id="t-name"
              value={meta.name}
              maxLength={120}
              onChange={(e) => {
                setMeta({ ...meta, name: e.target.value });
                touch();
              }}
              aria-invalid={!!issueFor("name")}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-cat">Category</Label>
            <select
              id="t-cat"
              className={SELECT}
              value={meta.category}
              onChange={(e) => {
                setMeta({ ...meta, category: e.target.value });
                touch();
              }}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0) + c.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-subject">Subject line</Label>
            <Input
              id="t-subject"
              value={meta.subject}
              maxLength={200}
              onChange={(e) => {
                setMeta({ ...meta, subject: e.target.value });
                touch();
              }}
              aria-invalid={!!issueFor("subject")}
            />
            <p className="text-xs text-muted-foreground">
              You can use {"{{firstName}}"}, {"{{customerName}}"}, {"{{email}}"}{" "}
              and {"{{storeName}}"}.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-pre">
              Preview text (shown next to the subject in inboxes)
            </Label>
            <Input
              id="t-pre"
              value={design.preheader}
              maxLength={150}
              onChange={(e) =>
                update((d) => ({ ...d, preheader: e.target.value }))
              }
              aria-invalid={!!issueFor("preheader")}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-medium">Blocks</h2>
                <div
                  className="flex flex-wrap gap-1.5"
                  role="group"
                  aria-label="Add block"
                >
                  {BLOCK_TYPES.filter((t) => t !== "footer").map(
                    (t: BlockType) => (
                      <Button
                        key={t}
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => act(addBlock(design.blocks, t))}
                      >
                        <Plus /> {BLOCK_LABELS[t]}
                      </Button>
                    ),
                  )}
                </div>
              </div>
              <ol className="space-y-1.5">
                {design.blocks.map((b, i) => {
                  const hasIssue = issues.some((x) =>
                    x.field.startsWith(`blocks[${i}]`),
                  );
                  const pinned = b.type === "footer" || b.type === "header";
                  return (
                    <li
                      key={b.id}
                      className={`flex items-center gap-2 rounded-md border p-2 ${b.id === selected ? "border-primary bg-primary/5" : ""} ${hasIssue ? "border-destructive" : ""}`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left text-sm"
                        onClick={() => setSelected(b.id)}
                        aria-current={b.id === selected}
                      >
                        <span className="font-medium">{labelOf(b, i)}</span>
                        <span className="ml-2 truncate text-muted-foreground">
                          {blockHint(b)}
                        </span>
                      </button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Move ${labelOf(b, i)} up`}
                        disabled={
                          pinned ||
                          (i <= 1 && design.blocks[0]?.type === "header")
                        }
                        onClick={() =>
                          act(moveBlock(design.blocks, b.id, "up"))
                        }
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Move ${labelOf(b, i)} down`}
                        disabled={pinned || i >= design.blocks.length - 2}
                        onClick={() =>
                          act(moveBlock(design.blocks, b.id, "down"))
                        }
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Duplicate ${labelOf(b, i)}`}
                        disabled={pinned}
                        onClick={() => act(duplicateBlock(design.blocks, b.id))}
                      >
                        <Copy />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove ${labelOf(b, i)}`}
                        disabled={b.type === "footer"}
                        onClick={() => {
                          act(removeBlock(design.blocks, b.id));
                          if (selected === b.id) setSelected(null);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  );
                })}
              </ol>
              {!design.blocks.some((b) => b.type === "header") && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => act(addBlock(design.blocks, "header"))}
                >
                  <Plus /> Add header
                </Button>
              )}
            </CardContent>
          </Card>

          {sel && (
            <Card>
              <CardContent className="space-y-4 p-4">
                <h2 className="font-medium">
                  {BLOCK_LABELS[sel.type]} settings
                </h2>
                {sel.type === "footer" && (
                  <p className="rounded-md bg-muted p-3 text-sm">
                    The unsubscribe link is added automatically and cannot be
                    removed.
                  </p>
                )}
                {(
                  Object.entries(FIELD_SPEC[sel.type]) as [string, FieldSpec][]
                ).map(([name, spec]) => (
                  <FieldEditor
                    key={`${sel.id}-${name}`}
                    id={`${sel.id}-${name}`}
                    spec={spec}
                    name={name}
                    blockType={sel.type}
                    value={sel[name]}
                    error={issueFor(`blocks[${selIndex}].${name}`)}
                    product={
                      name === "productId"
                        ? products[String(sel[name])]
                        : undefined
                    }
                    onChange={(v) => setField(sel.id, name, v)}
                    onPickProduct={(p) => {
                      setProducts((m) => ({ ...m, [p.id]: p }));
                      setField(sel.id, "productId", p.id);
                    }}
                  />
                ))}
                {issueFor(`blocks[${selIndex}]`) && (
                  <p role="alert" className="text-sm text-destructive">
                    {issueFor(`blocks[${selIndex}]`)}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <EmailPreview
            html={preview.html}
            subject={preview.subject}
            error={preview.error}
            loading={preview.loading}
          />
        </div>
      </div>
    </div>
  );
}

function blockHint(b: Block): string {
  const pick = (k: string) =>
    typeof b[k] === "string" ? (b[k] as string) : "";
  return (
    pick("heading") ||
    pick("headline") ||
    pick("label") ||
    pick("body") ||
    pick("note")
  ).slice(0, 40);
}

function FieldEditor({
  id,
  name,
  spec,
  blockType,
  value,
  error,
  product,
  onChange,
  onPickProduct,
}: {
  id: string;
  name: string;
  spec: FieldSpec;
  blockType: BlockType;
  value: string | boolean | undefined;
  error?: string;
  product?: PickerProduct | null;
  onChange: (v: string | boolean) => void;
  onPickProduct: (p: PickerProduct) => void;
}) {
  const str = typeof value === "string" ? value : "";
  const err = error ? (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  ) : null;
  switch (spec.kind) {
    case "bool":
      return (
        <div className="flex items-start gap-2">
          <Checkbox
            id={id}
            checked={value === true}
            onCheckedChange={(v) => onChange(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor={id} className="font-normal leading-snug">
            {spec.label}
          </Label>
        </div>
      );
    case "enum":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{spec.label}</Label>
          <select
            id={id}
            className={SELECT}
            value={str}
            onChange={(e) => onChange(e.target.value)}
          >
            {spec.values.map((v) => (
              <option key={v} value={v}>
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </option>
            ))}
          </select>
        </div>
      );
    case "color":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{spec.label}</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={`${spec.label} picker`}
              value={/^#[0-9a-f]{6}$/i.test(str) ? str : "#a63a5b"}
              onChange={(e) => onChange(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded border bg-background p-1"
            />
            <Input
              id={id}
              value={str}
              maxLength={7}
              placeholder="#A63A5B"
              onChange={(e) => onChange(e.target.value)}
              aria-invalid={!!error}
              className="max-w-32"
            />
            {!spec.required && str && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onChange("")}
              >
                Use brand colour
              </Button>
            )}
          </div>
          {err}
        </div>
      );
    case "multiline":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{spec.label}</Label>
          <Textarea
            id={id}
            rows={blockType === "text" ? 7 : 3}
            maxLength={spec.max}
            value={str}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
          />
          {blockType === "text" && name === "body" && (
            <p className="text-xs text-muted-foreground">
              Formatting: **bold**, *italic*, [link text](https://…). A blank
              line starts a new paragraph.
            </p>
          )}
          {err}
        </div>
      );
    case "productId":
      return (
        <div className="space-y-1.5">
          <Label>{spec.label}</Label>
          <ProductPicker value={str} product={product} onPick={onPickProduct} />
          {err}
        </div>
      );
    case "code":
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{spec.label}</Label>
          <Input
            id={id}
            value={str}
            maxLength={32}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            aria-invalid={!!error}
            className="max-w-60 font-mono"
          />
          {err}
        </div>
      );
    default: // text, url, image
      return (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{spec.label}</Label>
          <Input
            id={id}
            value={str}
            maxLength={"max" in spec ? spec.max : 2000}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
            list={
              blockType === "cta" && name === "label"
                ? "cta-suggestions"
                : undefined
            }
            placeholder={
              spec.kind === "url"
                ? "https://… or /shop"
                : spec.kind === "image"
                  ? "https://… (store or approved image host)"
                  : undefined
            }
          />
          {blockType === "cta" && name === "label" && (
            <datalist id="cta-suggestions">
              {CTA_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          {err}
        </div>
      );
  }
}
