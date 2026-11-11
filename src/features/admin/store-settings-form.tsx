/* eslint-disable react-hooks/incompatible-library */
"use client";

import { TagInput } from "@/components/ui/tag-input";
import { themeFormDefaults } from "@/lib/theme";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { storeSettingsFormSchema } from "@/lib/validations/admin";
import { saveStoreSettingsAction } from "@/server/actions/admin-settings.actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import {
  SingleImageUploader,
  type ImageValue,
} from "@/features/admin/single-image-uploader";
import type { StoreSettings } from "@prisma/client";
import type { z } from "zod";

// Form Submit হওয়ার পর Output Type
export type StoreSettingsFormValues = z.infer<typeof storeSettingsFormSchema>;

export function StoreSettingsForm({ settings }: { settings: StoreSettings }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [tab, setTab] = useState<"general" | "ecommerce" | "tracking" | "seo">("general");

  const form = useForm({
    resolver: zodResolver(storeSettingsFormSchema),
    defaultValues: {
      storeName: settings.storeName ?? "",
      storeEmail: settings.storeEmail ?? "",
      storePhone: settings.storePhone ?? "",
      storeAddress: settings.storeAddress ?? "",
      logoUrl: settings.logoUrl ?? "",
      logoCloudinaryPublicId: settings.logoCloudinaryPublicId ?? null,
      faviconUrl: settings.faviconUrl ?? "",
      faviconCloudinaryPublicId: settings.faviconCloudinaryPublicId ?? null,
      // Legacy stored defaults are shown as the new brand palette (see lib/theme.ts).
      ...themeFormDefaults(settings),
      currencyCode: settings.currencyCode ?? "BDT",
      currencySymbol: settings.currencySymbol ?? "৳",
      instagramUrl: settings.instagramUrl ?? "",
      facebookUrl: settings.facebookUrl ?? "",
      whatsappUrl: settings.whatsappUrl ?? "",
      tiktokUrl: settings.tiktokUrl ?? "",
      deliveryChargeDhaka: Number(settings.deliveryChargeDhaka ?? 60),
      deliveryChargeOutsideDhaka: Number(
        settings.deliveryChargeOutsideDhaka ?? 120,
      ),
      deliveryChargeOther: Number(settings.deliveryChargeOther ?? 150),
      shippingFlatRate: Number(settings.shippingFlatRate ?? 0),
      freeShippingThreshold: settings.freeShippingThreshold
        ? Number(settings.freeShippingThreshold)
        : undefined,
      taxRatePercent: Number(settings.taxRatePercent ?? 0),
      gtmId: settings.gtmId ?? "",
            metaPixelId: settings.metaPixelId ?? "",
      tiktokPixelId: settings.tiktokPixelId ?? "",
      linkedinPartnerId: settings.linkedinPartnerId ?? "",
      consentMode: settings.consentMode ?? "OFF",
      seoTitleTemplate: settings.seoTitleTemplate ?? "",
      seoDescription: settings.seoDescription ?? "",
      seoKeywords: settings.seoKeywords ?? [],
      ogImageUrl: settings.ogImageUrl ?? "",
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const result = await saveStoreSettingsAction(values);

      if (!result.success) {
        toast.error(result.message);
        return;
      }

      toast.success("Settings saved successfully");
      router.refresh();
    });
  });

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="container-boutique bg-white py-8 space-y-8">
        <div role="tablist" aria-label="Settings sections" className="flex flex-wrap gap-2 border-b border-border pb-3">
          {([["general", "General"], ["ecommerce", "Ecommerce"], ["tracking", "Tracking & Analytics"], ["seo", "Site & SEO"]] as const).map(([id, text]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-full border px-4 py-1.5 text-sm ${tab === id ? "border-primary bg-primary text-primary-foreground" : "border-border hover:border-foreground"}`}
            >
              {text}
            </button>
          ))}
        </div>

        <section className="space-y-4" hidden={tab !== "general"}>

          {/* Connected SingleImageUploader directly into react-hook-form */}
          <FormField
            control={form.control}
            name="logoUrl"
            render={({ field }) => {
              const currentPublicId = form.watch("logoCloudinaryPublicId");
              const imageValue: ImageValue | null = field.value
                ? { url: field.value, publicId: currentPublicId ?? null }
                : null;

              return (
                <FormItem>
                  <FormControl>
                    <SingleImageUploader
                      value={imageValue}
                      onChange={(img) => {
                        form.setValue("logoUrl", img?.url ?? "", {
                          shouldValidate: true,
                          shouldDirty: true,
                        });
                        form.setValue(
                          "logoCloudinaryPublicId",
                          img?.publicId ?? null,
                          { shouldValidate: true, shouldDirty: true },
                        );
                      }}
                      folder="branding"
                      label="Store logo"
                      aspectClassName="aspect-square max-w-[160px]"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          <div className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="faviconUrl"
              render={({ field }) => {
                const currentPublicId = form.watch("faviconCloudinaryPublicId");
                const imageValue: ImageValue | null = field.value
                  ? { url: field.value, publicId: currentPublicId ?? null }
                  : null;

                return (
                  <FormItem>
                    <FormControl>
                      <SingleImageUploader
                        value={imageValue}
                        onChange={(img) => {
                          form.setValue("faviconUrl", img?.url ?? "", {
                            shouldValidate: true,
                            shouldDirty: true,
                          });
                          form.setValue(
                            "faviconCloudinaryPublicId",
                            img?.publicId ?? null,
                            { shouldValidate: true, shouldDirty: true },
                          );
                        }}
                        folder="branding"
                        label="Favicon"
                        aspectClassName="aspect-square max-w-[80px]"
                      />
                    </FormControl>
                    <FormDescription>Square image, at least 64×64px.</FormDescription>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />
            <FormField
              control={form.control}
              name="primaryColor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Primary color</FormLabel>
                  <FormControl>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        value={field.value}
                        onChange={field.onChange}
                        className="h-10 w-14 cursor-pointer rounded border border-input bg-transparent p-1"
                      />
                      <Input {...field} className="max-w-[140px]" />
                    </div>
                  </FormControl>
                  <FormDescription>Buttons, links, and accents across the site.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="secondaryColor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Secondary color</FormLabel>
                  <FormControl>
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        value={field.value}
                        onChange={field.onChange}
                        className="h-10 w-14 cursor-pointer rounded border border-input bg-transparent p-1"
                      />
                      <Input {...field} className="max-w-[140px]" />
                    </div>
                  </FormControl>
                  <FormDescription>Secondary surfaces and muted backgrounds.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="storeName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Store name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="storeEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Store email</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="storePhone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Store phone</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="storeAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Store address</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="space-y-4" hidden={tab !== "general"}>
          <h2 className="font-heading text-lg font-semibold">Social links</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="facebookUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Facebook page URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://facebook.com/…" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="instagramUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Instagram URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://instagram.com/…" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="whatsappUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>WhatsApp link</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://wa.me/8801XXXXXXXXX"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Used for the WhatsApp contact button where shown.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="tiktokUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>TikTok URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://tiktok.com/@…" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="space-y-4" hidden={tab !== "ecommerce"}>
          <h2 className="font-heading text-lg font-semibold">
            Delivery charges
          </h2>
          <p className="text-sm text-muted-foreground">
            These are the flat delivery charges shown at checkout for each zone.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="deliveryChargeDhaka"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Dhaka City (৳)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="1"
                      {...field}
                      value={field.value as string | number | undefined}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="deliveryChargeOutsideDhaka"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Outside Dhaka City (৳)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="1"
                      {...field}
                      value={field.value as string | number | undefined}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="deliveryChargeOther"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Other areas (৳)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="1"
                      {...field}
                      value={field.value as string | number | undefined}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="space-y-4" hidden={tab !== "ecommerce"}>
          <h2 className="font-heading text-lg font-semibold">
            Currency &amp; other charges
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="currencyCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency code</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="currencySymbol"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Currency symbol</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="freeShippingThreshold"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Free delivery threshold (optional)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      {...field}
                      value={field.value as string | number | undefined}
                    />
                  </FormControl>
                  <FormDescription>
                    If the order subtotal reaches this amount, delivery is free.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="taxRatePercent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tax rate (%)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      {...field}
                      value={field.value as string | number | undefined}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </section>

        <section className="space-y-4" hidden={tab !== "tracking"}>
          <h2 className="font-heading text-lg font-semibold">Tracking &amp; Analytics</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="gtmId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Google Analytics / Tag Manager ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="G-XXXXXXXXXX or GTM-XXXXXXX"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="metaPixelId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Meta Pixel ID</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          
            <FormField control={form.control} name="tiktokPixelId" render={({ field }) => (
              <FormItem>
                <FormLabel>TikTok Pixel ID (optional)</FormLabel>
                <FormControl><Input placeholder="e.g. C1A2B3C4D5E6F7G8H9I0" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="linkedinPartnerId" render={({ field }) => (
              <FormItem>
                <FormLabel>LinkedIn Partner ID (optional)</FormLabel>
                <FormControl><Input inputMode="numeric" placeholder="e.g. 1234567" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="consentMode" render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>Visitor consent</FormLabel>
                <FormControl>
                  <select {...field} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                    <option value="OFF">Off — trackers load for every visitor (current behaviour)</option>
                    <option value="OPT_IN">Opt-in — nothing loads until the visitor accepts a cookie notice</option>
                  </select>
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  Use opt-in if you have visitors from regions that require consent. With opt-in, server-side purchase events are also paused.
                  Use either a GTM container (with your GA4 tag inside it) <em>or</em> a GA4 ID here — not both, or visits are counted twice. Only public IDs go here; API tokens belong in server environment variables.
                </p>
                <FormMessage />
              </FormItem>
            )} />
          </div>
        </section>

        <section className="space-y-4" hidden={tab !== "seo"}>
          <h2 className="font-heading text-lg font-semibold">Site &amp; SEO</h2>
          <div className="grid gap-4">
            <FormField control={form.control} name="seoTitleTemplate" render={({ field }) => (
              <FormItem>
                <FormLabel>Page title template</FormLabel>
                <FormControl><Input placeholder="%s · Gift Pacific" {...field} /></FormControl>
                <p className="text-xs text-muted-foreground">%s is replaced by the page&apos;s own title. Leave empty for the default.</p>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="seoDescription" render={({ field }) => (
              <FormItem>
                <FormLabel>Default description (search results &amp; link previews)</FormLabel>
                <FormControl><Textarea rows={3} maxLength={300} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="seoKeywords" render={({ field }) => (
              <FormItem>
                <FormLabel>Default keywords</FormLabel>
                <FormControl><TagInput label="Default SEO keywords" value={field.value ?? []} onChange={field.onChange} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="ogImageUrl" render={({ field }) => (
              <FormItem>
                <FormLabel>Default share image link (https)</FormLabel>
                <FormControl><Input placeholder="https://…" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>
        </section>

        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving…" : "Save settings"}
        </Button>
      </form>
    </Form>
  );
}
