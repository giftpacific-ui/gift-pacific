"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Sparkles, Clock } from "lucide-react";

export interface ActiveCampaign {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  endsAt: Date | string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  updatedAt?: Date | string;
}

interface ActiveCampaignSectionProps {
  campaign: ActiveCampaign;
}

export function ActiveCampaignSection({
  campaign,
}: ActiveCampaignSectionProps) {
  const [timeLeft, setTimeLeft] = useState<{
    days: number;
    hours: number;
    minutes: number;
    seconds: number;
  } | null>(null);

  useEffect(() => {
    if (!campaign.endsAt) return;

    const targetDate = new Date(campaign.endsAt).getTime();

    const updateTimer = () => {
      const now = Date.now();
      const distance = targetDate - now;

      if (distance <= 0) {
        setTimeLeft(null);
        return;
      }

      setTimeLeft({
        days: Math.floor(distance / (1000 * 60 * 60 * 24)),
        hours: Math.floor((distance / (1000 * 60 * 60)) % 24),
        minutes: Math.floor((distance / 1000 / 60) % 60),
        seconds: Math.floor((distance / 1000) % 60),
      });
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [campaign.endsAt]);

  return (
    <section className="container-boutique my-10 md:my-14">
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-secondary/70 shadow-sm">
        <div className="grid grid-cols-1 items-center lg:grid-cols-12">
          {/* বাম পাশ: ক্যাম্পেইন ইনফো */}
          <div className="flex flex-col justify-center p-6 sm:p-10 lg:col-span-6 lg:p-12">
            <div className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-3.5 py-1 text-xs font-medium tracking-wide text-primary uppercase">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Live Campaign</span>
            </div>

            <h2 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {campaign.name}
            </h2>

            {campaign.description && (
              <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground sm:text-base">
                {campaign.description}
              </p>
            )}

            {/* লাইভ কাউন্টডাউন টাইমার (endsAt থেকে অটো ক্যালকুলেট হবে) */}
            {timeLeft && (
              <div className="mt-6">
                <p className="mb-2.5 flex items-center gap-1.5 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                  <Clock className="h-3.5 w-3.5" />
                  Offer ends in
                </p>
                <div className="flex items-center gap-2.5 sm:gap-3">
                  {[
                    { label: "Days", value: timeLeft.days },
                    { label: "Hours", value: timeLeft.hours },
                    { label: "Mins", value: timeLeft.minutes },
                    { label: "Secs", value: timeLeft.seconds },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="flex min-w-[58px] flex-col items-center rounded-xl border border-border/80 bg-background px-3 py-2 shadow-2xs"
                    >
                      <span className="font-heading text-lg font-bold text-foreground sm:text-xl">
                        {String(item.value).padStart(2, "0")}
                      </span>
                      <span className="text-[10px] font-medium text-muted-foreground uppercase">
                        {item.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-7">
              <Link
                href={`/campaign`}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
              >
                <span>Shop {campaign.name} Deals</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>

          {/* ডান পাশ: ব্যানার ইমেজ (আপনার ইমেজের রেশিও 1983x793 অনুযায়ী অ্যাডজাস্ট করা) */}
          {campaign.image && (
            <div className="relative aspect-[16/9] w-full bg-muted lg:col-span-6 lg:aspect-auto lg:h-full lg:min-h-[360px]">
              <Image
                src={campaign.image}
                alt={campaign.name}
                fill
                className="object-cover"
                sizes="(max-width: 1024px) 100vw, 50vw"
                priority
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
