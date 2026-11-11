import "server-only";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/current-user";
import { UserFacingError } from "@/lib/errors";
import { shortReviewerName } from "@/lib/product-dto";
import { ANSWER_MAX, MAX_PENDING_PER_PRODUCT, validateQuestion } from "@/lib/question-rules";
import { notifyUser } from "@/server/services/notification.service";

export type PublicQuestion = {
  id: string;
  question: string;
  answer: string | null;
  answeredAt: Date | null;
  createdAt: Date;
  /** "Jamie R." — never a full name or email. */
  askedBy: string;
};

/** Approved questions only (and their store answers). Anything pending or hidden is never returned. */
export async function getApprovedQuestions(productId: string, limit = 20): Promise<PublicQuestion[]> {
  const rows = await prisma.productQuestion.findMany({
    where: { productId, status: "APPROVED", product: { status: "ACTIVE" } },
    orderBy: [{ answeredAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
    take: Math.min(Math.max(limit, 1), 50),
    select: { id: true, question: true, answer: true, answeredAt: true, createdAt: true, user: { select: { name: true } } },
  });
  return rows.map((r) => ({ id: r.id, question: r.question, answer: r.answer, answeredAt: r.answeredAt, createdAt: r.createdAt, askedBy: shortReviewerName(r.user.name) }));
}

/** A signed-in customer asks a question. It stays private until the store approves it (answering approves it). */
export async function submitQuestion(productId: string, text: unknown): Promise<void> {
  const session = await getSession();
  if (!session) throw new UserFacingError("Please sign in to ask a question.");
  const valid = validateQuestion(text);
  if (!valid.ok) throw new UserFacingError(valid.message);
  if (typeof productId !== "string" || !productId) throw new UserFacingError("This product is not available.");
  const product = await prisma.product.findFirst({ where: { id: productId, status: "ACTIVE" }, select: { id: true } });
  if (!product) throw new UserFacingError("This product is not available.");
  // Count-then-create alone lets concurrent requests all pass the check. A transaction-scoped advisory lock keyed on
  // (customer, product) makes the check and the insert one serialized step; it is released automatically at commit.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`question:${session.sub}:${productId}`}))`;
    const pending = await tx.productQuestion.count({ where: { userId: session.sub, productId, status: "PENDING" } });
    if (pending >= MAX_PENDING_PER_PRODUCT) {
      throw new UserFacingError("You already have questions waiting for an answer on this product. Please wait for the store to reply.");
    }
    // The customer id comes from the session, never from the request.
    await tx.productQuestion.create({ data: { productId, userId: session.sub, question: valid.text } });
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type QuestionFilter = "unanswered" | "pending" | "approved" | "hidden";

export async function adminListQuestions(filter: QuestionFilter, page = 1, pageSize = 20) {
  const where =
    filter === "unanswered" ? { answer: null, status: { not: "HIDDEN" as const } }
    : filter === "pending" ? { status: "PENDING" as const }
    : filter === "approved" ? { status: "APPROVED" as const }
    : { status: "HIDDEN" as const };
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const [rows, total] = await Promise.all([
    prisma.productQuestion.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (safePage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, question: true, answer: true, status: true, createdAt: true, answeredAt: true,
        product: { select: { name: true, slug: true } },
        user: { select: { name: true, email: true } },
      },
    }),
    prisma.productQuestion.count({ where }),
  ]);
  return { items: rows, total, page: safePage, pageCount: Math.ceil(total / pageSize) };
}

export async function adminCountUnansweredQuestions(): Promise<number> {
  return prisma.productQuestion.count({ where: { answer: null, status: { not: "HIDDEN" } } });
}

/** Saves the store's answer, publishes the question (answering approves it) and tells the customer. */
export async function adminAnswerQuestion(id: string, answer: string, adminId: string): Promise<void> {
  const text = typeof answer === "string" ? answer.replace(/\s+\n/g, "\n").trim() : "";
  if (text.length < 2) throw new UserFacingError("Please write an answer.");
  if (text.length > ANSWER_MAX) throw new UserFacingError(`Answers can be at most ${ANSWER_MAX} characters.`);
  await prisma.$transaction(async (tx) => {
    const q = await tx.productQuestion.findUnique({ where: { id }, select: { id: true, userId: true, product: { select: { name: true, slug: true } } } });
    if (!q) throw new UserFacingError("Question not found.");
    await tx.productQuestion.update({ where: { id }, data: { answer: text, answeredAt: new Date(), answeredById: adminId, status: "APPROVED" } });
    await notifyUser(tx, {
      userId: q.userId,
      type: "QUESTION",
      title: "Your question was answered",
      body: `The store replied to your question about ${q.product.name}.`,
      href: `/products/${q.product.slug}#questions`,
      dedupeKey: `question:${id}:answered`,
    });
  });
}

export async function adminSetQuestionStatus(id: string, status: "APPROVED" | "HIDDEN"): Promise<void> {
  if (status !== "APPROVED" && status !== "HIDDEN") throw new UserFacingError("Invalid status.");
  const result = await prisma.productQuestion.updateMany({ where: { id }, data: { status } });
  if (result.count !== 1) throw new UserFacingError("Question not found.");
}

export async function adminDeleteQuestion(id: string): Promise<void> {
  const result = await prisma.productQuestion.deleteMany({ where: { id } });
  if (result.count !== 1) throw new UserFacingError("Question not found.");
}
