import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, Phone, User, Calendar } from "lucide-react";
import {
  adminGetContactMessage,
  adminMarkContactMessageRead,
} from "@/server/services/admin-contact.service";
import { ContactMessageControls } from "@/features/admin/contact-message-controls";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Message Details · Admin Dashboard",
};

export default async function AdminContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const message = await adminGetContactMessage(id);
  if (!message) notFound();

  // Opening a message from the inbox is the natural "read" signal.
  if (!message.isRead) {
    await adminMarkContactMessageRead(id, true);
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 pb-12">
      {/* Back Button */}
      <Link
        href="/admin/contacts"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors bg-white px-4 py-2 rounded-full border border-border/60 shadow-xs w-fit"
      >
        <ArrowLeft className="size-4" />
        Back to messages
      </Link>

      {/* Main Message Card */}
      <div className="rounded-3xl border border-border/60 bg-white p-6 sm:p-8 shadow-xs space-y-6 text-foreground">
        {/* Header Section */}
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-6">
          <div className="space-y-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Inquiry Subject
            </span>
            <h1 className="font-heading text-2xl font-bold text-foreground">
              {message.subject}
            </h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-1">
              <Calendar className="size-3.5 text-primary" /> Received on{" "}
              {formatDate(message.createdAt)}
            </p>
          </div>
          <ContactMessageControls id={message.id} isRead={true} />
        </div>

        {/* Sender Contact Info Box */}
        <div className="grid gap-3 sm:grid-cols-2 bg-neutral-50/60 p-4 sm:p-5 rounded-2xl border border-border/50 text-sm">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Sender Details
            </p>
            <p className="font-bold text-foreground flex items-center gap-2">
              <User className="size-4 text-primary" /> {message.name}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Contact Info
            </p>
            <div className="space-y-0.5">
              <p className="flex items-center gap-2">
                <Mail className="size-3.5 text-primary shrink-0" />
                <Link
                  href={`mailto:${message.email}`}
                  className="text-primary hover:underline font-medium truncate"
                >
                  {message.email}
                </Link>
              </p>
              {message.phone && (
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Phone className="size-3.5 text-primary shrink-0" />{" "}
                  {message.phone}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Message Body Content */}
        <div className="space-y-2 pt-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Message Content
          </h2>
          <div className="bg-secondary/30 p-6 rounded-2xl border border-border/45 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
            {message.message}
          </div>
        </div>
      </div>
    </div>
  );
}
