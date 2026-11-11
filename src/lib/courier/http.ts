/**
 * Minimal server-side HTTP helper for courier APIs: hard timeout, response
 * size cap, and a result type that distinguishes "the provider answered"
 * from "we can't tell what happened" (the distinction booking safety needs).
 */
const MAX_RESPONSE_CHARS = 65_536;

export type HttpResult =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "http_error"; status: number; json: unknown | null }
  | { kind: "invalid_response"; status: number }
  | { kind: "network"; message: string };

export async function requestJson(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown },
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: init.method,
      headers: { Accept: "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      redirect: "error", // never follow redirects with credentials attached
      cache: "no-store",
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) return { kind: "invalid_response", status: res.status };
    let json: unknown = null;
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        return res.ok ? { kind: "invalid_response", status: res.status } : { kind: "http_error", status: res.status, json: null };
      }
    }
    if (!res.ok) return { kind: "http_error", status: res.status, json };
    if (json === null) return { kind: "invalid_response", status: res.status };
    return { kind: "ok", status: res.status, json };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { kind: "network", message: aborted ? "The courier did not answer in time." : "Could not reach the courier." };
  } finally {
    clearTimeout(timer);
  }
}
