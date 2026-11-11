"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { deleteImageFromCloudinary } from "@/lib/cloudinary/cloudinary";
import {
  adminDeleteTeamMember,
  adminSaveTeamMember,
} from "@/server/services/team.service";
import {
  adminDeleteApplication,
  adminDeleteJob,
  adminDeleteQuestion,
  adminSaveJob,
  adminSaveQuestion,
  adminUpdateApplication,
} from "@/server/services/career.service";
import type { TeamMemberInput, JobPostInput, JobQuestionInput } from "@/lib/validations/team-career";

type Result = { success: true; id?: string } | { success: false; message: string };

async function run(fn: () => Promise<Result | void>, fallback: string, paths: string[]): Promise<Result> {
  await requireAdmin(); // every admin action authenticates first
  try {
    const out = await fn();
    for (const p of paths) revalidatePath(p);
    return out ?? { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, fallback) };
  }
}

export async function saveTeamMemberAction(id: string | null, input: TeamMemberInput) {
  return run(async () => ({ success: true as const, id: (await adminSaveTeamMember(id, input)).id }), "Could not save the team member.", ["/admin/team", "/about-us"]);
}

export async function deleteTeamMemberAction(id: string) {
  return run(async () => {
    const publicId = await adminDeleteTeamMember(id);
    if (publicId) await deleteImageFromCloudinary(publicId);
  }, "Could not delete the team member.", ["/admin/team", "/about-us"]);
}

export async function saveJobAction(id: string | null, input: JobPostInput) {
  return run(async () => ({ success: true as const, id: (await adminSaveJob(id, input)).id }), "Could not save the job.", ["/admin/careers", "/career"]);
}

export async function deleteJobAction(id: string) {
  return run(() => adminDeleteJob(id), "Could not delete the job.", ["/admin/careers", "/career"]);
}

export async function saveQuestionAction(jobId: string, questionId: string | null, input: JobQuestionInput) {
  return run(() => adminSaveQuestion(jobId, questionId, input), "Could not save the question.", [`/admin/careers/${jobId}`, "/career"]);
}

export async function deleteQuestionAction(jobId: string, questionId: string) {
  return run(() => adminDeleteQuestion(jobId, questionId), "Could not delete the question.", [`/admin/careers/${jobId}`, "/career"]);
}

export async function updateApplicationAction(id: string, data: { status?: string; adminNote?: string | null }, jobId: string) {
  return run(() => adminUpdateApplication(id, data), "Could not update the application.", [`/admin/careers/${jobId}`]);
}

export async function deleteApplicationAction(id: string, jobId: string) {
  return run(() => adminDeleteApplication(id), "Could not delete the application.", [`/admin/careers/${jobId}`]);
}
