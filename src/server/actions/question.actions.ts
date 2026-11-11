"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, getSession } from "@/lib/auth/current-user";
import { toUserMessage } from "@/lib/errors";
import { RATE_LIMITS, consumeRateLimit, throttledMessage } from "@/lib/rate-limit";
import {
  adminAnswerQuestion,
  adminDeleteQuestion,
  adminSetQuestionStatus,
  submitQuestion,
} from "@/server/services/question.service";

export type QuestionActionResult = { success: true } | { success: false; message: string };

export async function askQuestionAction(productId: string, text: string): Promise<QuestionActionResult> {
  try {
    const session = await getSession();
    if (session) {
      const throttle = await consumeRateLimit(RATE_LIMITS.question, [session.sub]);
      if (!throttle.ok) return { success: false, message: throttledMessage(throttle) };
    }
    await submitQuestion(productId, text);
    revalidatePath("/admin/questions");
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not send your question.") };
  }
}

function refresh() {
  revalidatePath("/admin/questions");
  revalidatePath("/products/[slug]", "page");
  revalidatePath("/account/notifications");
}

export async function answerQuestionAction(id: string, answer: string): Promise<QuestionActionResult> {
  const admin = await requireAdmin();
  try {
    await adminAnswerQuestion(id, answer, admin.id);
    refresh();
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not save the answer.") };
  }
}

export async function setQuestionStatusAction(id: string, status: "APPROVED" | "HIDDEN"): Promise<QuestionActionResult> {
  await requireAdmin();
  try {
    await adminSetQuestionStatus(id, status);
    refresh();
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not update the question.") };
  }
}

export async function deleteQuestionAction(id: string): Promise<QuestionActionResult> {
  await requireAdmin();
  try {
    await adminDeleteQuestion(id);
    refresh();
    return { success: true };
  } catch (error) {
    return { success: false, message: toUserMessage(error, "Could not delete the question.") };
  }
}
