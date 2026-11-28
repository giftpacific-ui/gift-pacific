/**
 * The internal e-mail designer marker (P12-UI-02): the editable design and its draft/ready status are stored INSIDE EmailTemplate.htmlBody as one HTML
 * comment, `<!--gp-design:v1:<draft|ready>:<hex JSON>-->`. It is internal data and must never reach a customer. This tiny module has no dependencies, so the
 * campaign, queue and designer code can all use it without pulling in the designer itself. The stored template keeps its marker; everything that is
 * OUTBOUND (campaign snapshots, EmailJob payloads, SMTP, previews, test e-mails) goes through `stripDesignMarker` first.
 */

export const DESIGN_MARKER_PREFIX = "<!--gp-design:v1:";

// The marker plus the single newline `attachDesign` puts before it, so stripping restores the exact HTML that existed before the marker was attached.
// `[^>]*?` cannot cross a `>`, so even a damaged marker can never swallow real content. Any version is matched (v1, a future v2, ...).
const ANY_DESIGN_MARKER = /\n?<!--gp-design:[^>]*?-->/g;

/** The HTML without any designer marker. A string that has none is returned unchanged (same value), and `null` stays `null`. */
export function stripDesignMarker(html: string): string;
export function stripDesignMarker(html: string | null): string | null;
export function stripDesignMarker(html: string | null): string | null {
  if (html === null || !html.includes("<!--gp-design:")) return html;
  return html.replace(ANY_DESIGN_MARKER, "");
}
