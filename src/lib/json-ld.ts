/**
 * Serializes a JSON-LD object for embedding inside a <script> tag via
 * dangerouslySetInnerHTML. Plain JSON.stringify does NOT make this safe: a
 * product name containing "</script><script>…" would terminate the tag and
 * run attacker markup. Escaping `<`, `>`, `&` and the JS line separators as
 * \uXXXX keeps the output valid JSON (identical when parsed) while making
 * it impossible to close the script element.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
