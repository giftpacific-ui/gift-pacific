import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { siteConfig } from "@/config/site";
import { isRecordId } from "@/lib/email/template-rules";
import { abandonedCartEventKey, normalizeContactEmail } from "@/lib/email/marketing";
import { readUnsubscribeConfig } from "@/lib/email/unsubscribe";
import { EMAIL_MANUAL_MAX_CARTS, EMAIL_MANUAL_MAX_JOBS } from "@/lib/email/queue-policy";
import { ABANDONED_CART_STEP, assessCartForReminder, buildAbandonedCartMessage, CART_SKIP_LABEL, type CartSkipReason } from "@/lib/email/recovery-rules";
import { parseAbandonedHours } from "@/server/services/abandoned-cart.service";
import { getMarketingEligibility } from "@/server/services/email-marketing-eligibility.service";
import { ensureContactUnsubscribeLink } from "@/server/services/email-unsubscribe.service";
import { enqueueEmails } from "@/server/services/email-queue.service";
import { describeManualRun, runEmailQueueNow, type ManualRunReport } from "@/server/services/email-manual-run.service";
import { assertAdminActor, recordAudit } from "@/server/services/advance.service";
import { logServerInfo, logServerWarning } from "@/lib/logger";

type Db = typeof prisma;
type Tx = Prisma.TransactionClient;
type EligibilityDb = NonNullable<Parameters<typeof getMarketingEligibility>[1]>["db"];
type Env = Record<string, string | undefined>;

/**
 * Abandoned-cart reminder e-mails (admin-triggered ONLY). The admin selects carts on /admin/abandoned-carts and clicks "Send reminders"; that one request:
 *   1. re-checks the admin and RE-DERIVES every selected cart from the database (still abandoned for the chosen period, a customer cart, no order since). The
 *      browser sends only cart ids and the period; never an address, a message or an eligibility verdict;
 *   2. re-checks marketing eligibility NOW with the existing getMarketingEligibility (active contact + valid marketing consent + no suppression): a customer
 *      without consent is skipped, never mailed. Guest carts have no address and are skipped;
 *   3. in ONE transaction per cart: writes the RecoveryEmail row (unique [eventKey, step]: one reminder per abandonment, also under concurrent clicks) and puts the
 *      personalised message, with the contact's own unsubscribe link, on the EXISTING EmailJob queue (kind "abandoned-cart", unique dedupe key);
 *   4. runs ONE bounded, awaited batch of the EXISTING queue worker for exactly these jobs (email-manual-run.service). The worker gates every reminder again right
 *      before SMTP (email-recovery-delivery.service) and marks it SENT only after the SMTP server accepted it.
 * Whatever did not fit in the batch stays PENDING and is sent by a later explicit click (Retry on the send queue page). Nothing finds, queues or sends abandoned-cart
 * e-mail in the background, and the page does not need to stay open once the request has returned.
 */

export type ReminderOutcome = {
  queued: number;
  skipped: { cartId: string; reason: CartSkipReason; label: string }[];
  delivery: (ManualRunReport & { waiting: number }) | null;
};
export type ReminderFailure = { ok: false; code: string; message: string };
export type ReminderResult = ({ ok: true; message: string } & ReminderOutcome) | ReminderFailure;

const fail = (code: string, message: string): ReminderFailure => ({ ok: false, code, message });
const TX_OPTIONS = { timeout: 15_000, maxWait: 5_000 };
const errName = (e: unknown) => (e instanceof Error ? e.name : "unknown");

export async function adminSendAbandonedCartReminders(
  adminId: unknown,
  input: { cartIds?: unknown; hours?: unknown },
  opts: { db?: Db; now?: Date; unsubscribeEnv?: Env; smtpEnv?: Env; factory?: Parameters<typeof runEmailQueueNow>[0]["factory"]; startedAt?: number } = {},
): Promise<ReminderResult> {
  const startedAt = opts.startedAt ?? Date.now();
  const db = opts.db ?? prisma;
  let actor: string;
  try { actor = await assertAdminActor(db as unknown as Parameters<typeof assertAdminActor>[0], typeof adminId === "string" ? adminId : null); } catch { return fail("forbidden", "You are not authorised to do this."); }
  const now = opts.now ?? new Date();
  const env = opts.unsubscribeEnv ?? process.env;

  const raw = Array.isArray(input?.cartIds) ? input.cartIds : [];
  const cartIds = [...new Set(raw.filter((x): x is string => isRecordId(x)))];
  if (cartIds.length === 0) return fail("invalid_selection", "Select at least one cart.");
  if (raw.length !== cartIds.length && raw.some((x) => !isRecordId(x))) return fail("invalid_selection", "The selection contains an invalid cart.");
  if (cartIds.length > EMAIL_MANUAL_MAX_CARTS) return fail("too_many", `Select at most ${EMAIL_MANUAL_MAX_CARTS} carts per click.`);
  const hours = parseAbandonedHours(input.hours);

  // Nothing is queued without a working unsubscribe link: both the dedicated secret and the public https base URL must be usable.
  const unsubscribe = readUnsubscribeConfig(env);
  if (!unsubscribe.ok) return fail("unsubscribe_link_unavailable", "Unsubscribe links cannot be created (EMAIL_UNSUBSCRIBE_SECRET or NEXT_PUBLIC_APP_URL is not set correctly). Nothing was queued.");

  const skipped: ReminderOutcome["skipped"] = [];
  const jobIds: string[] = [];
  const skip = (cartId: string, reason: CartSkipReason) => skipped.push({ cartId, reason, label: CART_SKIP_LABEL[reason] });

  for (const cartId of cartIds) {
    try {
      const cart = await db.cart.findUnique({ where: { id: cartId }, select: { id: true, userId: true } });
      if (!cart) { skip(cartId, "not_found"); continue; }
      const items = await db.cartItem.findMany({ where: { cartId }, include: { product: { select: { name: true, status: true } }, variant: { select: { name: true } } } });
      const last = (items as { updatedAt: Date }[]).reduce<Date | null>((m, i) => (m === null || i.updatedAt > m ? i.updatedAt : m), null);
      const user = cart.userId ? await db.user.findUnique({ where: { id: cart.userId }, select: { id: true, email: true, name: true } }) : null;
      const orderedSince = user && last ? (await db.order.count({ where: { userId: user.id, createdAt: { gte: last } } })) > 0 : false;
      const verdict = assessCartForReminder(cartId, { lastActivity: last, hasUser: Boolean(user), orderedSince }, hours, now);
      if (!verdict.ok) { skip(cartId, verdict.reason); continue; }
      if (!user) { skip(cartId, "guest_cart"); continue; }

      const normalized = normalizeContactEmail(user.email);
      if (!normalized.ok) { skip(cartId, "invalid_email"); continue; }
      const eligible = await getMarketingEligibility(normalized.email, { db: db as unknown as EligibilityDb, now });
      if (!eligible.eligible || !eligible.consentId) { skip(cartId, eligible.eligible ? "unverifiable" : (eligible.reason as CartSkipReason)); continue; }

      const listed = (items as { quantity: number; product: { name: string; status: string }; variant: { name: string } | null }[])
        .filter((i) => i.product.status === "ACTIVE").map((i) => ({ name: i.product.name, variant: i.variant?.name ?? null, quantity: i.quantity }));
      if (listed.length === 0) { skip(cartId, "nothing_available"); continue; }

      const res = await queueReminder(db, { cartId, eventKey: verdict.eventKey, email: normalized.email, name: user.name ?? null, consentId: eligible.consentId, items: listed, config: unsubscribe, env, now });
      if (res.ok) jobIds.push(res.jobId); else skip(cartId, res.reason);
    } catch (error) {
      // One cart's failure never stops the others; the cart simply was not queued and can be selected again.
      logServerWarning("abandoned_cart.queue_failed", `Could not queue a reminder (${errName(error)})`, { cartId });
      skip(cartId, "not_queued");
    }
  }

  let delivery: ReminderOutcome["delivery"] = null;
  if (jobIds.length) {
    const report = await runEmailQueueNow({ startedAt, jobIds: jobIds.slice(0, EMAIL_MANUAL_MAX_JOBS * 2), db, env: opts.smtpEnv, factory: opts.factory, now, maxJobs: EMAIL_MANUAL_MAX_JOBS });
    let waiting = jobIds.length;
    try { waiting = await db.emailJob.count({ where: { id: { in: jobIds }, status: "PENDING" } }); } catch { /* informational */ }
    delivery = { ...report, waiting };
  }
  await recordAudit(db as unknown as Parameters<typeof recordAudit>[0], { actorId: actor, action: "abandoned_cart.send_reminders", entityType: "RecoveryEmail", entityId: null, detail: { selected: cartIds.length, queued: jobIds.length, skipped: skipped.length, sent: delivery?.sent ?? 0, hours } }).catch(() => undefined);
  logServerInfo("abandoned_cart.reminders", "Abandoned-cart reminders handled by an admin click", { selected: cartIds.length, queued: jobIds.length, skipped: skipped.length, sent: delivery?.sent ?? 0 });

  const head = jobIds.length ? `${jobIds.length} reminder(s) queued.` : "No reminder was queued.";
  const skippedText = skipped.length ? ` ${skipped.length} cart(s) skipped.` : "";
  const run = delivery ? ` ${describeManualRun(delivery, delivery.waiting)}` : "";
  return { ok: true, queued: jobIds.length, skipped, delivery, message: `${head}${skippedText}${run}` };
}

/** One cart, one transaction: recovery row + job together. Returns the job id, or why the cart was not queued. Never queues the same abandonment twice. */
async function queueReminder(
  db: Db,
  a: { cartId: string; eventKey: string; email: string; name: string | null; consentId: string; items: { name: string; variant: string | null; quantity: number }[]; config: Extract<ReturnType<typeof readUnsubscribeConfig>, { ok: true }>; env: Env; now: Date },
): Promise<{ ok: true; jobId: string } | { ok: false; reason: CartSkipReason }> {
  class Skip extends Error { constructor(readonly reason: CartSkipReason) { super(reason); } }
  try {
    const jobId = await db.$transaction(async (tx: Tx) => {
      const existing = await tx.recoveryEmail.findFirst({ where: { eventKey: a.eventKey, step: ABANDONED_CART_STEP }, select: { id: true } });
      if (existing) throw new Skip("already_reminded");
      const contact = await tx.emailContact.findUnique({ where: { email: a.email }, select: { id: true, email: true, name: true, unsubscribeTokenHash: true } });
      if (!contact) throw new Skip("no_contact");
      const link = await ensureContactUnsubscribeLink(tx as never, contact, a.config, a.env);
      if (!link.ok) throw new Skip("unsubscribe_unavailable");
      const message = buildAbandonedCartMessage({ eventKey: a.eventKey, contact: { email: contact.email, name: a.name ?? contact.name ?? null }, items: a.items, storeName: siteConfig.name, cartUrl: `${a.config.origin}/cart`, unsubscribeUrl: link.url });
      if (!message.ok) throw new Skip("invalid_message");
      const queued = await enqueueEmails([message.input], { db: tx as unknown as Db, now: a.now, priority: "bulk" });
      if (!queued.ok || queued.invalid.length > 0) throw new Error("enqueue_failed");
      if (queued.queued !== 1) throw new Skip("already_reminded"); // a job with this key exists already: never link or resend it from here
      const job = await tx.emailJob.findUnique({ where: { dedupeKey: message.dedupeKey }, select: { id: true } });
      if (!job) throw new Error("job_missing");
      await tx.recoveryEmail.create({ data: { kind: "ABANDONED_CART", eventKey: a.eventKey, step: ABANDONED_CART_STEP, contactId: contact.id, cartId: a.cartId, status: "QUEUED", emailJobId: job.id, consentId: a.consentId, queuedAt: a.now } });
      return job.id;
    }, TX_OPTIONS);
    return { ok: true, jobId };
  } catch (error) {
    if (error instanceof Skip) return { ok: false, reason: error.reason };
    if ((error as { code?: string })?.code === "P2002") return { ok: false, reason: "already_reminded" }; // a concurrent click won the unique [eventKey, step]
    throw error;
  }
}

// -------------------------------------------------------------------------------------------------------------------------- display state

export type ReminderState = { status: "QUEUED" | "SENT" | "FAILED" | "SKIPPED" | "PENDING"; label: string };
const STATE_LABEL: Record<ReminderState["status"], string> = { PENDING: "Reminder pending", QUEUED: "Reminder queued (not sent yet)", SENT: "Reminder sent", FAILED: "Reminder failed", SKIPPED: "Reminder skipped" };

/** For the admin list: the reminder state of each cart's CURRENT abandonment (same last activity = same event). Read-only; sends and queues nothing. */
export async function getReminderStates(carts: readonly { id: string; lastActivity: Date }[], opts: { db?: Db } = {}): Promise<Map<string, ReminderState>> {
  const db = opts.db ?? prisma;
  const out = new Map<string, ReminderState>();
  const keys = new Map<string, string>();
  for (const c of carts) { const k = abandonedCartEventKey(c.id, c.lastActivity); if (k) keys.set(k, c.id); }
  if (!keys.size) return out;
  const rows = await db.recoveryEmail.findMany({ where: { eventKey: { in: [...keys.keys()] }, step: ABANDONED_CART_STEP }, select: { eventKey: true, status: true } });
  for (const r of rows) { const id = keys.get(r.eventKey); if (id) out.set(id, { status: r.status as ReminderState["status"], label: STATE_LABEL[r.status as ReminderState["status"]] ?? "Reminder recorded" }); }
  return out;
}
