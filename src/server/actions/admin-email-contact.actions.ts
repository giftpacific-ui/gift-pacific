"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import type { CreateContactOutcome, CsvImportSummary, CsvPreview } from "@/lib/email-contacts";
import {
  adminCreateEmailContact, adminImportContactCsv, adminPreviewContactCsv, adminRecordContactConsent, adminSetEmailContactActive, adminSetEmailContactsActive,
  adminWithdrawContactConsent, type ConsentChangeResult,
} from "@/server/services/email-contact-admin.service";

/**
 * Server actions for Email marketing > Contacts (P12-UI-01). Every action requires an authenticated ADMIN first (it throws FORBIDDEN otherwise, like
 * every admin action), validates its input again on the server (the services do), and returns a safe message: database errors are logged server-side
 * and replaced by a generic text. None of them sends mail, queues a job or lifts a suppression. The consent actions only APPEND history (a new opt-in row, or
 * an end stamp on the open one); they never edit or delete it.
 */

const LIST = "/admin/email-marketing/contacts";
const GENERIC = "Something went wrong. Please try again.";

export type EmailContactActionResult<T extends object = object> = ({ success: true } & T) | { success: false; message: string; field?: string };

export async function createEmailContactAction(
  input: { email?: unknown; name?: unknown; grantConsent?: unknown; consentEvidence?: unknown },
): Promise<EmailContactActionResult<{ message: string; contactId: string; created: boolean; consent: CreateContactOutcome }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminCreateEmailContact(admin.id, input);
    if (!res.ok) return { success: false, message: res.message, field: res.field };
    revalidatePath(LIST);
    return { success: true, message: res.message, contactId: res.contactId, created: res.created, consent: res.consent };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The contact could not be saved. Please try again.", "email-contacts.create") };
  }
}

export async function previewEmailContactsCsvAction(csv: unknown): Promise<EmailContactActionResult<{ preview: CsvPreview }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminPreviewContactCsv(admin.id, csv);
    return res.ok ? { success: true, preview: res.preview } : { success: false, message: res.message };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The file could not be checked. Please try again.", "email-contacts.csv-preview") };
  }
}

export async function importEmailContactsCsvAction(csv: unknown, attestConsent: unknown): Promise<EmailContactActionResult<{ summary: CsvImportSummary }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminImportContactCsv(admin.id, csv, { attestConsent });
    if (!res.ok) return { success: false, message: res.message };
    revalidatePath(LIST);
    return { success: true, summary: res.summary };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The import could not be completed. Importing the same file again is safe.", "email-contacts.csv-import") };
  }
}

export async function setEmailContactActiveAction(contactId: unknown, isActive: unknown): Promise<EmailContactActionResult> {
  const admin = await requireAdmin();
  try {
    const res = await adminSetEmailContactActive(admin.id, contactId, isActive);
    if (!res.ok) return { success: false, message: res.message };
    revalidatePath(LIST);
    if (typeof contactId === "string") revalidatePath(`${LIST}/${contactId}`);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, GENERIC, "email-contacts.set-active") };
  }
}

export async function setEmailContactsActiveAction(contactIds: unknown, isActive: unknown): Promise<EmailContactActionResult<{ updated: number; missing: number }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSetEmailContactsActive(admin.id, contactIds, isActive);
    if (!res.ok) return { success: false, message: res.message };
    revalidatePath(LIST);
    return { success: true, updated: res.updated, missing: res.missing };
  } catch (error) {
    return { success: false, message: toUserMessage(error, GENERIC, "email-contacts.bulk-set-active") };
  }
}

type ConsentActionResult = { success: true; outcome: string; message: string } | { success: false; message: string; code?: string; field?: string };
const consentResult = (res: ConsentChangeResult): ConsentActionResult => (res.ok ? { success: true, outcome: res.outcome, message: res.message } : { success: false, message: res.message, code: res.code, field: res.field });

/** Records an explicit marketing opt-in for an existing contact (evidence + attestation required; never lifts a suppression). */
export async function recordEmailContactConsentAction(contactId: unknown, input: { evidence?: unknown; attest?: unknown }): Promise<ConsentActionResult> {
  const admin = await requireAdmin();
  try {
    const res = await adminRecordContactConsent(admin.id, contactId, input);
    if (res.ok && typeof contactId === "string") { revalidatePath(LIST); revalidatePath(`${LIST}/${contactId}`); }
    return consentResult(res);
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Consent could not be recorded. Please try again.", "email-contacts.consent-record") };
  }
}

/** Records that an existing contact withdrew marketing consent (ends the open consent; history is kept). */
export async function withdrawEmailContactConsentAction(contactId: unknown, input: { note?: unknown } = {}): Promise<ConsentActionResult> {
  const admin = await requireAdmin();
  try {
    const res = await adminWithdrawContactConsent(admin.id, contactId, input);
    if (res.ok && typeof contactId === "string") { revalidatePath(LIST); revalidatePath(`${LIST}/${contactId}`); }
    return consentResult(res);
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The withdrawal could not be recorded. Please try again.", "email-contacts.consent-withdraw") };
  }
}
