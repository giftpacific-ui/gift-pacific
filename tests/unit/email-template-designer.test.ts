/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * P12-UI-02: the PURE parts of the template designer: block editing rules, design validation, URL/image safety, the renderer (HTML + text, desktop and
 * mobile markup), product rendering, XSS, placeholders and the unsubscribe guarantee. No database, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addBlock, defaultDesign, duplicateBlock, moveBlock, newBlock, readableOn, removeBlock, type Block, type Design,
} from "@/lib/email-template-blocks";
import {
  attachDesign, discountPercent, formatMoney, hasUnsubscribePlaceholder, isDesignerDraft, isDesignerTemplate, readStoredDesign, renderDesign, resolveImageUrl, resolveLinkUrl,
  validateDesign, withDesignStatus, type DesignProduct, type RenderContext,
} from "@/lib/email/designer/design";
import { findUnsafeHtml, renderEmailTemplate, validateTemplateContent } from "@/lib/email/template-rules";

const CTX = { origin: "https://giftpacific.test", production: true };
const BRAND = { storeName: "GiftPacific", logoUrl: "https://giftpacific.test/img/logo/logo.png", primary: "#a63a5b", currencyCode: "BDT", currencySymbol: "৳", email: "hello@giftpacific.test", phone: "+8801700000000", address: "Dhaka", social: [{ label: "Instagram", url: "https://instagram.com/giftpacific" }] };
const PRODUCT: DesignProduct = { id: "p1", name: "Clay Vase", imageUrl: "https://res.cloudinary.com/x/vase.jpg", price: 1800, fromPrice: false, compareAtPrice: 2400, currency: "BDT", url: "https://giftpacific.test/products/clay-vase" };
const rctx = (products: DesignProduct[] = [PRODUCT]): RenderContext => ({ ...CTX, brand: BRAND, products: new Map(products.map((p) => [p.id, p])) });
const withBlocks = (...mid: Block[]): Design => { const d = defaultDesign(); return { preheader: "", blocks: [d.blocks[0], ...mid, d.blocks[d.blocks.length - 1]] }; };
const ok = (design: unknown) => { const r = validateDesign(design, CTX); assert.ok(r.ok, JSON.stringify((r as any).errors)); return r.value.design; };
const errorsOf = (design: unknown) => { const r = validateDesign(design, CTX); assert.equal(r.ok, false); return (r as any).errors as { field: string; code: string; message: string }[]; };
const productBlock = (over: Record<string, unknown> = {}): Block => ({ ...newBlock("product"), productId: "p1", ...over }) as Block;

// -------------------------------------------------------------------------------------------------------------------------------- block validation
test("the default design is valid, and every block type validates with its defaults", () => {
  ok(defaultDesign());
  ok(withBlocks(productBlock(), { ...newBlock("promo") } as Block, newBlock("text"), newBlock("cta"), newBlock("hero")));
});

test("block validation: unknown type, unknown field, wrong type, duplicate id, bad colour, too long, empty hero are refused with a field path", () => {
  const d = defaultDesign();
  const hero = d.blocks[1];
  assert.ok(errorsOf({ ...d, blocks: [...d.blocks.slice(0, 1), { ...hero, type: "script" }, d.blocks[4]] }).some((e) => e.code === "invalid_block_type"));
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[0], { ...hero, onclick: "x()" }, d.blocks[4]] }).some((e) => e.field === "blocks[1].onclick" && e.code === "unsupported_field"));
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[0], { ...hero, heading: 42 }, d.blocks[4]] }).some((e) => e.field === "blocks[1].heading" && e.code === "invalid_type"));
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[0], { ...hero, id: d.blocks[0].id }, d.blocks[4]] }).some((e) => e.code === "duplicate_id"));
  assert.ok(errorsOf({ ...d, blocks: [{ ...d.blocks[0], background: "red" }, d.blocks[4]] }).some((e) => e.code === "invalid_color"));
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[0], { ...hero, heading: "x".repeat(121) }, d.blocks[4]] }).some((e) => e.code === "too_long"));
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[0], { ...hero, heading: "", imageUrl: "" }, d.blocks[4]] }).some((e) => e.code === "empty_block"));
  assert.ok(errorsOf({ ...d, extra: 1 }).some((e) => e.code === "unsupported_field"));
  assert.ok(errorsOf(null).length && errorsOf([]).length && errorsOf({ blocks: "x" }).length);
  assert.ok(errorsOf({ ...d, blocks: [...d.blocks.slice(0, 1), ...Array.from({ length: 31 }, () => newBlock("text")), d.blocks[4]] }).some((e) => e.code === "too_many"));
});

test("a product block needs a product id; a promo block validates the coupon code shape; a CTA needs a label and a URL", () => {
  assert.ok(errorsOf(withBlocks({ ...productBlock(), productId: "" } as Block)).some((e) => e.field.endsWith("productId")));
  assert.ok(errorsOf(withBlocks({ ...newBlock("promo"), couponCode: "bad code!" } as Block)).some((e) => e.code === "invalid_coupon"));
  assert.equal((ok(withBlocks({ ...newBlock("promo"), couponCode: " save20 " } as Block)).blocks[1] as any).couponCode, "SAVE20");
  assert.ok(errorsOf(withBlocks({ ...newBlock("cta"), label: "" } as Block)).some((e) => e.code === "required"));
  assert.ok(errorsOf(withBlocks({ ...newBlock("cta"), url: "" } as Block)).some((e) => e.code === "required"));
});

// ---------------------------------------------------------------------------------------------------------------------------------- block ordering
test("block ordering: move up/down, header stays first, footer stays last, nothing passes them", () => {
  const a = newBlock("text", "a"), b = newBlock("cta", "b"), c = newBlock("promo", "c");
  const blocks = [newBlock("header", "h"), a, b, c, newBlock("footer", "f")];
  const ids = (x: Block[]) => x.map((y) => y.id).join(",");
  const down = moveBlock(blocks, "a", "down"); assert.ok(down.ok); assert.equal(ids(down.blocks), "h,b,a,c,f");
  const up = moveBlock(blocks, "c", "up"); assert.ok(up.ok); assert.equal(ids(up.blocks), "h,a,c,b,f");
  assert.equal(moveBlock(blocks, "a", "up").ok, false, "cannot move above the header");
  assert.equal(moveBlock(blocks, "c", "down").ok, false, "cannot move below the footer");
  assert.equal(moveBlock(blocks, "h", "down").ok, false);
  assert.equal(moveBlock(blocks, "f", "up").ok, false);
  assert.equal(moveBlock(blocks, "nope", "up").ok, false);
  assert.equal(ids(blocks), "h,a,b,c,f", "the input list is never mutated");
});

test("add / duplicate / remove: new blocks land before the footer; footer and header are single and the footer cannot be removed", () => {
  let blocks = defaultDesign().blocks;
  const added = addBlock(blocks, "product", "np"); assert.ok(added.ok); blocks = added.blocks;
  assert.equal(blocks[blocks.length - 1].type, "footer"); assert.equal(blocks[blocks.length - 2].id, "np");
  assert.equal(addBlock(blocks, "footer").ok, false); assert.equal(addBlock(blocks, "header").ok, false);
  const dup = duplicateBlock(blocks, "np", "np2"); assert.ok(dup.ok); assert.equal(dup.blocks[dup.blocks.findIndex((b) => b.id === "np") + 1].id, "np2");
  assert.equal(duplicateBlock(blocks, blocks[0].id).ok, false); assert.equal(duplicateBlock(blocks, blocks[blocks.length - 1].id).ok, false);
  const footer = blocks[blocks.length - 1];
  assert.equal(removeBlock(blocks, footer.id).ok, false, "the footer (unsubscribe link) cannot be removed");
  const rem = removeBlock(blocks, "np"); assert.ok(rem.ok); assert.equal(rem.blocks.some((b) => b.id === "np"), false);
  let many = blocks; for (let i = 0; i < 12; i++) { const r = addBlock(many, "product"); if (r.ok) many = r.blocks; }
  assert.equal(many.filter((b) => b.type === "product").length, 12, "product blocks are capped");
});

test("validation enforces the layout rules: exactly one footer, last; at most one header, first", () => {
  const d = defaultDesign();
  assert.ok(errorsOf({ ...d, blocks: d.blocks.slice(0, 4) }).some((e) => e.code === "footer_required"), "no footer");
  assert.ok(errorsOf({ ...d, blocks: [...d.blocks, { ...d.blocks[4], id: "f2" }] }).some((e) => e.code === "footer_required"), "two footers");
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[4], ...d.blocks.slice(0, 4)] }).some((e) => e.code === "footer_not_last" || e.code === "header_not_first"));
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[0], { ...d.blocks[0], id: "h2" }, d.blocks[4]] }).some((e) => e.code === "too_many_headers"));
  assert.ok(errorsOf({ ...d, blocks: [d.blocks[1], d.blocks[0], d.blocks[4]] }).some((e) => e.code === "header_not_first"));
});

// --------------------------------------------------------------------------------------------------------------------------------------- URL safety
test("safe URL validation: only https (http for loopback outside production) and own-site paths; every script-like scheme is refused", () => {
  assert.equal(resolveLinkUrl("https://example.com/a?b=1", CTX).ok, true);
  assert.equal(resolveLinkUrl("/shop", CTX).ok, true);
  assert.equal((resolveLinkUrl("/shop", CTX) as any).url, "https://giftpacific.test/shop");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "mailto:a@b.co", "ftp://x.test/a", "//evil.test/x", "http://example.com", "https://user:pw@example.com", "https://exa mple.com", "https://example.com/{{unsubscribeUrl}}", "https://example.com/\"onmouseover=x", "https://example.com/<b>", "", "   ", 42, null, "x".repeat(2100)]) {
    assert.equal(resolveLinkUrl(bad as any, CTX).ok, false, `must refuse ${String(bad).slice(0, 40)}`);
  }
  assert.equal(resolveLinkUrl("http://localhost:3000/x", { origin: "http://localhost:3000", production: false }).ok, true);
  assert.equal(resolveLinkUrl("http://localhost:3000/x", { origin: "http://localhost:3000", production: true }).ok, false);
  assert.equal(resolveLinkUrl("http://example.com/x", { origin: "http://localhost:3000", production: false }).ok, false, "http only for loopback");
});

test("image URLs: own host or an approved image host only", () => {
  assert.equal(resolveImageUrl("https://res.cloudinary.com/demo/image.png", CTX).ok, true);
  assert.equal(resolveImageUrl("https://abc.supabase.co/storage/x.png", CTX).ok, true, "wildcard host, one label");
  assert.equal(resolveImageUrl("https://a.b.supabase.co/x.png", CTX).ok, false, "a wildcard covers exactly one label");
  assert.equal(resolveImageUrl("https://giftpacific.test/img/logo/logo.png", CTX).ok, true);
  assert.equal(resolveImageUrl("/img/logo/logo.png", CTX).ok, true);
  assert.equal(resolveImageUrl("https://evil.test/tracker.png", CTX).ok, false);
  assert.equal(resolveImageUrl("data:image/png;base64,AAAA", CTX).ok, false);
  assert.equal(resolveImageUrl("javascript:alert(1)", CTX).ok, false);
});

test("URL fields are refused at validation (CTA, hero link, hero image, markdown link in a paragraph)", () => {
  assert.ok(errorsOf(withBlocks({ ...newBlock("cta"), url: "javascript:alert(1)" } as Block)).some((e) => e.code === "invalid_url"));
  assert.ok(errorsOf(withBlocks({ ...newBlock("hero"), linkUrl: "data:text/html,x" } as Block)).some((e) => e.code === "invalid_url"));
  assert.ok(errorsOf(withBlocks({ ...newBlock("hero"), imageUrl: "https://evil.test/x.png" } as Block)).some((e) => e.field.endsWith("imageUrl")));
  assert.ok(errorsOf(withBlocks({ ...newBlock("text"), body: "see [here](javascript:alert(1))" } as Block)).some((e) => e.code === "invalid_url"));
});

// ------------------------------------------------------------------------------------------------------------------------------ XSS and variables
const EVIL = `<script>alert(1)</script><img src=x onerror=alert(1)> "quoted" 'single' & <b>`;
const SHORT_EVIL = `<script>x</script>"'&`;
const evilDesign = (): Design => {
  const d = defaultDesign();
  return {
    preheader: EVIL,
    blocks: [
      d.blocks[0],
      { ...newBlock("hero"), heading: EVIL, text: EVIL, imageAlt: EVIL } as Block,
      { ...newBlock("text"), heading: EVIL, body: `${EVIL}\n\n**<i>bold</i>**` } as Block,
      { ...newBlock("promo"), headline: EVIL, description: EVIL, expiryText: EVIL, couponCode: "SAVE20" } as Block,
      { ...newBlock("cta"), label: SHORT_EVIL } as Block,
      productBlock({ ctaLabel: SHORT_EVIL }),
      { ...d.blocks[4], note: EVIL },
    ],
  };
};

test("XSS: markup in every text field is escaped, never emitted; the generated HTML passes the existing unsafe-HTML guard", () => {
  const design = ok(evilDesign());
  const evilProduct: DesignProduct = { ...PRODUCT, name: EVIL };
  const { html, text } = renderDesign(design, rctx([evilProduct]));
  assert.equal(findUnsafeHtml(html), null);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\sonerror\s*=/i, "no real event-handler attribute (the typed text only appears escaped, with &#61;)");
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<b>|<i>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(html.includes("&lt;img src&#61;x onerror&#61;alert(1)&gt;"), "the attack text is visible as text, inert");
  assert.ok(validateTemplateContent({ subject: "x", textBody: text, htmlBody: html }).ok, "the existing template rules accept the output");
});

test("filled with customer data the output stays inert: a hostile customer name is escaped by the existing renderer", () => {
  const design = ok(withBlocks({ ...newBlock("text"), body: "Hi {{customerName}} ({{email}})" } as Block));
  const { html, text } = renderDesign(design, rctx());
  const out = renderEmailTemplate({ subject: "s", textBody: text, htmlBody: html }, { customerName: `<script>alert(1)</script>`, email: "a@b.co", storeName: "S", unsubscribeUrl: "https://giftpacific.test/unsubscribe/abc" });
  assert.ok(out.ok);
  assert.doesNotMatch(out.htmlBody as string, /<script>alert/);
});

test("allowed template variables only: the five existing ones pass; anything else is refused per field; no expressions", () => {
  const allowed = ok(withBlocks({ ...newBlock("text"), body: "{{customerName}} {{firstName}} {{email}} {{storeName}} {{ unsubscribeUrl }}" } as Block));
  assert.ok(validateTemplateContent({ subject: "{{firstName}}", ...(() => { const r = renderDesign(allowed, rctx()); return { textBody: r.text, htmlBody: r.html }; })() }).ok);
  for (const body of ["{{secret}}", "{{customer.name}}", "{{ constructor }}", "{{user.password}}", "{{{firstName}}}", "{{firstName", "{{#if x}}y{{/if}}", "{{firstName()}}", "{{ 1+1 }}"]) {
    const errs = errorsOf(withBlocks({ ...newBlock("text"), body } as Block));
    assert.ok(errs.some((e) => e.code === "unsupported_variable" || e.code === "malformed_placeholder"), `must refuse ${body}`);
  }
  assert.ok(errorsOf({ ...defaultDesign(), preheader: "{{nope}}" }).some((e) => e.field === "preheader"));
});

// -------------------------------------------------------------------------------------------------------------------------- unsubscribe guarantee
test("every design renders the {{unsubscribeUrl}} link in BOTH bodies, whatever the other blocks are", () => {
  for (const design of [defaultDesign(), withBlocks(), withBlocks(productBlock(), newBlock("promo"), newBlock("cta"))]) {
    const v = ok(design);
    const { html, text } = renderDesign(v, rctx());
    assert.match(html, /<a href="\{\{unsubscribeUrl\}\}"/);
    assert.match(text, /Unsubscribe: \{\{unsubscribeUrl\}\}/);
    assert.ok(hasUnsubscribePlaceholder({ textBody: text, htmlBody: html }));
  }
  const footerOff = ok({ ...defaultDesign(), blocks: defaultDesign().blocks.map((b) => (b.type === "footer" ? { ...b, showStoreInfo: false, showContact: false, showSocial: false, note: "" } : b)) });
  assert.ok(hasUnsubscribePlaceholder((() => { const r = renderDesign(footerOff, rctx()); return { textBody: r.text, htmlBody: r.html }; })()), "switching every footer option off cannot remove it");
  assert.equal(hasUnsubscribePlaceholder({ textBody: "no link here", htmlBody: null }), false);
  assert.equal(hasUnsubscribePlaceholder({ textBody: "x {{unsubscribeUrl}}", htmlBody: "<p>no link</p>" }), false);
});

test("the rendered unsubscribe link is the real campaign URL once the existing renderer fills it, and only a well-formed URL is accepted", () => {
  const { html, text } = renderDesign(ok(defaultDesign()), rctx());
  const url = "https://giftpacific.test/unsubscribe/abcDEF123";
  const out = renderEmailTemplate({ subject: "s", textBody: text, htmlBody: html }, { storeName: "GiftPacific", unsubscribeUrl: url });
  assert.ok(out.ok); assert.ok(out.textBody.includes(url)); assert.ok((out.htmlBody as string).includes(`href="${url}"`));
  const bad = renderEmailTemplate({ subject: "s", textBody: text, htmlBody: html }, { storeName: "G", unsubscribeUrl: "javascript:alert(1)" });
  assert.ok(bad.ok); assert.ok(!(bad.htmlBody as string).includes("javascript:"));
});

// ---------------------------------------------------------------------------------------------------------------- rendering: desktop, mobile, product
test("email-compatible markup: table layout, inline styles, no script/external CSS/web fonts, a mobile media query as progressive enhancement", () => {
  const { html } = renderDesign(ok(withBlocks(productBlock(), newBlock("hero"), newBlock("cta"))), rctx());
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('role="presentation"') && html.includes("<table"));
  assert.ok(html.includes('width="600"') && html.includes("max-width:100%"), "desktop: a 600px container that shrinks");
  assert.ok(html.includes("@media only screen and (max-width:620px)"), "mobile: small-screen rules");
  assert.ok(html.includes('class="gp-img"') && html.includes("width:100%"), "mobile: images scale");
  assert.ok(html.includes('name="viewport"'));
  assert.doesNotMatch(html, /<script|<link|@import|<iframe|javascript:|<form|<video|<audio/i);
  assert.match(html, /style="[^"]*font-family:Arial/);
  assert.ok(html.indexOf("<style>") === html.lastIndexOf("<style>"), "one small style block, nothing external");
});

test("product block: name, image, price, original price and a valid discount; link and button use the product URL", () => {
  const { html, text } = renderDesign(ok(withBlocks(productBlock({ ctaLabel: "View product" }))), rctx());
  assert.ok(html.includes("Clay Vase")); assert.ok(html.includes('src="https://res.cloudinary.com/x/vase.jpg"'));
  assert.ok(html.includes("৳1,800") && html.includes("৳2,400") && html.includes("-25%"));
  assert.ok(html.includes('href="https://giftpacific.test/products/clay-vase"'));
  assert.match(html, /line-through/);
  assert.ok(text.includes("Clay Vase") && text.includes("৳1,800 (was ৳2,400, -25%)") && text.includes("View product: https://giftpacific.test/products/clay-vase"));
});

test("product block: no original price (or one that is not higher) shows no discount; the discount toggle hides it; a from-price is labelled; no image = no image row", () => {
  const none = renderDesign(ok(withBlocks(productBlock())), rctx([{ ...PRODUCT, compareAtPrice: null }]));
  assert.ok(!none.html.includes("line-through") && !none.html.includes("-25%") && !none.text.includes("was "));
  assert.equal(discountPercent(1800, 1800), null); assert.equal(discountPercent(1800, 1000), null); assert.equal(discountPercent(1800, null), null); assert.equal(discountPercent(1999, 2000), null, "under 1% is not shown");
  assert.equal(discountPercent(75, 100), 25);
  const off = renderDesign(ok(withBlocks(productBlock({ showDiscount: false }))), rctx());
  assert.ok(!off.html.includes("-25%") && !off.html.includes("line-through"));
  const from = renderDesign(ok(withBlocks(productBlock())), rctx([{ ...PRODUCT, fromPrice: true, compareAtPrice: null }]));
  assert.ok(from.html.includes("From ৳1,800") && from.text.includes("From ৳1,800"));
  const noImg = renderDesign(ok(withBlocks(productBlock())), rctx([{ ...PRODUCT, imageUrl: null }]));
  assert.ok(!noImg.html.includes("<img class=\"gp-img\""));
  assert.equal(formatMoney(5, "USD", BRAND), "USD 5");
});

test("multiple product blocks render in order, each with its own data", () => {
  const p2: DesignProduct = { ...PRODUCT, id: "p2", name: "Clay Mug", price: 650, compareAtPrice: null, url: "https://giftpacific.test/products/clay-mug" };
  const { html } = renderDesign(ok(withBlocks(productBlock(), productBlock({ id: "other", productId: "p2" }))), rctx([PRODUCT, p2]));
  assert.ok(html.indexOf("Clay Vase") < html.indexOf("Clay Mug")); assert.ok(html.includes("৳650"));
});

test("other blocks: header colours are readable, CTA styles, promo coupon, hero link, footer details come only from settings", () => {
  assert.equal(readableOn("#ffffff"), "#1c1917"); assert.equal(readableOn("#111111"), "#ffffff");
  const { html, text } = renderDesign(ok(withBlocks(
    { ...newBlock("promo"), headline: "20% off", couponCode: "save20", description: "On all gifts", expiryText: "Ends 30 Nov" } as Block,
    { ...newBlock("cta"), label: "Claim Your Offer", url: "https://example.com/offer", style: "outline", align: "left" } as Block,
    { ...newBlock("hero"), imageUrl: "https://res.cloudinary.com/x/b.jpg", imageAlt: "Banner", heading: "Hi", linkUrl: "/shop", linkLabel: "Shop now" } as Block,
  )), rctx());
  assert.ok(html.includes("SAVE20") && html.includes("20% off") && html.includes("Ends 30 Nov"));
  assert.ok(text.includes("Coupon code: SAVE20") && text.includes("Claim Your Offer: https://example.com/offer"));
  assert.ok(html.includes('href="https://giftpacific.test/shop"') && html.includes('alt="Banner"'));
  assert.ok(html.includes("hello@giftpacific.test") && html.includes("Instagram") && html.includes("Dhaka"));
  const bare = renderDesign(ok({ ...defaultDesign(), blocks: defaultDesign().blocks.map((b) => (b.type === "footer" ? { ...b, showContact: false, showSocial: false, showStoreInfo: false } : b)) }), rctx());
  assert.ok(!bare.html.includes("hello@giftpacific.test") && !bare.html.includes("Instagram"));
});

test("basic formatting is the only markup a paragraph can produce: bold, italic and safe links", () => {
  const { html } = renderDesign(ok(withBlocks({ ...newBlock("text"), body: "A **bold** and *italic* [link](https://example.com/x)\nsecond line\n\nNew paragraph" } as Block)), rctx());
  assert.ok(html.includes("<strong>bold</strong>") && html.includes("<em>italic</em>") && html.includes('href="https://example.com/x"'));
  assert.ok(html.includes("second line") && (html.match(/<p /g) ?? []).length >= 2 && html.includes("<br>"));
});

// ---------------------------------------------------------------------------------------------------------------------------------------- storage
test("the stored design survives a round trip inside htmlBody, and draft/ready is read from it", () => {
  const design = ok(defaultDesign());
  const { html } = renderDesign(design, rctx());
  const stored = attachDesign(html, design, "draft");
  assert.deepEqual(readStoredDesign(stored)?.design, design);
  assert.equal(isDesignerDraft(stored), true); assert.equal(isDesignerTemplate(stored), true);
  const ready = withDesignStatus(stored, "ready") as string;
  assert.equal(isDesignerDraft(ready), false); assert.equal(readStoredDesign(ready)?.status, "ready");
  assert.deepEqual(readStoredDesign(ready)?.design, design);
  assert.equal(isDesignerTemplate("<p>hand written</p>"), false); assert.equal(isDesignerDraft(null), false); assert.equal(withDesignStatus("<p>x</p>", "draft"), null);
  assert.equal(readStoredDesign("<p>x</p><!--gp-design:v1:draft:!!!-->"), null);
  assert.ok(validateTemplateContent({ subject: "x", textBody: "x {{unsubscribeUrl}}", htmlBody: stored }).ok, "the existing validator accepts the stored body");
  assert.equal(findUnsafeHtml(stored), null);
});

test("architecture: browser code never imports lib/email, and the design storage uses no base64", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync("src/features/admin/email-templates")) assert.doesNotMatch(readFileSync(`src/features/admin/email-templates/${f}`, "utf8"), /from ["']@\/lib\/email\//, f);
  assert.doesNotMatch(readFileSync("src/lib/email-template-blocks.ts", "utf8"), /from ["']@\/lib\/email\//);
  assert.doesNotMatch(readFileSync("src/lib/email/designer/design.ts", "utf8"), /base64/i);
});
