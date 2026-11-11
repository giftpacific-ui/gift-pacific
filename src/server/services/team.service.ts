import "server-only";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import { teamMemberSchema, type TeamMemberInput } from "@/lib/validations/team-career";

/** The ONLY team fields the public site ever receives. */
export type PublicTeamMember = { id: string; name: string; designation: string; bio: string | null; imageUrl: string | null };

const publicSelect = { id: true, name: true, designation: true, bio: true, imageUrl: true } as const;

// Fields are picked explicitly (an allow-list), so a new column can never leak by accident.
const toPublic = (m: PublicTeamMember): PublicTeamMember => ({
  id: m.id,
  name: m.name,
  designation: m.designation,
  bio: m.bio,
  imageUrl: m.imageUrl,
});

export async function getPublishedTeam(): Promise<{ management: PublicTeamMember[]; staff: PublicTeamMember[] }> {
  const orderBy = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];
  const [management, staff] = await Promise.all([
    prisma.teamMember.findMany({ where: { isPublished: true, section: "MANAGEMENT" }, orderBy, select: publicSelect }),
    prisma.teamMember.findMany({ where: { isPublished: true, section: "STAFF" }, orderBy, select: publicSelect }),
  ]);
  return { management: management.map(toPublic), staff: staff.map(toPublic) };
}

export async function adminListTeam() {
  return prisma.teamMember.findMany({ orderBy: [{ section: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }] });
}

export async function adminSaveTeamMember(id: string | null, raw: TeamMemberInput) {
  const parsed = teamMemberSchema.safeParse(raw);
  if (!parsed.success) throw new UserFacingError(parsed.error.issues[0]?.message ?? "Please check the form.");
  const data = parsed.data;
  if (!id) return prisma.teamMember.create({ data });
  const updated = await prisma.teamMember.updateMany({ where: { id }, data });
  if (updated.count !== 1) throw new UserFacingError("Team member not found.");
  return prisma.teamMember.findUniqueOrThrow({ where: { id } });
}

export async function adminDeleteTeamMember(id: string) {
  const member = await prisma.teamMember.findUnique({ where: { id }, select: { imageCloudinaryPublicId: true } });
  if (!member) throw new UserFacingError("Team member not found.");
  await prisma.teamMember.delete({ where: { id } });
  return member.imageCloudinaryPublicId;
}
