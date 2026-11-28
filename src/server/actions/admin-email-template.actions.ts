"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import type { FieldError } from "@/lib/email/template-rules";
import {
  adminArchiveEmailTemplate, adminDeleteEmailTemplate, adminDuplicateEmailTemplate, adminPreviewEmailDesign, adminSaveEmailTemplate, adminSearchTemplateProducts,
  adminSendTemplateTestEmail, type PickerProduct, type TemplateStatus,
} from "@/server/services/email-template-designer.service";

/**
 * Server actions for Email marketing > Templates (P12-UI-02). Every action requires an authenticated ADMIN first (it throws FORBIDDEN otherwise, like every
 * admin action) and the service checks the admin again; input is validated again on the server; failures return a fixed safe message (database errors
 * are logged server-side and replaced by a generic text). None of them creates consent, a campaign, a recipient or a queue job.
 */

const LIST = "/admin/email-marketing/templates";
const GENERIC = "Something went wrong. Please try again.";

export type TemplateActionResult<T extends object = object> = ({ success: true } & T) | { success: false; message: string; errors?: FieldError[] };

export async function saveEmailTemplateAction(input: unknown): Promise<TemplateActionResult<{ id: string; status: TemplateStatus; created: boolean; message: string }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSaveEmailTemplate(admin.id, input);
    if (!res.ok) return { success: false, message: res.message, errors: res.errors };
    revalidatePath(LIST);
    return { success: true, id: res.id, status: res.status, created: res.created, message: res.message };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The template could not be saved. Please try again.", "email-templates.save") };
  }
}

export async function duplicateEmailTemplateAction(id: unknown): Promise<TemplateActionResult<{ id: string; name: string }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminDuplicateEmailTemplate(admin.id, id);
    if (!res.ok) return { success: false, message: res.message };
    revalidatePath(LIST);
    return { success: true, id: res.id, name: res.name };
  } catch (error) {
    return { success: false, message: toUserMessage(error, GENERIC, "email-templates.duplicate") };
  }
}

export async function archiveEmailTemplateAction(id: unknown): Promise<TemplateActionResult> {
  const admin = await requireAdmin();
  try {
    const res = await adminArchiveEmailTemplate(admin.id, id);
    if (!res.ok) return { success: false, message: res.message };
    revalidatePath(LIST);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, GENERIC, "email-templates.archive") };
  }
}

export async function deleteEmailTemplateAction(id: unknown): Promise<TemplateActionResult> {
  const admin = await requireAdmin();
  try {
    const res = await adminDeleteEmailTemplate(admin.id, id);
    if (!res.ok) return { success: false, message: res.message };
    revalidatePath(LIST);
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, GENERIC, "email-templates.delete") };
  }
}

export async function previewEmailDesignAction(input: unknown): Promise<TemplateActionResult<{ subject: string; html: string; text: string }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminPreviewEmailDesign(admin.id, input);
    return res.ok ? { success: true, subject: res.subject, html: res.html, text: res.text } : { success: false, message: res.message, errors: res.errors };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The preview could not be built. Please try again.", "email-templates.preview") };
  }
}

export async function searchTemplateProductsAction(query: unknown): Promise<TemplateActionResult<{ products: PickerProduct[] }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSearchTemplateProducts(admin.id, query);
    return res.ok ? { success: true, products: res.products } : { success: false, message: res.message };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Products could not be searched. Please try again.", "email-templates.product-search") };
  }
}

export async function sendTemplateTestEmailAction(input: { recipient?: unknown; templateId?: unknown; subject?: unknown; design?: unknown }): Promise<TemplateActionResult<{ message: string }>> {
  const admin = await requireAdmin();
  try {
    const res = await adminSendTemplateTestEmail(admin.id, input ?? {});
    return res.success ? { success: true, message: res.message } : { success: false, message: res.message };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "The test e-mail could not be sent. Please try again.", "email-templates.test-email") };
  }
}
