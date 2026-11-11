import "server-only";
import { prisma } from "@/lib/db/prisma";
import type { ContactFormInput } from "@/lib/validations/contact";

export async function createContactMessage(input: ContactFormInput) {
  return prisma.contactMessage.create({
    data: {
      name: input.name,
      email: input.email,
      phone: input.phone || null,
      subject: input.subject,
      message: input.message,
    },
  });
}
