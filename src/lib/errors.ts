import { logServerError } from "@/lib/logger";

/**
 * Errors whose message is safe to show to an end user. Server actions return
 * `error.message` to the browser ONLY for these; any other error (Prisma,
 * network, a bug) is logged server-side and replaced by a generic message,
 * so database/internal details never leak to the client.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

/**
 * @param context short label for the log line, e.g. "checkout.place-order"
 *                (so a failed checkout/upload/courier call can be found later)
 */
export function toUserMessage(error: unknown, fallback: string, context = "server-action"): string {
  if (error instanceof UserFacingError) return error.message;
  logServerError(context, error);
  return fallback;
}
