/**
 * Email template designer (P12-UI-02): the block model. PURE and CLIENT-SAFE: no database, no network, no Node-only APIs, so the editor in the browser
 * and the server validator/renderer share ONE description of every block. The field table (FIELD_SPEC) is the single source of truth for each block's
 * fields, defaults and limits; validation (design.ts) and the editor forms both read it.
 *
 * A design stores only choices (text, colours, a product ID, URLs). It never stores HTML, scripts or product prices: the server renders the HTML from the
 * design with a fixed renderer, and product data is always read from the product table.
 */

export const BLOCK_TYPES = ["header", "hero", "text", "product", "promo", "cta", "footer"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const isBlockType = (v: unknown): v is BlockType => typeof v === "string" && (BLOCK_TYPES as readonly string[]).includes(v);

export const BLOCK_LABELS: Record<BlockType, string> = {
  header: "Header", hero: "Hero banner", text: "Text", product: "Product showcase", promo: "Promotional section", cta: "Call to action", footer: "Footer",
};

export const DESIGN_LIMITS = { blocks: 30, productBlocks: 12, preheader: 150, designJson: 40_000 } as const;
export const ALIGNMENTS = ["left", "center", "right"] as const;
export type Align = (typeof ALIGNMENTS)[number];
export const BUTTON_STYLES = ["solid", "outline"] as const;

/** One field of a block. `kind` decides how it is validated; `def` is the value a new block starts with. */
export type FieldSpec =
  | { kind: "text"; max: number; required?: boolean; def: string; label: string }
  | { kind: "multiline"; max: number; required?: boolean; def: string; label: string }
  | { kind: "url"; required?: boolean; def: string; label: string }
  | { kind: "image"; required?: boolean; def: string; label: string }
  | { kind: "color"; required?: boolean; def: string; label: string }
  | { kind: "code"; def: string; label: string }
  | { kind: "productId"; def: string; label: string }
  | { kind: "bool"; def: boolean; label: string }
  | { kind: "enum"; values: readonly string[]; def: string; label: string };

export const FIELD_SPEC = {
  header: {
    showLogo: { kind: "bool", def: true, label: "Show logo" },
    showStoreName: { kind: "bool", def: true, label: "Show store name" },
    background: { kind: "color", required: true, def: "#ffffff", label: "Background colour" },
    align: { kind: "enum", values: ALIGNMENTS, def: "center", label: "Alignment" },
  },
  hero: {
    imageUrl: { kind: "image", def: "", label: "Banner image URL" },
    imageAlt: { kind: "text", max: 120, def: "", label: "Image description (alt text)" },
    heading: { kind: "text", max: 120, def: "Hello {{firstName}},", label: "Heading" },
    text: { kind: "multiline", max: 500, def: "Write your supporting message here.", label: "Supporting text" },
    linkUrl: { kind: "url", def: "", label: "Link (optional)" },
    linkLabel: { kind: "text", max: 40, def: "Shop now", label: "Link button label" },
    align: { kind: "enum", values: ALIGNMENTS, def: "center", label: "Alignment" },
  },
  text: {
    heading: { kind: "text", max: 120, def: "", label: "Heading" },
    body: { kind: "multiline", max: 3000, def: "Write your message here. Use **bold**, *italic* and [link text](https://example.com).", label: "Paragraph" },
    align: { kind: "enum", values: ALIGNMENTS, def: "left", label: "Text alignment" },
  },
  product: {
    productId: { kind: "productId", def: "", label: "Product" },
    ctaLabel: { kind: "text", max: 40, required: true, def: "View product", label: "Button label" },
    showDiscount: { kind: "bool", def: true, label: "Show discount when the product has an original price" },
  },
  promo: {
    headline: { kind: "text", max: 80, required: true, def: "Special offer", label: "Discount message" },
    couponCode: { kind: "code", def: "", label: "Coupon code (must be an existing coupon)" },
    description: { kind: "multiline", max: 300, def: "", label: "Offer description" },
    expiryText: { kind: "text", max: 80, def: "", label: "Expiry text (optional)" },
    background: { kind: "color", required: true, def: "#F1E5D6", label: "Background colour" },
  },
  cta: {
    label: { kind: "text", max: 40, required: true, def: "Shop Now", label: "Button label" },
    url: { kind: "url", required: true, def: "/shop", label: "Destination URL" },
    style: { kind: "enum", values: BUTTON_STYLES, def: "solid", label: "Button style" },
    color: { kind: "color", def: "", label: "Button colour (empty = brand colour)" },
    align: { kind: "enum", values: ALIGNMENTS, def: "center", label: "Alignment" },
  },
  footer: {
    note: { kind: "multiline", max: 300, def: "", label: "Extra note (optional)" },
    showStoreInfo: { kind: "bool", def: true, label: "Show store name and address" },
    showContact: { kind: "bool", def: true, label: "Show contact e-mail and phone" },
    showSocial: { kind: "bool", def: true, label: "Show social links set in Settings" },
  },
} as const satisfies Record<BlockType, Record<string, FieldSpec>>;

export type Block = { id: string; type: BlockType } & Record<string, string | boolean>;
export type Design = { preheader: string; blocks: Block[] };

export const CTA_SUGGESTIONS = ["Shop Now", "Explore Collection", "View Product", "Claim Your Offer"] as const;
export const isBlockId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);

// ------------------------------------------------------------------------------------------------------------------------------ editing helpers
// Pure functions on a block list. The header (if any) stays first and the footer stays last and cannot be removed, so the unsubscribe link, which the
// footer always renders, can never be edited out of a template.

export function makeBlockId(): string {
  return `b${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

export function newBlock(type: BlockType, id: string = makeBlockId()): Block {
  const fields: Record<string, string | boolean> = {};
  for (const [k, spec] of Object.entries(FIELD_SPEC[type]) as [string, FieldSpec][]) fields[k] = spec.def;
  return { id, type, ...fields };
}

export function defaultDesign(): Design {
  return { preheader: "", blocks: [newBlock("header"), newBlock("hero"), newBlock("text"), newBlock("cta"), newBlock("footer")] };
}

const isPinnedFirst = (b: Block) => b.type === "header";
const isPinnedLast = (b: Block) => b.type === "footer";

export function addBlock(blocks: Block[], type: BlockType, id?: string): { ok: true; blocks: Block[]; id: string } | { ok: false; message: string } {
  if (blocks.length >= DESIGN_LIMITS.blocks) return { ok: false, message: `A template can have at most ${DESIGN_LIMITS.blocks} blocks.` };
  if (type === "product" && blocks.filter((b) => b.type === "product").length >= DESIGN_LIMITS.productBlocks) return { ok: false, message: `A template can have at most ${DESIGN_LIMITS.productBlocks} product blocks.` };
  if ((type === "header" || type === "footer") && blocks.some((b) => b.type === type)) return { ok: false, message: `A template has only one ${BLOCK_LABELS[type].toLowerCase()}.` };
  const block = newBlock(type, id);
  const next = [...blocks];
  if (type === "header") next.unshift(block);
  else if (type === "footer") next.push(block);
  else { const footerAt = next.findIndex(isPinnedLast); next.splice(footerAt === -1 ? next.length : footerAt, 0, block); }
  return { ok: true, blocks: next, id: block.id };
}

export function removeBlock(blocks: Block[], id: string): { ok: true; blocks: Block[] } | { ok: false; message: string } {
  const b = blocks.find((x) => x.id === id);
  if (!b) return { ok: false, message: "Block not found." };
  if (b.type === "footer") return { ok: false, message: "The footer cannot be removed: it carries the required unsubscribe link." };
  return { ok: true, blocks: blocks.filter((x) => x.id !== id) };
}

export function duplicateBlock(blocks: Block[], id: string, newId: string = makeBlockId()): { ok: true; blocks: Block[]; id: string } | { ok: false; message: string } {
  const at = blocks.findIndex((x) => x.id === id);
  if (at === -1) return { ok: false, message: "Block not found." };
  const b = blocks[at];
  if (b.type === "header" || b.type === "footer") return { ok: false, message: `The ${b.type} cannot be duplicated.` };
  if (blocks.length >= DESIGN_LIMITS.blocks) return { ok: false, message: `A template can have at most ${DESIGN_LIMITS.blocks} blocks.` };
  if (b.type === "product" && blocks.filter((x) => x.type === "product").length >= DESIGN_LIMITS.productBlocks) return { ok: false, message: `A template can have at most ${DESIGN_LIMITS.productBlocks} product blocks.` };
  const next = [...blocks];
  next.splice(at + 1, 0, { ...b, id: newId });
  return { ok: true, blocks: next, id: newId };
}

/** Moves a block one place. The header cannot leave the top, nothing can pass the footer, and a move that would break either rule is refused. */
export function moveBlock(blocks: Block[], id: string, direction: "up" | "down"): { ok: true; blocks: Block[] } | { ok: false; message: string } {
  const at = blocks.findIndex((x) => x.id === id);
  if (at === -1) return { ok: false, message: "Block not found." };
  if (isPinnedFirst(blocks[at]) || isPinnedLast(blocks[at])) return { ok: false, message: `The ${blocks[at].type} stays in place.` };
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= blocks.length) return { ok: false, message: "The block is already at the end." };
  if (isPinnedFirst(blocks[to]) || isPinnedLast(blocks[to])) return { ok: false, message: `A block cannot move past the ${blocks[to].type}.` };
  const next = [...blocks];
  [next[at], next[to]] = [next[to], next[at]];
  return { ok: true, blocks: next };
}

/** Readable text colour (dark or white) for a hex background, so a custom colour can never produce unreadable text. */
export function readableOn(hex: string): "#ffffff" | "#1c1917" {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#1c1917";
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.4 ? "#1c1917" : "#ffffff";
}
