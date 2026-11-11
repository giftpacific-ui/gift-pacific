export const QUESTION_MIN = 10;
export const QUESTION_MAX = 500;
export const ANSWER_MAX = 1000;
/** A customer can have at most this many unreviewed questions per product (stops flooding). */
export const MAX_PENDING_PER_PRODUCT = 3;

export function cleanQuestionText(input: unknown): string {
  return typeof input === "string" ? input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+/g, " ").trim() : "";
}

export function validateQuestion(input: unknown): { ok: true; text: string } | { ok: false; message: string } {
  const text = cleanQuestionText(input);
  if (text.length < QUESTION_MIN) return { ok: false, message: `Please write at least ${QUESTION_MIN} characters.` };
  if (text.length > QUESTION_MAX) return { ok: false, message: `Questions can be at most ${QUESTION_MAX} characters.` };
  return { ok: true, text };
}
