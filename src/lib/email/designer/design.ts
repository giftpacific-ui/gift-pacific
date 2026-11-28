/**
 * Email template designer (P12-UI-02): validation, the safe renderer and the storage encoding. PURE (no database, no network): everything it needs from
 * outside (public origin, store settings, product data) is passed in, so it is fully testable. Server-side only, like the rest of src/lib/email.
 *
 * Security model:
 *  - A design is DATA. The renderer is the only thing that produces HTML; every text value is HTML-escaped, every URL is checked against a scheme and
 *    host allow-list first, colours must be #rrggbb, and no field is ever copied into the output as markup.
 *  - Text may use the existing placeholders only ({{customerName}} etc.). Unknown placeholders are refused per field.
 *  - The footer is mandatory and always renders the {{unsubscribeUrl}} link and text line; there is no setting that can switch it off.
 *  - The generated HTML still goes through the existing template service (validateTemplateContent: findUnsafeHtml, placeholder scan, size limits).
 */

import imageHosts from "../../../../image-hosts.json";
import { DESIGN_MARKER_PREFIX, stripDesignMarker } from "./marker";
import { isLoopbackHost } from "@/lib/email/list-unsubscribe";
import { scanPlaceholders, SUPPORTED_TEMPLATE_VARIABLES, type FieldError } from "@/lib/email/template-rules";
import {
  ALIGNMENTS, BLOCK_TYPES, DESIGN_LIMITS, FIELD_SPEC, isBlockId, isBlockType, readableOn, type Block, type BlockType, type Design, type FieldSpec,
} from "@/lib/email-template-blocks";

export type DesignContext = { origin: string; production: boolean };

const err = (field: string, code: string, message: string): FieldError => ({ field, code, message });
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const MULTILINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const COUPON = /^[A-Za-z0-9_-]{2,32}$/;
const MAX_URL = 2000;

// ---------------------------------------------------------------------------------------------------------------------------------------- URLs

/**
 * A link target. https always; http only outside production (and only for a loopback host); a root-relative path ("/shop") is resolved against the
 * public origin. Never javascript:, data:, mailto:, file: and so on, no credentials, no spaces or control characters, no braces (so no placeholder or
 * expression can hide in a URL).
 */
export function resolveLinkUrl(raw: unknown, ctx: DesignContext): { ok: true; url: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Enter a web address." };
  const v = raw.trim();
  if (!v) return { ok: false, message: "Enter a web address." };
  if (v.length > MAX_URL) return { ok: false, message: `The web address must be at most ${MAX_URL} characters.` };
  if (CONTROL.test(v) || /[\s{}<>"'`\\]/.test(v)) return { ok: false, message: "The web address contains characters that are not allowed." };
  let u: URL;
  try {
    u = v.startsWith("/") && !v.startsWith("//") ? new URL(v, ctx.origin) : new URL(v);
  } catch {
    return { ok: false, message: "Enter a full web address starting with https://, or a path such as /shop." };
  }
  if (u.username || u.password) return { ok: false, message: "The web address must not contain a user name or password." };
  const httpsOk = u.protocol === "https:";
  const httpOk = u.protocol === "http:" && !ctx.production && isLoopbackHost(u.hostname);
  if (!httpsOk && !httpOk) return { ok: false, message: "Only https:// web addresses are allowed." };
  if (!u.hostname) return { ok: false, message: "Enter a full web address." };
  return { ok: true, url: u.href };
}

const hostMatches = (host: string, pattern: string) => {
  const h = host.toLowerCase(), p = pattern.toLowerCase();
  if (!p.startsWith("*.")) return h === p;
  const suffix = p.slice(1); // ".supabase.co"
  return h.endsWith(suffix) && !h.slice(0, -suffix.length).includes(".") && h.length > suffix.length;
};

/** Hosts that only exist on the sender's own machine or network: a mail client can never load an image from them. */
function isNonPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h) || h === "0.0.0.0" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return h.includes(":") && (h === "::1" || /^(fc|fd|fe80)/.test(h)); // IPv6 loopback / unique-local / link-local
}

/** Paths that are derived or private, not a stable public file: the Next.js image optimizer and the app's own API routes. */
const NON_PUBLIC_IMAGE_PATH = /^\/(?:_next|api)(?:\/|$)/i;

/**
 * An image source for an OUTBOUND e-mail. A link target (see above) whose host is the public site or one of the hosts in image-hosts.json (the same
 * list the shop uses), AND that a mail client can actually fetch: https, a public host (never localhost / a private address, even in development),
 * and a stable public file (never a /_next/image optimizer URL or an /api route). A root-relative path is resolved against the public origin, which
 * is itself refused when that origin is not public. A valid URL is returned exactly as given (no rewriting).
 */
export function resolveImageUrl(raw: unknown, ctx: DesignContext): { ok: true; url: string } | { ok: false; message: string } {
  const link = resolveLinkUrl(raw, ctx);
  if (!link.ok) return { ok: false, message: link.message.replace("web address", "image address") };
  const u = new URL(link.url);
  const own = new URL(ctx.origin).hostname;
  const allowed = u.hostname.toLowerCase() === own.toLowerCase() || (imageHosts.hosts as string[]).some((p) => hostMatches(u.hostname, p));
  if (!allowed) return { ok: false, message: "Images must come from this store or an approved image host (upload the image to the product or media library first)." };
  if (u.protocol !== "https:" || isNonPublicHost(u.hostname)) {
    return { ok: false, message: "E-mail images must be public https:// addresses. A local or private address (such as localhost) cannot be loaded by a customer's mail app; use an uploaded image (Cloudinary) or set NEXT_PUBLIC_APP_URL to the public https site address." };
  }
  if (NON_PUBLIC_IMAGE_PATH.test(u.pathname)) return { ok: false, message: "Use the original image address, not a temporary optimised (/_next/image) or API address." };
  return { ok: true, url: u.href };
}

// ----------------------------------------------------------------------------------------------------------------------------------- validation

export type ValidatedDesign = { design: Design; productIds: string[] };

const LINK_MD = /\[([^\]\n]{1,100})\]\(([^)\s]{1,2000})\)/g;

function checkPlaceholders(value: string, field: string, errors: FieldError[]) {
  for (const p of scanPlaceholders(value).problems) {
    errors.push(p.code === "unsupported_variable"
      ? err(field, "unsupported_variable", `Unsupported variable "${p.detail}". Supported: ${SUPPORTED_TEMPLATE_VARIABLES.join(", ")}.`)
      : err(field, "malformed_placeholder", p.detail));
  }
}

function validateField(spec: FieldSpec, raw: unknown, field: string, ctx: DesignContext, errors: FieldError[]): string | boolean {
  const bad = (code: string, message: string) => { errors.push(err(field, code, message)); return spec.def; };
  switch (spec.kind) {
    case "bool":
      return typeof raw === "boolean" ? raw : bad("invalid_type", `${spec.label} must be on or off.`);
    case "enum":
      return typeof raw === "string" && spec.values.includes(raw) ? raw : bad("invalid_value", `${spec.label} must be one of: ${spec.values.join(", ")}.`);
    case "color": {
      if (raw === undefined || raw === null || raw === "") return spec.required ? bad("required", `${spec.label} is required.`) : "";
      return typeof raw === "string" && HEX.test(raw) ? raw.toLowerCase() : bad("invalid_color", `${spec.label} must look like #A63A5B.`);
    }
    case "productId":
      return isBlockId(raw) ? (raw as string) : bad("required", "Choose a product.");
    case "code": {
      if (raw === undefined || raw === null || raw === "") return "";
      return typeof raw === "string" && COUPON.test(raw.trim()) ? raw.trim().toUpperCase() : bad("invalid_coupon", "A coupon code has 2 to 32 letters, digits, - or _.");
    }
    case "url":
    case "image": {
      if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return spec.required ? bad("required", `${spec.label} is required.`) : "";
      const res = spec.kind === "url" ? resolveLinkUrl(raw, ctx) : resolveImageUrl(raw, ctx);
      return res.ok ? (raw as string).trim() : bad("invalid_url", res.message); // the ORIGINAL text is kept (a relative path stays relative); the renderer resolves it again
    }
    case "text":
    case "multiline": {
      if (raw === undefined || raw === null) raw = "";
      if (typeof raw !== "string") return bad("invalid_type", `${spec.label} must be text.`);
      if ((spec.kind === "text" ? CONTROL : MULTILINE_CONTROL).test(raw)) return bad("control_characters", `${spec.label} must not contain control characters${spec.kind === "text" ? " or line breaks" : ""}.`);
      let value = raw.normalize("NFC");
      value = spec.kind === "text" ? value.replace(/\s+/g, " ").trim() : value.replace(/\r\n?/g, "\n").trim();
      if (value.length > spec.max) return bad("too_long", `${spec.label} must be at most ${spec.max} characters.`);
      if (!value && spec.required) return bad("required", `${spec.label} is required.`);
      checkPlaceholders(value, field, errors);
      if (spec.kind === "multiline") {
        for (const m of value.matchAll(LINK_MD)) {
          const link = resolveLinkUrl(m[2], ctx);
          if (!link.ok) errors.push(err(field, "invalid_url", `The link "${m[1]}" is not allowed: ${link.message}`));
        }
      }
      return value;
    }
  }
}

/**
 * Strict validation of a design received from the browser. Unknown block types, unknown fields, wrong types, bad URLs, bad colours, too many blocks,
 * a missing/duplicated/misplaced footer or header: all refused with a path such as `blocks[2].url`. Returns a CLEAN copy (only known fields).
 */
export function validateDesign(raw: unknown, ctx: DesignContext): { ok: true; value: ValidatedDesign } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: [err("design", "invalid_type", "The design is missing.")] };
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== "preheader" && k !== "blocks") errors.push(err(`design.${k}`, "unsupported_field", `"${k}" is not a design field.`));

  const preheaderSpec: FieldSpec = { kind: "text", max: DESIGN_LIMITS.preheader, def: "", label: "Preview text" };
  const preheader = validateField(preheaderSpec, obj.preheader, "preheader", ctx, errors) as string;

  if (!Array.isArray(obj.blocks)) { errors.push(err("blocks", "invalid_type", "The design needs a list of blocks.")); return { ok: false, errors }; }
  if (obj.blocks.length === 0) errors.push(err("blocks", "required", "Add at least one block."));
  if (obj.blocks.length > DESIGN_LIMITS.blocks) { errors.push(err("blocks", "too_many", `A template can have at most ${DESIGN_LIMITS.blocks} blocks.`)); return { ok: false, errors }; }

  const blocks: Block[] = [];
  const seen = new Set<string>();
  const productIds: string[] = [];
  obj.blocks.forEach((rawBlock, i) => {
    const at = `blocks[${i}]`;
    if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) { errors.push(err(at, "invalid_type", "A block must be an object.")); return; }
    const b = rawBlock as Record<string, unknown>;
    if (!isBlockType(b.type)) { errors.push(err(`${at}.type`, "invalid_block_type", `Block type must be one of: ${BLOCK_TYPES.join(", ")}.`)); return; }
    const type: BlockType = b.type;
    if (!isBlockId(b.id)) errors.push(err(`${at}.id`, "invalid_id", "A block needs a short ID (letters, digits, - or _)."));
    else if (seen.has(b.id)) errors.push(err(`${at}.id`, "duplicate_id", "Two blocks share the same ID."));
    else seen.add(b.id);
    const specs = FIELD_SPEC[type] as Record<string, FieldSpec>;
    for (const k of Object.keys(b)) if (k !== "id" && k !== "type" && !(k in specs)) errors.push(err(`${at}.${k}`, "unsupported_field", `"${k}" is not a field of a ${type} block.`));
    const out: Block = { id: typeof b.id === "string" ? b.id : "", type };
    for (const [name, spec] of Object.entries(specs)) out[name] = validateField(spec, b[name], `${at}.${name}`, ctx, errors);
    // cross-field rules
    if (type === "hero" && !out.heading && !out.imageUrl) errors.push(err(at, "empty_block", "A hero banner needs a heading or an image."));
    if (type === "hero" && out.linkUrl && !out.linkLabel) errors.push(err(`${at}.linkLabel`, "required", "Give the link button a label."));
    if (type === "text" && !out.heading && !out.body) errors.push(err(at, "empty_block", "A text block needs a heading or a paragraph."));
    if (type === "promo" && !out.couponCode && !out.description && !out.headline) errors.push(err(at, "empty_block", "A promotional section needs a message."));
    if (type === "product" && typeof out.productId === "string" && out.productId) productIds.push(out.productId);
    blocks.push(out);
  });

  const footers = blocks.filter((b) => b.type === "footer");
  if (footers.length !== 1) errors.push(err("blocks", "footer_required", "A template needs exactly one footer: it carries the required unsubscribe link."));
  else if (blocks[blocks.length - 1].type !== "footer") errors.push(err("blocks", "footer_not_last", "The footer must be the last block."));
  const headers = blocks.filter((b) => b.type === "header");
  if (headers.length > 1) errors.push(err("blocks", "too_many_headers", "A template has only one header."));
  else if (headers.length === 1 && blocks[0].type !== "header") errors.push(err("blocks", "header_not_first", "The header must be the first block."));
  if (productIds.length > DESIGN_LIMITS.productBlocks) errors.push(err("blocks", "too_many_products", `A template can have at most ${DESIGN_LIMITS.productBlocks} product blocks.`));

  if (errors.length) return { ok: false, errors };
  const design: Design = { preheader, blocks };
  if (JSON.stringify(design).length > DESIGN_LIMITS.designJson) return { ok: false, errors: [err("design", "too_large", "The design is too large. Remove some blocks or shorten the text.")] };
  return { ok: true, value: { design, productIds: [...new Set(productIds)] } };
}

// ------------------------------------------------------------------------------------------------------------------------------------- render

export type DesignBrand = {
  storeName: string; logoUrl: string | null; primary: string; currencyCode: string; currencySymbol: string;
  email: string | null; phone: string | null; address: string | null; social: { label: string; url: string }[];
};
/** Product data as the shop holds it NOW (read from the product table by the service, never from the browser). */
export type DesignProduct = { id: string; name: string; imageUrl: string | null; price: number; fromPrice: boolean; compareAtPrice: number | null; currency: string; url: string };
export type RenderContext = DesignContext & { brand: DesignBrand; products: ReadonlyMap<string, DesignProduct> };

// "=" is escaped too: inside an attribute value (alt text, a product name) a typed `onerror=` is then plain text and cannot even resemble an event handler
// to the existing unsafe-HTML guard (findUnsafeHtml), which would otherwise refuse a harmless alt text.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/=/g, "&#61;");
/** An image address inside a double-quoted attribute: only & < > " ' are escaped, so a valid URL (including its ?a=b query) reaches the mail client unchanged. */
const escUrl = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const FONT = "Arial,Helvetica,sans-serif";
const INK = "#1c1917", MUTED = "#57534e", LINE = "#e7e5e4";

export function formatMoney(amount: number, currency: string, brand: Pick<DesignBrand, "currencyCode" | "currencySymbol">): string {
  const n = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  return currency === brand.currencyCode ? `${brand.currencySymbol}${n}` : `${currency} ${n}`;
}
/** Whole-number discount when the original price is really higher than the current price; otherwise null (never invented). */
export function discountPercent(price: number, compareAt: number | null): number | null {
  if (compareAt === null || !(compareAt > price) || !(price >= 0)) return null;
  const pct = Math.round((1 - price / compareAt) * 100);
  return pct >= 1 && pct <= 99 ? pct : null;
}

function inlineHtml(value: string, ctx: RenderContext): string {
  const fmt = (s: string) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "<em>$1</em>");
  let out = "", last = 0;
  for (const m of value.matchAll(LINK_MD)) {
    out += fmt(value.slice(last, m.index));
    const link = resolveLinkUrl(m[2], ctx);
    out += link.ok ? `<a href="${esc(link.url)}" style="color:${ctx.brand.primary};text-decoration:underline;">${fmt(m[1])}</a>` : fmt(m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  return out + fmt(value.slice(last));
}
function inlineText(value: string, ctx: RenderContext): string {
  return value.replace(LINK_MD, (all, label: string, url: string) => { const l = resolveLinkUrl(url, ctx); return l.ok ? `${label} (${l.url})` : all; }).replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1");
}
const paragraphs = (value: string, ctx: RenderContext, style: string) =>
  value.split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p style="${style}">${inlineHtml(p, ctx).replace(/\n/g, "<br>")}</p>`).join("");

const row = (inner: string, pad = "16px 32px", bg?: string) => `<tr><td class="gp-pad" style="padding:${pad};${bg ? `background-color:${bg};` : ""}font-family:${FONT};">${inner}</td></tr>`;

function button(label: string, url: string, o: { color: string; style: "solid" | "outline"; align: string }): string {
  const fg = o.style === "solid" ? readableOn(o.color) : o.color;
  const bg = o.style === "solid" ? `background-color:${o.color};` : "background-color:#ffffff;";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${o.align}" style="margin:0 ${o.align === "center" ? "auto" : "0"};"><tr><td align="center" bgcolor="${o.style === "solid" ? o.color : "#ffffff"}" style="${bg}border:2px solid ${o.color};border-radius:6px;"><a href="${esc(url)}" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:16px;font-weight:bold;line-height:20px;color:${fg};text-decoration:none;">${esc(label)}</a></td></tr></table>`;
}

function renderBlockHtml(b: Block, ctx: RenderContext): string {
  const brand = ctx.brand;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const align = ALIGNMENTS.includes(s("align") as never) ? s("align") : "left";
  switch (b.type) {
    case "header": {
      const bg = s("background"), fg = readableOn(bg);
      const parts: string[] = [];
      const logo = b.showLogo === true && brand.logoUrl ? resolveImageUrl(brand.logoUrl, ctx) : null;
      if (logo?.ok) parts.push(`<img src="${escUrl(logo.url)}" alt="{{storeName}}" height="48" style="display:inline-block;height:48px;max-width:200px;border:0;outline:none;">`);
      if (b.showStoreName === true) parts.push(`<div style="font-family:${FONT};font-size:22px;font-weight:bold;line-height:28px;color:${fg};padding-top:${parts.length ? "8px" : "0"};">{{storeName}}</div>`);
      return parts.length ? row(parts.join(""), "20px 32px", bg).replace('<td class="gp-pad"', `<td align="${align}" class="gp-pad"`) : "";
    }
    case "hero": {
      const img = s("imageUrl") ? resolveImageUrl(s("imageUrl"), ctx) : null;
      const link = s("linkUrl") ? resolveLinkUrl(s("linkUrl"), ctx) : null;
      const image = img?.ok ? `<tr><td style="padding:0;">${link?.ok ? `<a href="${esc(link.url)}">` : ""}<img class="gp-img" src="${escUrl(img.url)}" alt="${esc(s("imageAlt"))}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;">${link?.ok ? "</a>" : ""}</td></tr>` : "";
      const body = [
        s("heading") ? `<h1 style="margin:0 0 10px;font-family:${FONT};font-size:28px;line-height:34px;color:${INK};">${inlineHtml(s("heading"), ctx)}</h1>` : "",
        s("text") ? paragraphs(s("text"), ctx, `margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:24px;color:${MUTED};`) : "",
        link?.ok && s("linkLabel") ? button(s("linkLabel"), link.url, { color: brand.primary, style: "solid", align }) : "",
      ].join("");
      return image + (body ? `<tr><td align="${align}" class="gp-pad" style="padding:24px 32px 12px;font-family:${FONT};">${body}</td></tr>` : "");
    }
    case "text": {
      const inner = (s("heading") ? `<h2 style="margin:0 0 8px;font-family:${FONT};font-size:22px;line-height:28px;color:${INK};">${inlineHtml(s("heading"), ctx)}</h2>` : "") + paragraphs(s("body"), ctx, `margin:0 0 12px;font-family:${FONT};font-size:16px;line-height:24px;color:${INK};`);
      return row(inner).replace('<td class="gp-pad"', `<td align="${align}" class="gp-pad"`);
    }
    case "product": {
      const p = ctx.products.get(s("productId"));
      if (!p) return ""; // the service refuses to render when a product is missing; this keeps the renderer total
      const pct = b.showDiscount === true ? discountPercent(p.price, p.compareAtPrice) : null;
      const money = (n: number) => formatMoney(n, p.currency, brand);
      const pimg = p.imageUrl ? resolveImageUrl(p.imageUrl, ctx) : null;
      const img = pimg?.ok ? `<tr><td style="padding:0;"><a href="${esc(p.url)}"><img class="gp-img" src="${escUrl(pimg.url)}" alt="${esc(p.name)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;border-radius:8px 8px 0 0;"></a></td></tr>` : "";
      const priceLine = `<span style="font-size:20px;font-weight:bold;color:${brand.primary};">${p.fromPrice ? "From " : ""}${esc(money(p.price))}</span>`
        + (pct !== null && p.compareAtPrice !== null ? ` <span style="font-size:15px;color:#78716c;text-decoration:line-through;">${esc(money(p.compareAtPrice))}</span> <span style="display:inline-block;padding:2px 8px;border-radius:10px;background-color:${brand.primary};color:${readableOn(brand.primary)};font-size:12px;font-weight:bold;">-${pct}%</span>` : "");
      const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${LINE};border-radius:8px;background-color:#ffffff;">${img}<tr><td align="center" style="padding:16px 20px 22px;font-family:${FONT};"><div style="font-size:18px;line-height:24px;font-weight:bold;color:${INK};margin:0 0 6px;"><a href="${esc(p.url)}" style="color:${INK};text-decoration:none;">${esc(p.name)}</a></div><div style="margin:0 0 14px;line-height:26px;">${priceLine}</div>${button(s("ctaLabel"), p.url, { color: brand.primary, style: "solid", align: "center" })}</td></tr></table>`;
      return row(card, "12px 32px");
    }
    case "promo": {
      const bg = s("background"), fg = readableOn(bg);
      const code = s("couponCode") ? `<div style="margin:12px 0;"><span style="display:inline-block;padding:10px 22px;border:2px dashed ${fg};border-radius:6px;font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:bold;letter-spacing:2px;color:${fg};">${esc(s("couponCode"))}</span></div>` : "";
      const inner = `<div style="font-size:26px;line-height:32px;font-weight:bold;color:${fg};">${inlineHtml(s("headline"), ctx)}</div>${code}`
        + (s("description") ? paragraphs(s("description"), ctx, `margin:8px 0 0;font-size:15px;line-height:22px;color:${fg};`) : "")
        + (s("expiryText") ? `<div style="margin-top:10px;font-size:13px;line-height:18px;color:${fg};opacity:0.85;">${inlineHtml(s("expiryText"), ctx)}</div>` : "");
      return row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${bg}" style="padding:24px 20px;background-color:${bg};border-radius:8px;font-family:${FONT};">${inner}</td></tr></table>`, "12px 32px");
    }
    case "cta": {
      const link = resolveLinkUrl(s("url"), ctx);
      if (!link.ok) return "";
      return row(button(s("label"), link.url, { color: s("color") || brand.primary, style: s("style") === "outline" ? "outline" : "solid", align }), "20px 32px");
    }
    case "footer": {
      const lines: string[] = [];
      if (b.showStoreInfo === true) { lines.push(`<strong>{{storeName}}</strong>`); if (brand.address) lines.push(esc(brand.address)); }
      if (b.showContact === true) { if (brand.email) lines.push(esc(brand.email)); if (brand.phone) lines.push(esc(brand.phone)); }
      const social = b.showSocial === true ? brand.social.filter((x) => resolveLinkUrl(x.url, ctx).ok).map((x) => `<a href="${esc(resolveLinkUrl(x.url, ctx).ok ? (resolveLinkUrl(x.url, ctx) as { url: string }).url : "")}" style="color:${MUTED};text-decoration:underline;">${esc(x.label)}</a>`) : [];
      const small = `font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};`;
      const inner = (s("note") ? paragraphs(s("note"), ctx, `margin:0 0 10px;${small}`) : "")
        + (lines.length ? `<p style="margin:0 0 10px;${small}">${lines.join("<br>")}</p>` : "")
        + (social.length ? `<p style="margin:0 0 10px;${small}">${social.join(" &nbsp;|&nbsp; ")}</p>` : "")
        + `<p style="margin:0;${small}">You are receiving this e-mail because you agreed to receive marketing e-mail from {{storeName}}.<br><a href="{{unsubscribeUrl}}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a></p>`;
      return `<tr><td align="center" class="gp-pad" style="padding:24px 32px;background-color:#f5f5f4;border-top:1px solid ${LINE};font-family:${FONT};">${inner}</td></tr>`;
    }
  }
}

function renderBlockText(b: Block, ctx: RenderContext): string {
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const t = (v: string) => inlineText(v, ctx);
  switch (b.type) {
    case "header": return b.showStoreName === true ? "{{storeName}}" : "";
    case "hero": { const l = s("linkUrl") ? resolveLinkUrl(s("linkUrl"), ctx) : null; return [t(s("heading")), t(s("text")), l?.ok && s("linkLabel") ? `${s("linkLabel")}: ${l.url}` : ""].filter(Boolean).join("\n"); }
    case "text": return [t(s("heading")), t(s("body"))].filter(Boolean).join("\n");
    case "product": {
      const p = ctx.products.get(s("productId"));
      if (!p) return "";
      const pct = b.showDiscount === true ? discountPercent(p.price, p.compareAtPrice) : null;
      const price = `${p.fromPrice ? "From " : ""}${formatMoney(p.price, p.currency, ctx.brand)}${pct !== null && p.compareAtPrice !== null ? ` (was ${formatMoney(p.compareAtPrice, p.currency, ctx.brand)}, -${pct}%)` : ""}`;
      return `${p.name}\n${price}\n${s("ctaLabel")}: ${p.url}`;
    }
    case "promo": return [t(s("headline")), s("couponCode") ? `Coupon code: ${s("couponCode")}` : "", t(s("description")), t(s("expiryText"))].filter(Boolean).join("\n");
    case "cta": { const l = resolveLinkUrl(s("url"), ctx); return l.ok ? `${s("label")}: ${l.url}` : ""; }
    case "footer": {
      const out: string[] = [];
      if (s("note")) out.push(t(s("note")));
      if (b.showStoreInfo === true) { out.push("{{storeName}}"); if (ctx.brand.address) out.push(ctx.brand.address); }
      if (b.showContact === true) { if (ctx.brand.email) out.push(ctx.brand.email); if (ctx.brand.phone) out.push(ctx.brand.phone); }
      if (b.showSocial === true) for (const x of ctx.brand.social) { const l = resolveLinkUrl(x.url, ctx); if (l.ok) out.push(`${x.label}: ${l.url}`); }
      out.push("You are receiving this e-mail because you agreed to receive marketing e-mail from {{storeName}}.", "Unsubscribe: {{unsubscribeUrl}}");
      return out.join("\n");
    }
  }
}

/**
 * Renders a VALIDATED design to e-mail HTML (table layout, inline styles; the one <style> block only adds a small-screen media query as progressive
 * enhancement, nothing depends on it) and a plain-text alternative. Both still contain `{{ placeholders }}`: they are filled per recipient by the
 * existing renderEmailTemplate. The output always contains {{unsubscribeUrl}} (the footer is validated to exist), which `hasUnsubscribePlaceholder` re-checks.
 */
export function renderDesign(design: Design, ctx: RenderContext): { html: string; text: string } {
  const body = design.blocks.map((b) => renderBlockHtml(b, ctx)).join("");
  const pre = design.preheader ? `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff;">${esc(design.preheader)}</div>` : "";
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>{{storeName}}</title>
<style>@media only screen and (max-width:620px){.gp-container{width:100%!important}.gp-pad{padding-left:16px!important;padding-right:16px!important}.gp-img{width:100%!important;height:auto!important}h1{font-size:24px!important;line-height:30px!important} }</style>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;">
${pre}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" class="gp-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">
${body}
</table>
</td></tr></table>
</body>
</html>`;
  const text = design.blocks.map((b) => renderBlockText(b, ctx)).filter(Boolean).join("\n\n") + "\n";
  return { html, text };
}

/** The unsubscribe rule: both bodies carry {{unsubscribeUrl}} (the existing placeholder scan decides, exactly as the campaign checks do). */
export const hasUnsubscribePlaceholder = (c: { textBody: string; htmlBody: string | null }): boolean =>
  scanPlaceholders(c.textBody).variables.includes("unsubscribeUrl") && (c.htmlBody === null || scanPlaceholders(c.htmlBody).variables.includes("unsubscribeUrl"));

// ------------------------------------------------------------------------------------------------------------------------------------ storage
// The EmailTemplate row has no column for the editable structure, so (without a migration) the design is stored INSIDE htmlBody as one HTML comment at
// the very end: `<!--gp-design:v1:<draft|ready>:<hex JSON>-->`. Hex cannot contain `-->`, markup or placeholders. A comment is ignored by mail clients.

export type DesignStatus = "draft" | "ready";
export { DESIGN_MARKER_PREFIX, stripDesignMarker };
const MARKER = /\n?<!--gp-design:v1:(draft|ready):([0-9a-f]+)-->\s*$/;

export function attachDesign(html: string, design: Design, status: DesignStatus): string {
  return `${html}\n${DESIGN_MARKER_PREFIX}${status}:${Buffer.from(JSON.stringify(design), "utf8").toString("hex")}-->`;
}
export function readStoredDesign(htmlBody: string | null | undefined): { status: DesignStatus; design: unknown } | null {
  if (!htmlBody) return null;
  const m = MARKER.exec(htmlBody);
  if (!m) return null;
  try { return { status: m[1] as DesignStatus, design: JSON.parse(Buffer.from(m[2], "hex").toString("utf8")) }; } catch { return null; }
}
/** Same stored design, different status (used by duplicate: a copy always starts as a draft). Returns null when there is no designer marker. */
export function withDesignStatus(htmlBody: string, status: DesignStatus): string | null {
  const m = MARKER.exec(htmlBody);
  return m ? `${htmlBody.slice(0, m.index)}\n${DESIGN_MARKER_PREFIX}${status}:${m[2]}-->` : null;
}
export const isDesignerTemplate = (htmlBody: string | null | undefined): boolean => readStoredDesign(htmlBody) !== null;
/** True for a template made by the designer that is not ready for campaigns (still a draft). Templates made elsewhere are never affected. */
export const isDesignerDraft = (htmlBody: string | null | undefined): boolean => readStoredDesign(htmlBody)?.status === "draft";
