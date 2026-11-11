import type { Metadata } from "next";
import { adminListAttributeGroups } from "@/server/services/attribute.service";
import { AttributeManager } from "@/features/admin/attribute-manager";

export const metadata: Metadata = { title: "Attributes · Admin" };

export default async function AdminAttributesPage() {
  const groups = await adminListAttributeGroups();
  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl">Attributes</h1>
      <AttributeManager groups={groups} />
    </div>
  );
}
