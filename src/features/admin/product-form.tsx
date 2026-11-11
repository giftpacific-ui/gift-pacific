/* eslint-disable react-hooks/incompatible-library */
"use client";

import { TagInput } from "@/components/ui/tag-input";
import { useEffect, useState, useTransition, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import slugify from "slugify";
import { productFormSchema } from "@/lib/validations/admin";
import { saveProductAction } from "@/server/actions/admin-product.actions";
import { useEditorGoBack, useEditorNavigate, useReportDirty } from "@/features/admin/product-editor-dirty";
import { RichTextEditor } from "@/features/admin/rich-text-editor";
import { SeoCounter, SeoPreview } from "@/features/admin/seo-preview";
import { SingleImageUploader } from "@/features/admin/single-image-uploader";
import { Textarea } from "@/components/ui/textarea";
import { firstText, siteOrigin } from "@/lib/seo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  Package,
  Banknote,
  Layers,
  BarChart3,
  Globe,
  Sparkles,
  Video,
  Loader2,
} from "lucide-react";
import type { Product } from "@prisma/client";

type DraftVariant = {
  id: string;
  name: string;
  sku: string;
  price: string;
  stock: string;
  optionsJson: string;
};

const BADGES = [
  "NEW",
  "BEST_SELLER",
  "LIMITED_EDITION",
  "HANDMADE",
  "PERSONALIZED",
  "SALE",
] as const;

type TabKey = "basic" | "pricing" | "inventory" | "type" | "advanced" | "seo";
/** Display order of every editor tab. "variants" and "media" are rendered by the parent (they own forms that cannot nest here). */
const TAB_ORDER = ["basic", "pricing", "inventory", "type", "variants", "media", "seo", "advanced"] as const;
/** The form panels that belong to each tab (used for aria-controls). */
const PANEL_IDS: Record<string, string[]> = {
  basic: ["tab-panel-basic1", "tab-panel-basic7"],
  pricing: ["tab-panel-pricing2"],
  inventory: ["tab-panel-inventory3", "tab-panel-inventory-extra"],
  type: ["tab-panel-type4"],
  advanced: ["tab-panel-advanced5"],
  seo: ["tab-panel-seo6"],
  variants: ["tab-panel-variants", "tab-panel-variants-draft"],
  media: ["tab-panel-media"],
};
const TABS: { key: TabKey; label: string; fields: string[] }[] = [
  {
    key: "basic",
    label: "Basic information",
    fields: ["name", "slug", "sku", "shortDescription", "description"],
  },
  {
    key: "pricing",
    label: "Pricing",
    fields: ["price", "compareAtPrice", "costPrice"],
  },
  {
    key: "inventory",
    label: "Inventory",
    fields: [
      "stock",
      "lowStockThreshold",
      "trackInventory",
      "allowBackorder",
      "procurementLimit",
      "backorderNote",
      "weightGrams",
    ],
  },
  {
    key: "type",
    label: "Type & category",
    fields: [
      "categoryId",
      "brand",
      "kind",
      "type",
      "status",
      "comboMode",
      "comboPricing",
      "comboStockPolicy",
    ],
  },
  {
    key: "advanced",
    label: "Advanced",
    fields: ["badges", "isFeatured", "videoUrl"],
  },
  {
    key: "seo",
    label: "SEO",
    fields: ["metaTitle", "metaDescription", "metaKeywords"],
  },
];
const tabOfField = (name: string): TabKey =>
  TABS.find((t) => t.fields.includes(name))?.key ?? "basic";

export function ProductForm({
  product,
  categories,
  onTypeChange,
  extraTabs,
  activeTab,
  onTabChange,
  createExtras,
  galleryImages,
}: {
  product?: Product;
  categories: { id: string; name: string; depth: number }[];
  onTypeChange?: (
    type: Product["type"],
    comboMode: Product["comboMode"],
  ) => void;
  /** Extra tabs whose PANELS are rendered by the parent (they contain their own forms, which cannot nest inside this one). */
  extraTabs?: { key: string; label: string }[];
  /** Controlled tab key. When omitted the form keeps its own tab state (create page). */
  activeTab?: string;
  onTabChange?: (key: string) => void;
  /** Create flow only: saves the nested drafts (attributes, media) once the product exists. */
  /** Images of the product (saved gallery, or the drafts in the create flow) offered as the share image. */
  galleryImages?: { url: string }[];
  createExtras?: { persist: (productId: string) => Promise<{ ok: true } | { ok: false; message: string }> };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const form = useForm({
    resolver: zodResolver(productFormSchema),
    defaultValues: {
      name: product?.name ?? "",
      slug: product?.slug ?? "",
      shortDescription: product?.shortDescription ?? "",
      description: product?.description ?? "",
      sku: product?.sku ?? "",
      brand: product?.brand ?? "",
      type: product?.type ?? "STANDARD",
      kind: product?.kind ?? "SINGLE",
      comboMode: product?.comboMode ?? "",
      comboPricing: product?.comboPricing ?? "",
      comboStockPolicy: product?.comboStockPolicy ?? "",
      status: product?.status ?? "DRAFT",
      badges: product?.badges ?? [],
      categoryId: product?.categoryId ?? "",
      price: product ? Number(product.price) : 0,
      compareAtPrice: product?.compareAtPrice
        ? Number(product.compareAtPrice)
        : "",
      costPrice: product?.costPrice ? Number(product.costPrice) : "",
      stock: product?.stock ?? 0,
      loadedStock: product?.stock,
      lowStockThreshold: product?.lowStockThreshold ?? 5,
      allowBackorder: product?.allowBackorder ?? false,
      procurementLimit: product?.procurementLimit ?? "",
      backorderNote: product?.backorderNote ?? "",
      trackInventory: product?.trackInventory ?? true,
      isFeatured: product?.isFeatured ?? false,
      videoUrl: product?.videoUrl ?? "",
      weightGrams: product?.weightGrams ?? "",
      metaTitle: product?.metaTitle ?? "",
      metaDescription: product?.metaDescription ?? "",
      metaKeywords: product?.metaKeywords ?? [],
      seoImage: product?.seoImage ?? "",
      seoNoIndex: product?.seoNoIndex ?? false,
    },
  });

  const watchedPrice = Number(form.watch("price")) || 0;
  const watchedStock = Number(form.watch("stock")) || 0;
  const watchedType = form.watch("type");
  const [wName, wSlug, wMetaTitle, wMetaDescription, wShort, wDescription, wSeoImage, wNoIndex] = form.watch([
    "name", "slug", "metaTitle", "metaDescription", "shortDescription", "description", "seoImage", "seoNoIndex",
  ]);
  const watchedKind = form.watch("kind");
  const watchedComboMode = form.watch("comboMode");
  useEffect(() => {
    onTypeChange?.(
      watchedType,
      watchedComboMode === "FIXED" || watchedComboMode === "CUSTOMIZABLE"
        ? watchedComboMode
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedType, watchedComboMode]);

  /** Keeps type/combo columns consistent: a COMBO is always the combo shape, a SINGLE never is. */
  function chooseKind(kind: "SINGLE" | "COMBO") {
    form.setValue("kind", kind, { shouldDirty: true });
    if (kind === "COMBO") {
      form.setValue("type", "BUNDLE", { shouldDirty: true });
      if (!form.getValues("comboMode")) {
        form.setValue("comboMode", "FIXED", { shouldDirty: true });
        form.setValue("comboPricing", "FIXED_PRICE", { shouldDirty: true });
        form.setValue("comboStockPolicy", "OWN_STOCK", { shouldDirty: true });
      }
    } else {
      if (form.getValues("type") === "BUNDLE")
        form.setValue("type", "STANDARD", { shouldDirty: true });
      form.setValue("comboMode", "", { shouldDirty: true });
      form.setValue("comboPricing", "", { shouldDirty: true });
      form.setValue("comboStockPolicy", "", { shouldDirty: true });
    }
  }
  function chooseComboMode(mode: "FIXED" | "CUSTOMIZABLE") {
    form.setValue("comboMode", mode, { shouldDirty: true });
    // A customizable combo is assembled from components, so it can only use component stock.
    if (mode === "CUSTOMIZABLE")
      form.setValue("comboStockPolicy", "COMPONENTS", { shouldDirty: true });
  }
  const watchedCompareAtPrice = Number(form.watch("compareAtPrice")) || 0;
  const discountPercent =
    watchedCompareAtPrice > watchedPrice && watchedPrice > 0
      ? Math.round(
          ((watchedCompareAtPrice - watchedPrice) / watchedCompareAtPrice) *
            100,
        )
      : null;

  // Draft variants, only used on the CREATE flow (no product yet, so no
  // real productId FK to attach real ProductVariant rows to). Selecting
  // "Has Variations" shows this editor immediately — pure client state,
  // no save/reload/redirect — and the rows are sent along with the rest
  // of the form on submit, created in the same action right after the
  // product itself. On the EDIT flow this section is not shown; the
  // dedicated ProductVariantsManager (with the real DB-backed variants)
  // is used instead, further down the edit page.
  const [draftVariants, setDraftVariants] = useState<DraftVariant[]>([]);
  const [ownTab, setOwnTab] = useState<string>("basic");
  const tab = activeTab ?? ownTab;
  const setTab = (k: string) => {
    setOwnTab(k);
    onTabChange?.(k);
  };
  const tabLabels: Record<string, string> = {
    ...Object.fromEntries(TABS.map((t) => [t.key, t.label])),
    ...Object.fromEntries((extraTabs ?? []).map((t) => [t.key, t.label])),
  };
  const visibleTabs = TAB_ORDER.filter((k) => k in tabLabels);
  function onTabKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const last = visibleTabs.length - 1;
    const next =
      e.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    const key = visibleTabs[next];
    setTab(key);
    document.getElementById(`tab-${key}`)?.focus();
  }

  function addDraftVariant() {
    setDraftVariants((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: "",
        sku: "",
        price: String(watchedPrice || 0),
        stock: String(watchedStock || 0),
        optionsJson: '{"Color":""}',
      },
    ]);
  }

  function updateDraftVariant(id: string, patch: Partial<DraftVariant>) {
    setDraftVariants((current) =>
      current.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    );
  }

  function removeDraftVariant(id: string) {
    setDraftVariants((current) => current.filter((v) => v.id !== id));
  }

  // Unsaved work is reported to the editor-wide registry, which owns the only leave-page guards.
  const dirty = form.formState.isDirty;
  useReportDirty("details", dirty);
  useReportDirty("draft-variants", !product && draftVariants.length > 0);
  const goBack = useEditorGoBack();
  const editorNavigate = useEditorNavigate();
  /** After the first save of a new product, further saves update that product instead of creating a duplicate. */
  const [createdId, setCreatedId] = useState<string | null>(null);
  const errorTabs = new Set(Object.keys(form.formState.errors).map(tabOfField));

  const onSubmit = form.handleSubmit(
    (values) => {
      startTransition(async () => {
        const existingId = product?.id ?? createdId;
        if (!existingId && draftVariants.length > 0 && values.type !== "VARIANT") {
          // Never drop entered variants silently.
          toast.error("You entered variants, but the product type is not “Has variations”. Remove them or switch the type back.");
          setTab("variants");
          return;
        }
        const variantsPayload =
          !existingId && values.type === "VARIANT"
            ? draftVariants
                .filter((v) => v.name.trim() && v.sku.trim())
                .map((v) => ({
                  name: v.name,
                  sku: v.sku,
                  price: Number(v.price) || 0,
                  stock: Number(v.stock) || 0,
                  optionsJson: v.optionsJson,
                  image: "",
                  allowBackorder: false,
                  isDefault: false,
                }))
            : undefined;
        if (!existingId && values.type === "VARIANT" && variantsPayload && variantsPayload.length < draftVariants.length) {
          toast.error("Every variant needs a name and a SKU.");
          setTab("variants");
          return;
        }
        const result = await saveProductAction(existingId, values, variantsPayload);
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        const id = existingId ?? result.id;
        if (!product && id) {
          setCreatedId(id);
          setDraftVariants([]);
          if (createExtras) {
            const extras = await createExtras.persist(id);
            if (!extras.ok) {
              form.reset(values);
              toast.error(`Product saved, but ${extras.message} Nothing you entered was discarded — fix it and save again.`);
              return;
            }
          }
          form.reset(values);
          toast.success("Product created. Variants, attributes and media are now saved.");
          editorNavigate(`/admin/products/${id}`, { replace: true });
          return;
        }
        // Saved values become the new baseline so "Unsaved changes" and the leave-page warning clear.
        form.reset(values);
        toast.success("Product saved successfully!");
        router.refresh();
      });
    },
    (errors) => {
      // Validation failed in a tab the admin is not looking at: jump to the first tab that has an error.
      const first = Object.keys(errors)[0];
      if (first) setTab(tabOfField(first));
      toast.error("Please fix the highlighted fields.");
    },
  );

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-8 pb-16  mx-auto">
        {/* Header Actions Bar */}
        <div className="flex items-center justify-between border border-border/60 p-4 sm:p-6 rounded-2xl shadow-xs sticky top-4 z-20 backdrop-blur-md bg-white/90">
          <div>
            <h2 className="text-xl font-heading font-semibold text-foreground">
              {product ? "Edit Product" : "Create New Product"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {product
                ? `Updating details for ${product.name}`
                : "Fill in the details to publish a new item to your store."}
            </p>
          </div>
          <Button
            type="submit"
            disabled={isPending}
            size="lg"
            className="rounded-full px-6 shadow-md font-medium"
          >
            {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            {isPending
              ? "Saving..."
              : product || createdId
                ? "Save Changes"
                : "Publish Product"}
          </Button>
        </div>

        {/* Tab navigation */}
        <div
          role="tablist"
          aria-label="Product sections"
          className="flex gap-2 overflow-x-auto rounded-2xl border border-border/60 bg-white p-2 sm:flex-wrap"
        >
          {visibleTabs.map((key, index) => (
            <button
              key={key}
              id={`tab-${key}`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={PANEL_IDS[key].join(" ")}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={`shrink-0 rounded-xl px-4 py-2 text-sm font-medium transition ${tab === key ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:bg-secondary"}`}
            >
              {tabLabels[key]}
              {errorTabs.has(key as TabKey) && (
                <span aria-label="has errors" className="ml-1.5 inline-block size-2 rounded-full bg-destructive align-middle" />
              )}
            </button>
          ))}
          {dirty && (
            <span role="status" className="ml-auto shrink-0 self-center px-2 text-xs text-muted-foreground">
              Unsaved changes
            </span>
          )}
        </div>

        {/* SECTION 1: General Information */}
        <div
          hidden={tab !== "basic"}
          id="tab-panel-basic1"
          role="tabpanel"
          aria-labelledby="tab-basic"
          className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div className="p-2.5 rounded-xl bg-primary/10 text-foreground">
              <Package className="size-5" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-medium text-foreground">
                General Information
              </h2>
              <p className="text-xs text-muted-foreground">
                Basic identity, titles, and descriptions for your product.
              </p>
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="font-medium text-foreground">
                    Product Name
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g., Handcrafted Ceramic Coffee Mug"
                      className="rounded-xl h-11"
                      {...field}
                      onChange={(e) => {
                        field.onChange(e);
                        if (!product) {
                          form.setValue(
                            "slug",
                            slugify(e.target.value, {
                              lower: true,
                              strict: true,
                            }),
                          );
                        }
                      }}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    URL Slug
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="handcrafted-ceramic-coffee-mug"
                      className="rounded-xl h-11 bg-neutral-50/50"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="sku"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    SKU (Stock Keeping Unit)
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="MUG-CER-01"
                      className="rounded-xl h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* SECTION 2: Pricing */}
        <div
          hidden={tab !== "pricing"}
          id="tab-panel-pricing2"
          role="tabpanel"
          aria-labelledby="tab-pricing"
          className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600">
              <Banknote className="size-5" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-medium text-foreground">
                Pricing & Margins
              </h2>
              <p className="text-xs text-muted-foreground">
                Manage your selling prices, discounts, and cost metrics.
              </p>
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="price"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Selling Price (৳)
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      className="rounded-xl h-11"
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
              name="compareAtPrice"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Compare-at Price (৳)
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      className="rounded-xl h-11"
                      {...field}
                      value={field.value as string | number | undefined}
                    />
                  </FormControl>
                  {discountPercent !== null && (
                    <FormDescription className="text-emerald-600 font-medium text-xs">
                      ✨ {discountPercent}% discount off original price
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="costPrice"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Cost Price (৳){" "}
                    <span className="text-xs text-muted-foreground font-normal">
                      (Internal)
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      className="rounded-xl h-11"
                      {...field}
                      value={field.value as string | number | undefined}
                    />
                  </FormControl>
                  <FormDescription className="text-[11px]">
                    Never shown to customers. Used for margin tracking.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* SECTION 3: Inventory & Fulfillment */}
        <div
          hidden={tab !== "inventory"}
          id="tab-panel-inventory3"
          role="tabpanel"
          aria-labelledby="tab-inventory"
          className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600">
              <BarChart3 className="size-5" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-medium text-foreground">
                Inventory & Fulfillment
              </h2>
              <p className="text-xs text-muted-foreground">
                Control stock levels, thresholds, and shipping weights.
              </p>
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="stock"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Stock Quantity
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      className="rounded-xl h-11"
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
              name="lowStockThreshold"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Low Stock Threshold
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      className="rounded-xl h-11"
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
              name="weightGrams"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Weight (grams)
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      className="rounded-xl h-11"
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
              name="videoUrl"
              render={({ field }) => (
                <FormItem className="sm:col-span-3">
                  <FormLabel className="font-medium text-foreground flex items-center gap-1.5">
                    <Video className="size-4 text-rose-500" /> Product Video URL
                    (Optional)
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="https://youtube.com/watch?v=…"
                      className="rounded-xl h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Toggles Checklist */}
          <div className="grid gap-4 sm:grid-cols-3 pt-4 border-t border-border/50">
            <div className="flex items-center space-x-3 p-4 rounded-2xl border border-border/60 bg-neutral-50/50 hover:bg-neutral-50 transition">
              <FormField
                control={form.control}
                name="trackInventory"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-3 space-y-0 w-full cursor-pointer">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="size-5 rounded-md"
                      />
                    </FormControl>
                    <div className="space-y-0.5 leading-none">
                      <FormLabel className="font-medium cursor-pointer">
                        Track inventory
                      </FormLabel>
                      <p className="text-[11px] text-muted-foreground">
                        Automatically reduce stock on sale
                      </p>
                    </div>
                  </FormItem>
                )}
              />
            </div>

            <div className="flex items-center space-x-3 p-4 rounded-2xl border border-border/60 bg-neutral-50/50 hover:bg-neutral-50 transition">
              <FormField
                control={form.control}
                name="allowBackorder"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-3 space-y-0 w-full cursor-pointer">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="size-5 rounded-md"
                      />
                    </FormControl>
                    <div className="space-y-0.5 leading-none">
                      <FormLabel className="font-medium cursor-pointer">
                        Allow backorder
                      </FormLabel>
                      <p className="text-[11px] text-muted-foreground">
                        Accept orders beyond physical stock. The extra units are
                        tracked as &ldquo;to source&rdquo; (Admin → Inventory) —
                        stock never goes negative.
                      </p>
                    </div>
                  </FormItem>
                )}
              />
            </div>

            {form.watch("allowBackorder") && (
              <div className="grid gap-4 sm:grid-cols-2 rounded-2xl border border-border/60 p-4">
                <FormField
                  control={form.control}
                  name="procurementLimit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-medium">
                        Max units waiting to be sourced
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          placeholder="No limit"
                          className="rounded-xl h-11"
                          {...field}
                          value={String(field.value ?? "")}
                        />
                      </FormControl>
                      <p className="text-[11px] text-muted-foreground">
                        Orders that would push the waiting total above this are
                        refused. Leave empty for no limit.
                        {product
                          ? ` Currently waiting: ${product.procurementPending}.`
                          : ""}
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="backorderNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-medium">
                        Customer note (optional)
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. Ships in 7–10 days"
                          maxLength={200}
                          className="rounded-xl h-11"
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <div className="flex items-center space-x-3 p-4 rounded-2xl border border-border/60 bg-neutral-50/50 hover:bg-neutral-50 transition">
              <FormField
                control={form.control}
                name="isFeatured"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-3 space-y-0 w-full cursor-pointer">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="size-5 rounded-md"
                      />
                    </FormControl>
                    <div className="space-y-0.5 leading-none">
                      <FormLabel className="font-medium cursor-pointer">
                        Featured item
                      </FormLabel>
                      <p className="text-[11px] text-muted-foreground">
                        Showcase prominently on homepage
                      </p>
                    </div>
                  </FormItem>
                )}
              />
            </div>
          </div>
        </div>

        {/* SECTION 4: Organization & Classification */}
        <div
          hidden={tab !== "type"}
          id="tab-panel-type4"
          role="tabpanel"
          aria-labelledby="tab-type"
          className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-600">
              <Layers className="size-5" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-medium text-foreground">
                Organization & Type
              </h2>
              <p className="text-xs text-muted-foreground">
                Categorize your product for easy navigation and filtering.
              </p>
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="categoryId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Category
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full rounded-xl h-11">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl">
                      {categories.map((c) => (
                        <SelectItem
                          key={c.id}
                          value={c.id}
                          className="cursor-pointer"
                        >
                          {"—".repeat(c.depth)}
                          {c.depth > 0 ? " " : ""}
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription className="text-[11px]">
                    Choose the most specific category level.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="brand"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Brand / Maker
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Artisanal Studio"
                      className="rounded-xl h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Product Type
                  </FormLabel>
                  <Select
                    onValueChange={(v) => chooseKind(v as "SINGLE" | "COMBO")}
                    value={field.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full rounded-xl h-11">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl">
                      <SelectItem value="SINGLE">Single product</SelectItem>
                      <SelectItem value="COMBO">
                        Combo (made of other products)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {watchedKind === "COMBO" && (
              <div className="sm:col-span-2 grid gap-4 rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-4 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="comboMode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Combo kind</FormLabel>
                      <Select
                        onValueChange={(v) =>
                          chooseComboMode(v as "FIXED" | "CUSTOMIZABLE")
                        }
                        value={field.value || "FIXED"}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full rounded-xl h-11">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="rounded-xl">
                          <SelectItem value="FIXED">
                            Fixed — predefined contents
                          </SelectItem>
                          <SelectItem value="CUSTOMIZABLE">
                            Customizable — customer chooses
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="comboPricing"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Price rule</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value || "FIXED_PRICE"}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full rounded-xl h-11">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="rounded-xl">
                          <SelectItem value="FIXED_PRICE">
                            Fixed price (+ item surcharges)
                          </SelectItem>
                          <SelectItem value="COMPONENT_SUM">
                            Sum of component prices
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="comboStockPolicy"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Stock comes from</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={
                          watchedComboMode === "CUSTOMIZABLE"
                            ? "COMPONENTS"
                            : field.value || "OWN_STOCK"
                        }
                        disabled={watchedComboMode === "CUSTOMIZABLE"}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full rounded-xl h-11">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="rounded-xl">
                          <SelectItem value="OWN_STOCK">
                            The combo itself (pre-assembled boxes)
                          </SelectItem>
                          <SelectItem value="COMPONENTS">
                            Each component&apos;s stock
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <p className="text-xs text-muted-foreground sm:col-span-3">
                  Only one inventory is ever reduced per order: the combo&apos;s
                  own stock, or its components&apos; stock — never both.
                  Customizable combos always use component stock.
                </p>
              </div>
            )}

            {watchedKind === "SINGLE" && (
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-medium text-foreground">
                      Product Type
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full rounded-xl h-11">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-xl">
                        <SelectItem value="STANDARD">Standard</SelectItem>
                        <SelectItem value="VARIANT">
                          Variant (color/size)
                        </SelectItem>
                        <SelectItem value="PERSONALIZED">
                          Personalized
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-medium text-foreground">
                    Publication Status
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full rounded-xl h-11">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl">
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="ACTIVE">Active (Published)</SelectItem>
                      <SelectItem value="ARCHIVED">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Create flow: variants entered before the first save (kept in state, created together with the product). */}
        {!product && (
          <div
            hidden={tab !== "variants"}
            id="tab-panel-variants-draft"
            role="tabpanel"
            aria-labelledby="tab-variants"
            className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-4"
          >
            <h2 className="font-heading text-lg font-medium text-foreground">Variants</h2>
            {watchedType === "VARIANT" ? (
              <div className="space-y-3 rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-4">
                <p className="text-sm font-medium text-foreground">
                  Variants — new variants start from this product&apos;s price (
                  {watchedPrice || 0}) and stock ({watchedStock || 0}); override
                  either per variant below.
                </p>
                {draftVariants.map((variant) => (
                  <div
                    key={variant.id}
                    className="grid gap-2 rounded-xl border border-border/60 bg-card p-3 sm:grid-cols-5"
                  >
                    <Input
                      placeholder="Name (e.g. Terracotta / M)"
                      value={variant.name}
                      onChange={(e) =>
                        updateDraftVariant(variant.id, { name: e.target.value })
                      }
                    />
                    <Input
                      placeholder="SKU"
                      value={variant.sku}
                      onChange={(e) =>
                        updateDraftVariant(variant.id, { sku: e.target.value })
                      }
                    />
                    <Input
                      placeholder="Price"
                      type="number"
                      step="0.01"
                      value={variant.price}
                      onChange={(e) =>
                        updateDraftVariant(variant.id, {
                          price: e.target.value,
                        })
                      }
                    />
                    <Input
                      placeholder="Stock"
                      type="number"
                      value={variant.stock}
                      onChange={(e) =>
                        updateDraftVariant(variant.id, {
                          stock: e.target.value,
                        })
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => removeDraftVariant(variant.id)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addDraftVariant}
                >
                  Add variant
                </Button>
                <p className="text-xs text-muted-foreground">
                  You can add options (color/size), an image, or
                  default/backorder flags for each variant after saving, from
                  the Variants section below.
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                To add variants, set the product type to “Has variations” in Type &amp; category. Attributes below can be added for any product.
              </p>
            )}
          </div>
        )}

        {/* SECTION 5: Badges & Tags */}
        <div
          hidden={tab !== "advanced"}
          id="tab-panel-advanced5"
          role="tabpanel"
          aria-labelledby="tab-advanced"
          className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-600">
              <Sparkles className="size-5" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-medium text-foreground">
                Badges & Attributes
              </h2>
              <p className="text-xs text-muted-foreground">
                Highlight special traits like handmade, limited edition, or
                sales.
              </p>
            </div>
          </div>

          <FormField
            control={form.control}
            name="badges"
            render={({ field }) => (
              <FormItem>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {BADGES.map((badge) => {
                    const isSelected = field.value.includes(badge);
                    return (
                      <div
                        key={badge}
                        onClick={() => {
                          field.onChange(
                            isSelected
                              ? field.value.filter((b) => b !== badge)
                              : [...field.value, badge],
                          );
                        }}
                        className={`flex items-center gap-3 p-3.5 rounded-2xl border transition-all cursor-pointer select-none ${
                          isSelected
                            ? "border-primary bg-primary/5 text-primary font-medium shadow-2xs"
                            : "border-border/60 bg-neutral-50/40 hover:bg-neutral-50 text-foreground"
                        }`}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => {}} // Handled by outer div click for better UX
                          className="rounded-md pointer-events-none"
                        />
                        <span className="text-xs uppercase tracking-wider">
                          {badge.replaceAll("_", " ")}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* SECTION 6: SEO Metadata */}
        <div
          hidden={tab !== "seo"}
          id="tab-panel-seo6"
          role="tabpanel"
          aria-labelledby="tab-seo"
          className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-600">
              <Globe className="size-5" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-medium text-foreground">
                Search Engine Optimization (SEO)
              </h2>
              <p className="text-xs text-muted-foreground">
                Optimize how this product appears on Google and search engines.
              </p>
            </div>
          </div>

          <SeoPreview
            title={wMetaTitle ?? ""}
            fallbackTitle={wName ?? ""}
            description={wMetaDescription ?? ""}
            fallbackDescription={firstText(wShort, wDescription)}
            path={`/products/${wSlug ?? ""}`}
            image={wSeoImage || galleryImages?.[0]?.url}
            noindex={!!wNoIndex}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="metaTitle"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="font-medium text-foreground">SEO title</FormLabel>
                  <FormControl>
                    <Input placeholder="Leave empty to use the product name" className="rounded-xl h-11" maxLength={120} {...field} />
                  </FormControl>
                  <SeoCounter value={field.value ?? ""} kind="title" fallbackNote="Using the product name." />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="metaDescription"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="font-medium text-foreground">SEO description</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder="Leave empty to use the short description" className="rounded-xl" maxLength={300} {...field} />
                  </FormControl>
                  <SeoCounter value={field.value ?? ""} kind="description" fallbackNote="Using the short description (or the start of the full description)." />
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="font-medium text-foreground">Page address (URL)</FormLabel>
                  <div className="flex items-center overflow-hidden rounded-xl border border-input bg-background">
                    <span className="shrink-0 bg-secondary/50 px-3 py-3 text-xs text-muted-foreground">{siteOrigin().replace(/^https?:\/\//, "")}/products/</span>
                    <FormControl>
                      <Input
                        className="h-11 rounded-none border-0 shadow-none focus-visible:ring-0"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))}
                      />
                    </FormControl>
                  </div>
                  {product && wSlug !== product.slug ? (
                    <p className="text-xs text-amber-700">
                      You are changing the address of a live page. The old address keeps working and forwards visitors here permanently.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">Lowercase letters, numbers and hyphens. Short and readable works best.</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="seoImage"
              render={({ field }) => (
                <FormItem className="sm:col-span-2 space-y-2">
                  <FormLabel className="font-medium text-foreground">Share image</FormLabel>
                  <p className="text-xs text-muted-foreground">
                    Shown when the product is shared and in some search results. Empty = the main product image.
                  </p>
                  {galleryImages && galleryImages.length > 0 && (
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a product image">
                      {galleryImages.map((img) => (
                        <button
                          key={img.url}
                          type="button"
                          onClick={() => field.onChange(img.url)}
                          aria-pressed={field.value === img.url}
                          className={`size-16 overflow-hidden rounded-lg border-2 ${field.value === img.url ? "border-primary" : "border-transparent"}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element -- admin thumbnail of a stored URL */}
                          <img src={img.url} alt="Product photo" className="size-full object-cover" />
                        </button>
                      ))}
                    </div>
                  )}
                  <SingleImageUploader
                    value={field.value ? { url: field.value, publicId: null } : null}
                    onChange={(v) => field.onChange(v?.url ?? "")}
                    folder="products"
                    label="Upload a different share image"
                    aspectClassName="aspect-[1.91/1]"
                    deferDelete
                  />
                  {field.value && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => field.onChange("")}>
                      Use the main product image
                    </Button>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="metaKeywords"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="font-medium text-foreground">SEO keywords (optional)</FormLabel>
                  <FormControl>
                    <TagInput label="SEO keywords" value={field.value ?? []} onChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="seoNoIndex"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <label className="flex items-start gap-3 text-sm">
                    <Checkbox checked={!!field.value} onCheckedChange={(c) => field.onChange(c === true)} className="mt-0.5" />
                    <span>
                      <span className="font-medium">Hide this product from search engines</span>
                      <span className="block text-xs text-muted-foreground">
                        It stays on your store and reachable by its link, but Google and others are asked not to list it, and it is left out of the sitemap.
                      </span>
                    </span>
                  </label>
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* SECTION 7: Description */}
        <div
          hidden={tab !== "basic"}
          id="tab-panel-basic7"
          role="tabpanel"
          aria-labelledby="tab-basic"
          className="bg-white border border-border/60 rounded-3xl p-6 sm:p-8 shadow-xs space-y-6"
        >
          <div className="flex items-center gap-3 border-b border-border/50 pb-4">
            <div>
              <h2 className="font-heading text-lg font-medium text-foreground">
                Description
              </h2>
              <p className="text-xs text-muted-foreground">
                Full product details and a short catchphrase shown on product
                cards.
              </p>
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="shortDescription"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="font-medium text-foreground">
                    Short Description
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="A brief catchphrase or summary shown on product cards."
                      className="rounded-xl h-11"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="font-medium text-foreground">
                    Full Description
                  </FormLabel>
                  <FormControl>
                    <RichTextEditor
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Provide complete details about materials, care instructions, dimensions..."
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        {/* Bottom Sticky or Action Bar */}
        <div className="flex items-center justify-end gap-4 pt-4">
          <Button
            type="button"
            variant="outline"
            className="rounded-full px-6 h-12"
            onClick={() => goBack("Discard your unsaved changes?")}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isPending}
            size="lg"
            className="rounded-full px-8 h-12 shadow-lg font-medium"
          >
            {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            {isPending
              ? "Saving..."
              : product || createdId
                ? "Save Changes"
                : "Publish Product"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
