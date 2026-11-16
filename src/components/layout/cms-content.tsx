import { sanitizeProductHtml } from "@/lib/sanitize-html";

/** Renders admin-authored HTML. It is sanitized on save AND again here, so a bad row can never inject script. */
export function CmsContent({ html, className }: { html: string; className?: string }) {
  return (
    <div
      className={className}
      // eslint-disable-next-line react/no-danger -- sanitized by sanitizeProductHtml (allowlist, no attributes except safe href)
      dangerouslySetInnerHTML={{ __html: sanitizeProductHtml(html) }}
    />
  );
}
