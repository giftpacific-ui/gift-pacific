import type { Metadata } from "next";
import { TEMPLATE_CATEGORIES } from "@/lib/email/template-rules";
import { requireAdmin } from "@/lib/auth/current-user";
import { TemplateEditor } from "@/features/admin/email-templates/template-editor";
import { defaultDesign } from "@/lib/email-template-blocks";

export const metadata: Metadata = {
  title: "New template · Email marketing · Admin",
};

export default async function NewEmailTemplatePage() {
  await requireAdmin();
  return (
    <TemplateEditor
      categories={TEMPLATE_CATEGORIES}
      initial={{
        id: null,
        name: "",
        category: "MARKETING",
        subject: "",
        status: "new",
        campaignCount: 0,
      }}
      initialDesign={defaultDesign()}
      initialProducts={{}}
    />
  );
}
