/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared setup for the Prompt 10 tests: a campaign built the REAL way (P09 template -> campaign -> audience preparation -> SCHEDULED) on the in-memory
 * database, plus a fake SMTP transport for the real queue worker. Nothing here re-implements production logic.
 */
import type { FakeDb } from "./fake-db";
import { createEmailTemplate } from "@/server/services/email-template.service";
import { createEmailCampaign, transitionEmailCampaignStatus } from "@/server/services/email-campaign.service";
import { prepareCampaignRecipients } from "@/server/services/email-campaign-recipient.service";

export const T0 = new Date("2026-11-25T08:00:00.000Z"); // the audience is prepared and the campaign scheduled at T0
export const T1 = new Date("2026-11-25T09:00:00.000Z"); // scheduled for T1
export const NOW = new Date("2026-11-25T10:00:00.000Z"); // dispatch and the worker run at NOW (the campaign is due)

// Prompt 11: campaigns need a dedicated unsubscribe secret and a public https base URL. Test-only values; each test file runs in its own process.
export const UNSUB_SECRET = "test-only-unsubscribe-secret-Zq8Lm3Vx7Rb2Nc5Kd9Wp4Ty6";
export const UNSUB_BASE = "https://shop.example.com";
process.env.EMAIL_UNSUBSCRIBE_SECRET = UNSUB_SECRET;
process.env.NEXT_PUBLIC_APP_URL = UNSUB_BASE;
/** Runs `fn` with some unsubscribe environment variables replaced (undefined = removed), then restores them. */
export async function withUnsubEnv<T>(over: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

export const PASS = "abcdefghijklmnop";
export const SMTP_ENV = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "shop@gmail.com", SMTP_PASS: PASS };

/** A fake SMTP transport: records every message, can be told how to answer, and counts how often a connection was opened. */
export function makeSmtp() {
  const smtp = {
    opened: 0,
    mails: [] as any[],
    behaviour: (async (mail: any) => ({ messageId: "<id@gmail.com>", accepted: [mail.to], rejected: [] })) as (mail: any) => Promise<any>,
    factory: undefined as any,
  };
  smtp.factory = () => { smtp.opened++; return { verify: async () => true, sendMail: async (m: any) => { smtp.mails.push(m); return smtp.behaviour(m); }, close: () => {} }; };
  return smtp;
}
export const smtpFails = (code: string) => async () => { throw Object.assign(new Error(`server said no to ${PASS}`), { code }); };

export async function optedIn(db: FakeDb, email: string, over: { name?: string | null; isActive?: boolean } = {}) {
  const local = email.split("@")[0];
  const contact = await (db as any).emailContact.create({ data: { email, name: over.name === undefined ? `${local[0].toUpperCase()}${local.slice(1)} Tester` : over.name, source: "MANUAL", ...(over.isActive === undefined ? {} : { isActive: over.isActive }) } });
  const consent = await (db as any).marketingConsent.create({ data: { contactId: contact.id, source: "ADMIN_RECORDED", grantedAt: new Date(T0.getTime() - 86_400_000) } });
  return { contact, consent };
}

export type Fixture = { campaignId: string; templateId: string; contacts: Record<string, { contact: any; consent: any }>; recipients: () => any[] };

/** Contacts with valid consent -> template -> campaign -> prepared audience -> SCHEDULED for T1. */
export async function scheduledCampaign(db: FakeDb, emails: string[], over: { subject?: string; textBody?: string; htmlBody?: string | null; chunkSize?: number; /** A second campaign for contacts that already exist (Prompt 11). */ reuse?: boolean; name?: string; /** Prompt 12: record SCHEDULED directly in the database, as a campaign scheduled BEFORE the P12 server-side checks existed would be. Lets tests prove the dispatcher's own P11 checks still hold on their own. */ legacy?: boolean } = {}): Promise<Fixture> {
  const contacts: Fixture["contacts"] = {};
  for (const e of emails) {
    if (over.reuse) { const contact = db.rows("emailContact").find((c) => c.email === e)!; contacts[e] = { contact, consent: db.rows("marketingConsent").find((c) => c.contactId === contact.id)! }; }
    else contacts[e] = await optedIn(db, e);
  }
  const t: any = await createEmailTemplate({ name: over.name ?? "Winter sale", subject: over.subject ?? "Hi {{firstName}}", textBody: over.textBody ?? "Hello {{customerName}}, welcome to {{storeName}}. Unsubscribe: {{unsubscribeUrl}}", htmlBody: over.htmlBody === undefined ? '<p>Hello {{customerName}}</p><p><a href="{{unsubscribeUrl}}">Unsubscribe</a></p>' : over.htmlBody }, { db: db as never });
  if (!t.ok) throw new Error(`template: ${JSON.stringify(t)}`);
  const c: any = await createEmailCampaign({ name: over.name ?? "Winter campaign", templateId: t.template.id }, { db: db as never });
  if (!c.ok) throw new Error(`campaign: ${JSON.stringify(c)}`);
  const campaignId = c.campaign.id as string;
  const prep: any = await prepareCampaignRecipients(campaignId, {}, { db: db as never, now: T0, chunkSize: over.chunkSize });
  if (!prep.ok || prep.added !== emails.length) throw new Error(`prepare: ${JSON.stringify(prep)}`);
  if (over.legacy) db.patch("emailCampaign", campaignId, { status: "SCHEDULED", scheduledAt: T1 });
  else {
    const sched: any = await transitionEmailCampaignStatus(campaignId, "SCHEDULED", { db: db as never, now: T0, scheduledAt: T1.toISOString() });
    if (!sched.ok) throw new Error(`schedule: ${JSON.stringify(sched)}`);
  }
  return { campaignId, templateId: t.template.id, contacts, recipients: () => db.rows("emailCampaignRecipient").filter((r) => r.campaignId === campaignId) };
}

/** Captures console output (the logger writes there) so tests can prove nothing sensitive is logged. */
export function captureLogs() {
  const lines: string[] = [];
  const real = { warn: console.warn, info: console.info, error: console.error, log: console.log };
  const grab = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  console.warn = console.info = console.error = console.log = grab as never;
  return { lines, restore: () => Object.assign(console, real) };
}
