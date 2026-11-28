import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminPreviewSavedEmailTemplate } from "@/server/services/email-template-designer.service";
import { EmailPreview } from "@/features/admin/email-templates/email-preview";
import { SendTestDialog } from "@/features/admin/email-templates/send-test-dialog";

export const metadata: Metadata = { title: "Template preview · Email marketing · Admin" };

export default async function EmailTemplatePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const res = await adminPreviewSavedEmailTemplate(admin.id, id);
  if (!res.ok) { if (res.code === "not_found") return notFound(); return <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{res.message}</p>; }
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">{res.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground"><Badge variant={res.status === "active" ? "success" : res.status === "draft" ? "secondary" : "outline"}>{res.status}</Badge>
            {!res.isDesigner && <span>Created outside the designer: preview only.</span>}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="ghost"><Link href="/admin/email-marketing/templates">Back to templates</Link></Button>
          <SendTestDialog source={{ templateId: id }} />
          {res.isDesigner && res.status !== "archived" && <Button asChild><Link href={`/admin/email-marketing/templates/${id}`}>Edit</Link></Button>}
        </div>
      </div>
      <EmailPreview html={res.html} subject={res.subject} />
    </div>
  );
}
