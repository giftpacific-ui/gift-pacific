import { z } from "zod";
import { isSafeHttpUrl } from "@/lib/url-safety";

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const safeUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => isSafeHttpUrl(v), "Enter a valid https:// link");

export const teamMemberSchema = z.object({
  section: z.enum(["MANAGEMENT", "STAFF"]),
  name: z.string().trim().min(1, "Name is required").max(80),
  designation: z.string().trim().min(1, "Designation is required").max(100),
  bio: optionalText(1500),
  imageUrl: z.union([safeUrl, z.literal("")]).optional().transform((v) => (v ? v : null)),
  imageCloudinaryPublicId: optionalText(300),
  sortOrder: z.number().int().min(0).max(9999),
  isPublished: z.boolean(),
});
export type TeamMemberInput = z.input<typeof teamMemberSchema>;

export const JOB_QUESTION_KINDS = ["TEXT", "TEXTAREA", "SELECT", "YES_NO"] as const;

export const jobPostSchema = z.object({
  title: z.string().trim().min(3, "Title is required").max(120),
  department: optionalText(80),
  location: optionalText(80),
  employmentType: optionalText(60),
  description: z.string().trim().min(20, "Describe the role (at least 20 characters)").max(8000),
  requirements: optionalText(4000),
  status: z.enum(["DRAFT", "PUBLISHED", "CLOSED"]),
  closesAt: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : null))
    .refine((d) => d === null || !Number.isNaN(d.getTime()), "Invalid closing date"),
});
export type JobPostInput = z.input<typeof jobPostSchema>;

export const jobQuestionSchema = z
  .object({
    label: z.string().trim().min(1, "Question is required").max(150),
    kind: z.enum(JOB_QUESTION_KINDS),
    options: z.array(z.string().trim().min(1).max(60)).max(10).default([]),
    isRequired: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(999).default(0),
  })
  .refine((q) => q.kind !== "SELECT" || q.options.length >= 2, {
    message: "A choice question needs at least two options",
    path: ["options"],
  });
export type JobQuestionInput = z.input<typeof jobQuestionSchema>;

export const APPLICATION_STATUSES = ["NEW", "REVIEWING", "SHORTLISTED", "INTERVIEW", "REJECTED", "HIRED"] as const;

/** Public application form: the fixed core fields. Answers to extra questions are checked separately. */
export const applicationCoreSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(200),
  phone: optionalText(30),
  coverNote: optionalText(3000),
  portfolioUrl: z.union([safeUrl, z.literal("")]).optional().transform((v) => (v ? v : null)),
  consent: z.literal(true, { message: "Please agree so we can store your application" }),
  // Honeypot: real people leave it empty; simple bots fill every field.
  website: z.string().max(0).optional(),
});

export type QuestionLite = { id: string; label: string; kind: string; options: string[]; isRequired: boolean };

/** Validates answers to a job's extra questions. Returns the snapshot rows to store, or an error. */
export function validateAnswers(
  questions: QuestionLite[],
  raw: Record<string, unknown>,
): { ok: true; answers: { questionLabel: string; value: string }[] } | { ok: false; message: string } {
  const answers: { questionLabel: string; value: string }[] = [];
  for (const q of questions) {
    const v = raw[q.id];
    const value = typeof v === "string" ? v.trim() : "";
    if (!value) {
      if (q.isRequired) return { ok: false, message: `Please answer: ${q.label}` };
      continue;
    }
    if (value.length > 2000) return { ok: false, message: `Your answer to “${q.label}” is too long.` };
    if (q.kind === "SELECT" && !q.options.includes(value)) return { ok: false, message: `Choose one of the options for “${q.label}”.` };
    if (q.kind === "YES_NO" && value !== "Yes" && value !== "No") return { ok: false, message: `Choose Yes or No for “${q.label}”.` };
    answers.push({ questionLabel: q.label, value });
  }
  return { ok: true, answers };
}
