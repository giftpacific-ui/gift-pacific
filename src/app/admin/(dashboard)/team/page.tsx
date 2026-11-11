import type { Metadata } from "next";
import { adminListTeam } from "@/server/services/team.service";
import { TeamManager } from "@/features/admin/team-manager";

export const metadata: Metadata = { title: "Team · Admin" };

export default async function AdminTeamPage() {
  const members = await adminListTeam();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Team</h1>
        <p className="text-sm text-muted-foreground">Shown on the public About Us page: Management first, then Staff. Only published members appear.</p>
      </div>
      <TeamManager members={members} />
    </div>
  );
}
