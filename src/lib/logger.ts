/**
 * Production error logging. One structured JSON line per failure on stderr —
 * what hosting platforms (Vercel, Docker, systemd/journald, Railway…) capture
 * and let you search — so failed checkouts, uploads and courier calls can be
 * investigated afterwards.
 *
 * Deliberately NOT logged: customer names, emails, phones, addresses, order
 * contents, request bodies, tokens, API keys/secrets. Only a short context
 * label, the error class/message (truncated) and a trimmed stack. Error
 * messages from our own code are written for admins/customers and contain no
 * secrets; provider messages are sanitized before they reach here (see
 * lib/courier/status.ts → sanitizeProviderMessage).
 */
const MAX_MESSAGE = 500;
const MAX_STACK = 1500;

export function formatServerError(context: string, error: unknown, extra?: Record<string, string | number | boolean | null>) {
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error thrown");
  const rawCode = (err as { code?: unknown }).code;
  return {
    level: "error",
    time: new Date().toISOString(),
    context,
    name: err.name,
    message: err.message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_MESSAGE),
    // Prisma codes (P2002…) help diagnosis and carry no customer data.
    code: typeof rawCode === "string" ? rawCode : undefined,
    stack: (err.stack ?? "").split("\n").slice(0, 8).join("\n").slice(0, MAX_STACK),
    ...(extra ? { extra } : {}),
  };
}

/** A non-throwing failure worth investigating (e.g. a courier rejected a booking). */
export function logServerWarning(context: string, message: string, extra?: Record<string, string | number | boolean | null>) {
  console.warn(
    JSON.stringify({
      level: "warn",
      time: new Date().toISOString(),
      context,
      message: message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_MESSAGE),
      ...(extra ? { extra } : {}),
    }),
  );
}

export function logServerError(context: string, error: unknown, extra?: Record<string, string | number | boolean | null>) {
  console.error(JSON.stringify(formatServerError(context, error, extra)));
}
