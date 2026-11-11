"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SingleImageUploader, type ImageValue } from "@/features/admin/single-image-uploader";
import { deleteTeamMemberAction, saveTeamMemberAction } from "@/server/actions/admin-team-career.actions";

export type TeamRow = {
  id: string;
  section: "MANAGEMENT" | "STAFF";
  name: string;
  designation: string;
  bio: string | null;
  imageUrl: string | null;
  imageCloudinaryPublicId: string | null;
  sortOrder: number;
  isPublished: boolean;
};

const EMPTY = { section: "STAFF" as const, name: "", designation: "", bio: "", sortOrder: 0, isPublished: true };

function MemberForm({ member, onDone }: { member: TeamRow | null; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState(member ? { section: member.section, name: member.name, designation: member.designation, bio: member.bio ?? "", sortOrder: member.sortOrder, isPublished: member.isPublished } : EMPTY);
  const [image, setImage] = useState<ImageValue | null>(member?.imageUrl ? { url: member.imageUrl, publicId: member.imageCloudinaryPublicId } : null);

  function save() {
    start(async () => {
      const r = await saveTeamMemberAction(member?.id ?? null, { ...form, imageUrl: image?.url ?? "", imageCloudinaryPublicId: image?.publicId ?? "" });
      if (!r.success) return void toast.error(r.message);
      toast.success("Saved");
      onDone();
      router.refresh();
    });
  }
  const label = "grid gap-1.5 text-sm font-medium";
  return (
    <div className="grid gap-4 rounded-xl border border-border/70 bg-card p-5 sm:grid-cols-2">
      <label className={label}>Name<Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} /></label>
      <label className={label}>Designation<Input value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} maxLength={100} /></label>
      <label className={label}>Section
        <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value as "MANAGEMENT" | "STAFF" })}>
          <option value="MANAGEMENT">Management</option>
          <option value="STAFF">Staff</option>
        </select>
      </label>
      <label className={label}>Display order (lowest first)<Input type="number" min={0} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Math.max(0, Number(e.target.value) || 0) })} /></label>
      <label className={`${label} sm:col-span-2`}>Biography<Textarea rows={4} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} maxLength={1500} /></label>
      <div className="sm:col-span-2"><SingleImageUploader value={image} onChange={setImage} folder="team" label="Profile image" aspectClassName="aspect-[4/5] max-w-48" /></div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={form.isPublished} onChange={(e) => setForm({ ...form, isPublished: e.target.checked })} />
        Published (visible on the About Us page)
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Button variant="outline" onClick={onDone} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}

export function TeamManager({ members }: { members: TeamRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [pending, start] = useTransition();

  function remove(id: string) {
    if (!confirm("Delete this team member?")) return;
    start(async () => {
      const r = await deleteTeamMemberAction(id);
      if (!r.success) toast.error(r.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {editing === "new" ? <MemberForm member={null} onDone={() => setEditing(null)} /> : <Button onClick={() => setEditing("new")}>Add team member</Button>}
      {(["MANAGEMENT", "STAFF"] as const).map((section) => (
        <section key={section} className="space-y-3">
          <h2 className="font-heading text-lg">{section === "MANAGEMENT" ? "Management" : "Staff"}</h2>
          {members.filter((m) => m.section === section).length === 0 && <p className="text-sm text-muted-foreground">No members yet.</p>}
          {members.filter((m) => m.section === section).map((m) =>
            editing === m.id ? (
              <MemberForm key={m.id} member={m} onDone={() => setEditing(null)} />
            ) : (
              <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{m.name} <span className="text-muted-foreground">— {m.designation}</span></p>
                  <p className="text-xs text-muted-foreground">Order {m.sortOrder}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge variant={m.isPublished ? "success" : "secondary"}>{m.isPublished ? "Published" : "Hidden"}</Badge>
                  <Button size="sm" variant="outline" onClick={() => setEditing(m.id)}>Edit</Button>
                  <button type="button" aria-label={`Delete ${m.name}`} disabled={pending} onClick={() => remove(m.id)}><Trash2 className="size-4 text-destructive" /></button>
                </div>
              </div>
            ),
          )}
        </section>
      ))}
    </div>
  );
}
