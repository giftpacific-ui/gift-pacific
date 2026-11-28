/**
 * E-mail campaign rules (Prompt 09). PURE: no database, no network. Uses only the EXISTING EmailCampaignStatus values (DRAFT, SCHEDULED, SENDING,
 * COMPLETED, CANCELLED, FAILED); no status or field is invented here. Limits mirror the CHECK constraints of migration 20261201000000.
 */
import { normalizeContactEmail } from "@/lib/email/marketing";
import { cleanSingleLine, type FieldError } from "@/lib/email/template-rules";

export const CAMPAIGN_STATUSES = ["DRAFT", "SCHEDULED", "SENDING", "COMPLETED", "CANCELLED", "FAILED"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const isCampaignStatus = (v: unknown): v is CampaignStatus => typeof v === "string" && (CAMPAIGN_STATUSES as readonly string[]).includes(v);

export const CAMPAIGN_LIMITS = { name: 160, description: 1000, senderName: 100 } as const;

/** The full lifecycle. COMPLETED, CANCELLED and FAILED are final. SENDING is entered only by the (later) sender. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["DRAFT", "SENDING", "CANCELLED"],
  SENDING: ["COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};
/** Moves that belong to sending itself (a later prompt). The management service refuses them even where the lifecycle allows them. */
export const SENDER_ONLY_STATUSES: readonly CampaignStatus[] = ["SENDING", "COMPLETED", "FAILED"];

export const canTransitionCampaign = (from: CampaignStatus, to: CampaignStatus) => CAMPAIGN_TRANSITIONS[from].includes(to);

/**
 * Prompt 12: the moves the automated dispatcher (and nothing else) may make ITSELF, beside the lifecycle above. There is exactly one: a SCHEDULED
 * campaign that the dispatcher refuses to start for a reason that can no longer change (unusable snapshot, no audience) is closed as FAILED. Nothing
 * has been queued at that point, so no recipient is abandoned. It is deliberately NOT part of CAMPAIGN_TRANSITIONS: the management service still
 * refuses SCHEDULED -> FAILED ("invalid_transition"), so no caller can reach it through a public transition. A campaign that is already SENDING is never
 * closed this way (its queued jobs would be blocked); only its still-PENDING recipients are settled.
 */
export const SYSTEM_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: [],
  SCHEDULED: ["FAILED"],
  SENDING: [],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};
export const canSystemTransitionCampaign = (from: CampaignStatus, to: CampaignStatus) => SYSTEM_TRANSITIONS[from].includes(to);
/** Only a DRAFT may be edited or have its audience prepared. */
export const isCampaignEditable = (status: unknown) => status === "DRAFT";

const err = (field: string, code: string, message: string): FieldError => ({ field, code, message });

export const CAMPAIGN_CREATE_FIELDS = ["name", "description", "templateId", "subject", "senderName", "senderEmail"] as const;
export const CAMPAIGN_UPDATE_FIELDS = CAMPAIGN_CREATE_FIELDS;

/** Rejects keys outside `allowed` (so status, counts, scheduledAt, createdById... can never be written through create/update). */
export function unsupportedFields(input: Record<string, unknown>, allowed: readonly string[]): FieldError[] {
  return Object.keys(input).filter((k) => !allowed.includes(k)).map((k) => err(k, "unsupported_field", `"${k.slice(0, 40)}" cannot be set here.`));
}

export const cleanCampaignName = (raw: unknown) => cleanSingleLine(raw, "name", CAMPAIGN_LIMITS.name, { required: true, label: "Campaign name" });
export const cleanCampaignDescription = (raw: unknown) => cleanSingleLine(raw, "description", CAMPAIGN_LIMITS.description, { required: false, label: "Description" });

/** Sender name goes into a From header: no control characters, and none of the characters that could form an address or a quoted string. */
export function cleanSenderName(raw: unknown): { ok: true; value: string | null } | { ok: false; error: FieldError } {
  const res = cleanSingleLine(raw, "senderName", CAMPAIGN_LIMITS.senderName, { required: false, label: "Sender name" });
  if (res.ok && res.value && /[<>"@]/.test(res.value)) return { ok: false, error: err("senderName", "invalid_characters", 'Sender name must not contain < > " or @.') };
  return res;
}

export function cleanSenderEmail(raw: unknown): { ok: true; value: string | null } | { ok: false; error: FieldError } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "string" && !raw.trim()) return { ok: true, value: null };
  const n = normalizeContactEmail(raw);
  return n.ok ? { ok: true, value: n.email } : { ok: false, error: err("senderEmail", "invalid_email", n.message) };
}

const MAX_SCHEDULE_AHEAD_MS = 366 * 86_400_000;

/** A Date or an ISO date-time string, strictly in the future and within a year. */
export function validateScheduledAt(raw: unknown, now: Date): { ok: true; value: Date } | { ok: false; error: FieldError } {
  const date = raw instanceof Date ? raw : typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T/.test(raw) ? new Date(raw) : null;
  if (!date || Number.isNaN(date.getTime())) return { ok: false, error: err("scheduledAt", "invalid_date", "Choose a valid date and time.") };
  if (date.getTime() <= now.getTime()) return { ok: false, error: err("scheduledAt", "in_the_past", "The scheduled time must be in the future.") };
  if (date.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) return { ok: false, error: err("scheduledAt", "too_far", "The scheduled time must be within one year.") };
  return { ok: true, value: date };
}
