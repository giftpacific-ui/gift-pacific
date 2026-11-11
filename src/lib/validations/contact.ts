import { z } from "zod";

export const contactFormSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  email: z.email("Enter a valid email address").trim(),
  phone: z.string().trim().max(20).optional().or(z.literal("")),
  subject: z.string().trim().min(2, "Please add a subject").max(150),
  message: z.string().trim().min(10, "Message must be at least 10 characters").max(2000),
});
export type ContactFormInput = z.infer<typeof contactFormSchema>;
