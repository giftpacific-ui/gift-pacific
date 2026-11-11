import type { Metadata } from "next";
import { pageMetadata } from "@/server/services/seo.service";
import {
  Mail,
  Phone,
  MapPin,
  Sparkles,
  MessageSquare,
  Clock,
} from "lucide-react";
import { ContactForm } from "@/features/contact/contact-form";
import { getStoreSettings } from "@/server/services/admin-settings.service";
import { siteConfig } from "@/config/site";

export async function generateMetadata(): Promise<Metadata> {
  return pageMetadata({ title: "Contact us", description: `Questions about an order or a custom gift? Get in touch with ${siteConfig.name}.`, path: "/contact" });
}

export default async function ContactPage() {
  const settings = await getStoreSettings();

  return (
    <div className="container-boutique py-16 px-4 sm:px-6 space-y-12">
      {/* Header Section */}
      <div className="mx-auto max-w-2xl text-center space-y-3">
        <span className="inline-flex items-center gap-1.5 px-3.5 py-1 rounded-full bg-primary/10 text-foreground font-semibold text-xs tracking-wider uppercase">
          <Sparkles className="size-3.5" /> Get in Touch
        </span>
        <h1 className="font-heading text-[clamp(2.2rem,4.5vw,3.4rem)] leading-tight font-semibold text-foreground">
          We&apos;d love to hear from you
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Questions about an order, a custom handmade piece, or anything else —
          drop us a message and we&apos;ll get back to you soon.
        </p>
      </div>

      {/* Main Grid Layout */}
      <div className="grid gap-8 lg:grid-cols-5 items-start">
        {/* Contact Info & Details Sidebar */}
        <div className="space-y-6 lg:col-span-2">
          <div className="bg-card border border-border rounded-[4px] p-6 sm:p-8 shadow-xs space-y-6 text-foreground">
            <h2 className="font-heading text-lg font-bold flex items-center gap-2">
              <MessageSquare className="size-5 text-primary" /> Contact Info
            </h2>

            <div className="space-y-5 text-sm">
              {settings.storeEmail && (
                <div className="flex items-start gap-3.5">
                  <div className="size-10 rounded-[4px] bg-neutral-100 border border-border/50 text-primary flex items-center justify-center shrink-0">
                    <Mail className="size-4" />
                  </div>
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Email Address
                    </p>
                    <p className="font-medium text-foreground truncate">
                      {settings.storeEmail}
                    </p>
                  </div>
                </div>
              )}

              {settings.storePhone && (
                <div className="flex items-start gap-3.5">
                  <div className="size-10 rounded-[4px] bg-neutral-100 border border-border/50 text-primary flex items-center justify-center shrink-0">
                    <Phone className="size-4" />
                  </div>
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Phone Number
                    </p>
                    <p className="font-medium text-foreground">
                      {settings.storePhone}
                    </p>
                  </div>
                </div>
              )}

              {settings.storeAddress && (
                <div className="flex items-start gap-3.5">
                  <div className="size-10 rounded-[4px] bg-neutral-100 border border-border/50 text-primary flex items-center justify-center shrink-0">
                    <MapPin className="size-4" />
                  </div>
                  <div className="space-y-0.5 min-w-0">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Office Location
                    </p>
                    <p className="font-medium text-foreground leading-relaxed">
                      {settings.storeAddress}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Response Time Badge */}
            <div className="pt-4 border-t flex items-center gap-3 text-xs text-muted-foreground bg-neutral-50/60 p-4 rounded-[4px] border border-border/50">
              <Clock className="size-4 text-primary shrink-0" />
              <span>We usually reply within 24 hours during working days.</span>
            </div>
          </div>
        </div>

        {/* Contact Form Container */}
        <div className="bg-card border border-border rounded-[4px] p-6 sm:p-8 shadow-xs lg:col-span-3">
          <ContactForm />
        </div>
      </div>
    </div>
  );
}
