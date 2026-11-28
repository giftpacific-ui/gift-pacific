/**
 * Abandoned-cart reminder rules. PURE: no database, no network, no secrets. Decides whether a cart may be reminded, builds the ONE personalised message
 * that becomes an EmailJob, and names the fixed codes the worker records when it deliberately does not send. Nothing here sends or queues.
 *
 * These e-mails are sent ONLY when an admin clicks "Send reminders" (src/server/services/abandoned-cart-email.service). Nothing detects abandoned carts
 * in the background and nothing sends them on a timer.
 */
import { abandonedCartEventKey } from "@/lib/email/marketing";
import { emailDedupeKey, validateEmailJobInput, type EmailJobInput } from "@/lib/email/queue-policy";
import { isUnsubscribeRoutePath } from "@/lib/email/unsubscribe-path";
import type { UnsubscribeUrl } from "@/lib/email/unsubscribe";
import { firstNameOf } from "@/lib/email/campaign-dispatch-rules";

/** The EmailJob `kind` of every abandoned-cart reminder. Like "campaign", a job of this kind is gated against its RecoveryEmail row before SMTP. */
export const RECOVERY_JOB_KIND = "abandoned-cart";
/** Only the first reminder step exists: one reminder per abandonment (a cart used again and abandoned later is a new abandonment). */
export const ABANDONED_CART_STEP = 1;
/** Carts idle longer than this are stale leftovers, not recoverable abandonment (same limit as the admin list). */
export const ABANDONED_CART_MAX_AGE_DAYS = 30;

/** Fixed codes written to EmailJob.errorCode / RecoveryEmail.errorCode when the worker deliberately does NOT send. */
export const RECOVERY_SEND_BLOCK = {
  /** The marketing eligibility (consent / suppression / active contact) no longer allows this e-mail. The recovery row becomes SKIPPED with the eligibility reason. */
  ineligible: "recipient_ineligible",
  /** The recovery row is not QUEUED any more (already settled): sending again could only duplicate. */
  notQueued: "recovery_not_queued",
  /** A "abandoned-cart" job without a RecoveryEmail row: nothing to verify it against, so it never reaches SMTP. */
  recipientMissing: "recipient_missing",
  /** The customer was active again (or ordered) after the reminder was queued: the abandonment is over. */
  cartNoLongerAbandoned: "cart_no_longer_abandoned",
  unsubscribeUnavailable: "unsubscribe_unavailable",
  unsubscribeMissing: "unsubscribe_link_missing",
} as const;
export type RecoverySendBlock = (typeof RECOVERY_SEND_BLOCK)[keyof typeof RECOVERY_SEND_BLOCK];

/** Why a cart was not queued in an admin "Send reminders" click. A fixed vocabulary (also stored as RecoveryEmail.skipReason where a row exists). */
export type CartSkipReason =
  | "not_found"
  | "not_abandoned"
  | "converted"
  | "guest_cart"
  | "already_reminded"
  | "invalid_email"
  | "no_contact"
  | "suppressed"
  | "inactive"
  | "no_consent"
  | "unverifiable"
  | "nothing_available"
  | "unsubscribe_unavailable"
  | "invalid_message"
  | "not_queued";

export const CART_SKIP_LABEL: Record<CartSkipReason, string> = {
  not_found: "Cart no longer exists",
  not_abandoned: "Cart is no longer abandoned for the chosen period",
  converted: "Customer placed an order after leaving the cart",
  guest_cart: "Guest cart: no e-mail address is known",
  already_reminded: "A reminder was already queued or sent for this abandonment",
  invalid_email: "Invalid address",
  no_contact: "Not an e-mail marketing contact",
  suppressed: "Suppressed (unsubscribed, bounced, complained or blocked by an admin)",
  inactive: "Contact is inactive",
  no_consent: "No valid marketing consent",
  unverifiable: "Eligibility could not be verified",
  nothing_available: "None of the items in the cart is available any more",
  unsubscribe_unavailable: "Unsubscribe link could not be created",
  invalid_message: "The reminder could not be built",
  not_queued: "The reminder could not be queued",
};

export type CartFacts = {
  /** Newest CartItem.updatedAt, or null for an empty cart. */
  lastActivity: Date | null;
  hasUser: boolean;
  /** A signed-in customer's order placed at/after lastActivity. */
  orderedSince: boolean;
};

export type CartAssessment = { ok: true; eventKey: string; lastActivity: Date } | { ok: false; reason: "not_abandoned" | "converted" | "guest_cart" };

/**
 * THE rule for "may this cart be reminded now?": it has items, its last activity is older than the chosen inactivity period but not older than the stale
 * limit, a signed-in customer has not ordered since, and it belongs to a customer (a guest cart has no address). Mirrors abandoned-cart.service's list.
 */
export function assessCartForReminder(cartId: string, facts: CartFacts, hours: number, now: Date): CartAssessment {
  const last = facts.lastActivity;
  if (!(last instanceof Date) || Number.isNaN(last.getTime())) return { ok: false, reason: "not_abandoned" };
  const cutoff = now.getTime() - hours * 3_600_000;
  const oldest = now.getTime() - ABANDONED_CART_MAX_AGE_DAYS * 86_400_000;
  if (!(last.getTime() < cutoff) || !(last.getTime() >= oldest)) return { ok: false, reason: "not_abandoned" };
  if (!facts.hasUser) return { ok: false, reason: "guest_cart" };
  if (facts.orderedSince) return { ok: false, reason: "converted" };
  const eventKey = abandonedCartEventKey(cartId, last);
  return eventKey ? { ok: true, eventKey, lastActivity: last } : { ok: false, reason: "not_abandoned" };
}

// ---------------------------------------------------------------------------------------------------------------------------------- message

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

export type ReminderItem = { name: string; variant: string | null; quantity: number };
export type ReminderMessage = { ok: true; input: EmailJobInput; dedupeKey: string } | { ok: false; message: string };

/**
 * The reminder: plain text and simple HTML, both with the contact's own unsubscribe URL (the worker re-proves that before SMTP). Product names are
 * escaped in the HTML; control characters never reach the subject or text. `eventKey` + the step identify the logical e-mail, so the same abandonment can
 * never be queued twice.
 */
export function buildAbandonedCartMessage(input: {
  eventKey: string;
  contact: { email: string; name: string | null };
  items: readonly ReminderItem[];
  storeName: string;
  cartUrl: string;
  unsubscribeUrl: UnsubscribeUrl;
}): ReminderMessage {
  const bad = (message: string): ReminderMessage => ({ ok: false, message });
  let path: string | null = null;
  try { path = new URL(input.unsubscribeUrl).pathname; } catch { path = null; }
  if (!isUnsubscribeRoutePath(path)) return bad("The unsubscribe URL is not an unsubscribe link.");
  if (!input.items.length) return bad("The cart has no items.");
  const store = oneLine(input.storeName) || "our store";
  const first = firstNameOf(input.contact.name);
  const greeting = first ? `Hi ${oneLine(first)},` : "Hi,";
  const lines = input.items.slice(0, 10).map((i) => `${Math.max(1, Math.floor(i.quantity))} x ${oneLine(i.name)}${i.variant ? ` (${oneLine(i.variant)})` : ""}`);
  const more = input.items.length > 10 ? `…and ${input.items.length - 10} more item(s)` : "";
  const subject = `You left something in your cart at ${store}`.slice(0, 200);
  const text = [
    greeting, "", `You left these items in your cart at ${store}:`, "", ...lines.map((l) => `  - ${l}`), ...(more ? [`  ${more}`] : []), "",
    `Pick up where you left off: ${input.cartUrl}`, "",
    `You are receiving this because you agreed to receive marketing e-mail from ${store}.`, `Unsubscribe: ${input.unsubscribeUrl}`,
  ].join("\n");
  const html = [
    `<p>${esc(greeting)}</p>`, `<p>You left these items in your cart at ${esc(store)}:</p>`,
    `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}${more ? `<li>${esc(more)}</li>` : ""}</ul>`,
    `<p><a href="${esc(input.cartUrl)}">Pick up where you left off</a></p>`,
    `<p style="font-size:12px;color:#666">You are receiving this because you agreed to receive marketing e-mail from ${esc(store)}. <a href="${esc(input.unsubscribeUrl)}">Unsubscribe</a></p>`,
  ].join("");
  const parts = [RECOVERY_JOB_KIND, input.eventKey, String(ABANDONED_CART_STEP)];
  const job: EmailJobInput = { kind: RECOVERY_JOB_KIND, dedupeParts: parts, to: input.contact.email, subject, text, html };
  const checked = validateEmailJobInput(job);
  if (!checked.ok) return bad(checked.message);
  if (!text.includes(input.unsubscribeUrl) || !html.includes(esc(input.unsubscribeUrl))) return bad("The message does not contain the unsubscribe URL.");
  const dedupeKey = emailDedupeKey(RECOVERY_JOB_KIND, parts);
  return dedupeKey ? { ok: true, input: job, dedupeKey } : bad("No de-duplication key.");
}
