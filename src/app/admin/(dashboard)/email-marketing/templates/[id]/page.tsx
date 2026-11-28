import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { TEMPLATE_CATEGORIES } from "@/lib/email/template-rules";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminGetEmailTemplateForEditor } from "@/server/services/email-template-designer.service";
import { TemplateEditor } from "@/features/admin/email-templates/template-editor";

export const metadata: Metadata = { title: "Edit template · Email marketing · Admin" };

export default async function EditEmailTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const res = await adminGetEmailTemplateForEditor(admin.id, id);
  if (!res.ok) return notFound();
  const t = res.template;
  // Archived templates cannot be edited, and templates written outside the designer have no design to edit: both open as a preview instead.
  if (t.status === "archived" || !t.design) redirect(`/admin/email-marketing/templates/${t.id}/preview`);
  return <TemplateEditor categories={TEMPLATE_CATEGORIES} key={t.id} initial={{ id: t.id, name: t.name, category: t.category, subject: t.subject, status: t.status, campaignCount: t.campaignCount }} initialDesign={t.design} initialProducts={t.products} />;
}
