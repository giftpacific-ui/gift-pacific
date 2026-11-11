import "server-only";
import slugify from "slugify";
import { prisma } from "@/lib/db/prisma";
import { UserFacingError } from "@/lib/errors";
import {
  applicationCoreSchema,
  jobPostSchema,
  jobQuestionSchema,
  validateAnswers,
  type JobPostInput,
  type JobQuestionInput,
} from "@/lib/validations/team-career";

// ---------------------------------------------------------------------------
// PUBLIC — published, not-yet-closed jobs only. No applicant data ever flows here.
// ---------------------------------------------------------------------------
const openWhere = () => ({
  status: "PUBLISHED" as const,
  OR: [{ closesAt: null }, { closesAt: { gt: new Date() } }],
});

export type PublicJob = {
  slug: string;
  title: string;
  department: string | null;
  location: string | null;
  employmentType: string | null;
  closesAt: Date | null;
};

export async function listOpenJobs(): Promise<PublicJob[]> {
  const rows = await prisma.jobPost.findMany({
    where: openWhere(),
    orderBy: { createdAt: "desc" },
    select: { slug: true, title: true, department: true, location: true, employmentType: true, closesAt: true },
  });
  // Explicit allow-list: never a spread of the database row.
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    department: r.department,
    location: r.location,
    employmentType: r.employmentType,
    closesAt: r.closesAt,
  }));
}

export async function getOpenJobBySlug(slug: string) {
  return prisma.jobPost.findFirst({
    where: { slug, ...openWhere() },
    select: {
      id: true,
      slug: true,
      title: true,
      department: true,
      location: true,
      employmentType: true,
      description: true,
      requirements: true,
      closesAt: true,
      questions: { orderBy: { sortOrder: "asc" }, select: { id: true, label: true, kind: true, options: true, isRequired: true } },
    },
  });
}

export type ApplyResult = { success: true } | { success: false; message: string };

/** Validates and stores an application. The caller is responsible for throttling. */
export async function submitApplication(slug: string, raw: Record<string, unknown>): Promise<ApplyResult> {
  const job = await getOpenJobBySlug(slug);
  if (!job) return { success: false, message: "This position is no longer accepting applications." };
  const core = applicationCoreSchema.safeParse(raw);
  if (!core.success) return { success: false, message: core.error.issues[0]?.message ?? "Please check the form." };
  const answersRaw = typeof raw.answers === "object" && raw.answers !== null ? (raw.answers as Record<string, unknown>) : {};
  const answers = validateAnswers(job.questions, answersRaw);
  if (!answers.ok) return { success: false, message: answers.message };

  const existing = await prisma.jobApplication.findFirst({
    where: { jobPostId: job.id, email: core.data.email },
    select: { id: true },
  });
  if (existing) return { success: false, message: "You have already applied for this position." };

  await prisma.jobApplication.create({
    data: {
      jobPostId: job.id,
      name: core.data.name,
      email: core.data.email,
      phone: core.data.phone,
      coverNote: core.data.coverNote,
      portfolioUrl: core.data.portfolioUrl,
      consentAt: new Date(),
      answers: { create: answers.answers },
    },
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// ADMIN — every function below must only ever be called after requireAdmin().
// ---------------------------------------------------------------------------
export async function adminListJobs() {
  return prisma.jobPost.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { applications: true } } },
  });
}

export async function adminGetJob(id: string) {
  return prisma.jobPost.findUnique({ where: { id }, include: { questions: { orderBy: { sortOrder: "asc" } } } });
}

async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title, { lower: true, strict: true }).slice(0, 60) || "position";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await prisma.jobPost.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function adminSaveJob(id: string | null, raw: JobPostInput) {
  const parsed = jobPostSchema.safeParse(raw);
  if (!parsed.success) throw new UserFacingError(parsed.error.issues[0]?.message ?? "Please check the form.");
  if (!id) return prisma.jobPost.create({ data: { ...parsed.data, slug: await uniqueSlug(parsed.data.title) } });
  const updated = await prisma.jobPost.updateMany({ where: { id }, data: parsed.data });
  if (updated.count !== 1) throw new UserFacingError("Job not found.");
  return prisma.jobPost.findUniqueOrThrow({ where: { id } });
}

export async function adminDeleteJob(id: string) {
  // Applications are never silently destroyed with their job: delete them explicitly first.
  const count = await prisma.jobApplication.count({ where: { jobPostId: id } });
  if (count > 0) throw new UserFacingError(`This job has ${count} application(s). Close it instead, or delete the applications first.`);
  await prisma.jobPost.delete({ where: { id } });
}

export async function adminSaveQuestion(jobId: string, questionId: string | null, raw: JobQuestionInput) {
  const parsed = jobQuestionSchema.safeParse(raw);
  if (!parsed.success) throw new UserFacingError(parsed.error.issues[0]?.message ?? "Please check the question.");
  const data = { ...parsed.data, options: parsed.data.kind === "SELECT" ? parsed.data.options : [] };
  if (!questionId) {
    await prisma.jobQuestion.create({ data: { jobPostId: jobId, ...data } });
    return;
  }
  const updated = await prisma.jobQuestion.updateMany({ where: { id: questionId, jobPostId: jobId }, data });
  if (updated.count !== 1) throw new UserFacingError("Question not found.");
}

export async function adminDeleteQuestion(jobId: string, questionId: string) {
  await prisma.jobQuestion.deleteMany({ where: { id: questionId, jobPostId: jobId } });
}

export async function adminListApplications(jobId?: string) {
  return prisma.jobApplication.findMany({
    where: jobId ? { jobPostId: jobId } : {},
    orderBy: { createdAt: "desc" },
    include: { job: { select: { title: true, slug: true } }, answers: true },
    take: 500,
  });
}

export async function adminUpdateApplication(id: string, data: { status?: string; adminNote?: string | null }) {
  const statuses = ["NEW", "REVIEWING", "SHORTLISTED", "INTERVIEW", "REJECTED", "HIRED"];
  if (data.status !== undefined && !statuses.includes(data.status)) throw new UserFacingError("Invalid status.");
  const note = data.adminNote === undefined ? undefined : data.adminNote?.trim().slice(0, 2000) || null;
  const updated = await prisma.jobApplication.updateMany({
    where: { id },
    data: { ...(data.status ? { status: data.status as "NEW" } : {}), ...(note !== undefined ? { adminNote: note } : {}) },
  });
  if (updated.count !== 1) throw new UserFacingError("Application not found.");
}

export async function adminDeleteApplication(id: string) {
  await prisma.jobApplication.deleteMany({ where: { id } });
}
