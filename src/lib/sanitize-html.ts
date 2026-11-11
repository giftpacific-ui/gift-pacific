const ALLOWED_TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4",
  "ul", "ol", "li",
  "strong", "b", "em", "i", "u",
  "a",
]);

/** http(s)/mailto only — blocks javascript:, data:, vbscript:, etc. */
function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  return /^(https?:|mailto:)/i.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("#");
}

/**
 * Sanitizes admin-authored rich-text HTML before it's stored, so
 * `dangerouslySetInnerHTML` on the public product page can't execute
 * injected script. Removes <script>/<style>/<iframe>/<object>/<embed>
 * (tag + contents), strips every tag not on the allowlist (keeping their
 * text), and strips every attribute except a validated `href` on `<a>`
 * (which also rules out `onclick=`/`onerror=`/etc. — no attributes means
 * no event handlers).
 */
export function sanitizeProductHtml(html: string): string {
  let result = html;

  // Remove dangerous elements entirely, including their content.
  result = result.replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Self-closing/void forms of the same tags (e.g. a malformed <iframe/>).
  result = result.replace(/<(script|style|iframe|object|embed)\b[^>]*\/?>/gi, "");

  // Strip every remaining tag that isn't on the allowlist, but keep its
  // inner text (e.g. an unknown <div class="x"> becomes plain text, not a
  // hole in the sanitizer that drops content entirely).
  result = result.replace(/<\/?([a-zA-Z0-9]+)((?:\s+[^>]*)?)>/g, (match, tagName: string, attrs: string) => {
    const tag = tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";

    const isClosing = match.startsWith("</");
    if (isClosing) return `</${tag}>`;

    if (tag === "a") {
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
      const href = hrefMatch?.[1];
      if (href && isSafeHref(href)) {
        return `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer">`;
      }
      return "<a>";
    }

    // Every other allowed tag: strip all attributes (no event handlers,
    // no style injection, no javascript: in unexpected places).
    return `<${tag}>`;
  });

  return result;
}
