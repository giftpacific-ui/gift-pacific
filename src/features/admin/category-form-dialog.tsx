"use client";

import { useEffect, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import slugify from "slugify";
import { categoryFormSchema } from "@/lib/validations/admin";
import { saveCategoryAction, getCategoriesForSelectAction } from "@/server/actions/admin-category.actions";
import { TagInput } from "@/components/ui/tag-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { SeoPreview } from "@/features/admin/seo-preview";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { SingleImageUploader, type ImageValue } from "@/features/admin/single-image-uploader";
import type { Category } from "@prisma/client";
import { Plus } from "lucide-react";

export function CategoryFormDialog({
  category,
  trigger,
}: {
  category?: Category;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [parentOptions, setParentOptions] = useState<{ id: string; name: string; depth: number }[]>([]);
  const [image, setImage] = useState<ImageValue | null>(
    category?.image ? { url: category.image, publicId: category.imageCloudinaryPublicId } : null,
  );
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    getCategoriesForSelectAction().then((options) => {
      // A category can't be its own parent. (Selecting one of its own
      // descendants as a parent is a rarer mistake we don't guard against
      // here to keep this simple — the admin is the only one using this.)
      setParentOptions(category ? options.filter((o) => o.id !== category.id) : options);
    });
  }, [open, category]);

  // Note: no explicit useForm<T> generic here — it's inferred from the
  // resolver itself. Zod's z.coerce fields have an `unknown` input type
  // (pre-coercion) that differs from their parsed output type, so pinning
  // a hand-written generic here fights the resolver's own inference.
  const form = useForm({
    resolver: zodResolver(categoryFormSchema),
    defaultValues: {
      name: category?.name ?? "",
      slug: category?.slug ?? "",
      description: category?.description ?? "",
      metaTitle: category?.metaTitle ?? "",
      metaDescription: category?.metaDescription ?? "",
      metaKeywords: category?.metaKeywords ?? [],
      seoNoIndex: category?.seoNoIndex ?? false,
      parentId: category?.parentId ?? "",
      isFeatured: category?.isFeatured ?? false,
      isActive: category?.isActive ?? true,
      sortOrder: category?.sortOrder ?? 0,
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    startTransition(async () => {
      const result = await saveCategoryAction(category?.id ?? null, {
        ...values,
        image: image?.url ?? "",
        imageCloudinaryPublicId: image?.publicId ?? null,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(category ? "Category updated" : "Category created");
      setOpen(false);
      router.refresh();
    });
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? <Button><Plus /> New category</Button>}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{category ? "Edit category" : "New category"}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      onChange={(e) => {
                        field.onChange(e);
                        if (!category) form.setValue("slug", slugify(e.target.value, { lower: true, strict: true }));
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
                  <FormLabel>Slug</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  {category && field.value !== category.slug && (
                    <p className="text-xs text-amber-700">Changing the slug changes the category address. The old address keeps working and forwards visitors here permanently.</p>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="parentId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Parent category</FormLabel>
                  <Select onValueChange={(v) => field.onChange(v === "none" ? "" : v)} value={field.value || "none"}>
                    <FormControl>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">None — top-level category</SelectItem>
                      {parentOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {"—".repeat(option.depth)} {option.depth > 0 ? " " : ""}{option.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Leave as &ldquo;None&rdquo; for a top-level category, choose a category to
                    create a subcategory, or choose a subcategory to create a child category.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl><Textarea {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField control={form.control} name="metaTitle" render={({ field }) => (
              <FormItem><FormLabel>SEO title</FormLabel><FormControl><Input maxLength={120} placeholder="Defaults to the category name" {...field} /></FormControl><p className="text-[11px] text-muted-foreground">{(field.value ?? "").length}/120 — about 60 characters shows fully in search results.</p><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="metaDescription" render={({ field }) => (
              <FormItem><FormLabel>SEO description</FormLabel><FormControl><Textarea maxLength={300} rows={2} placeholder="Defaults to the description above" {...field} /></FormControl><p className="text-[11px] text-muted-foreground">{(field.value ?? "").length}/300 — about 155 characters shows fully.</p><FormMessage /></FormItem>
            )} />
            <SeoPreview
              title={form.watch("metaTitle") ?? ""}
              fallbackTitle={form.watch("name") ?? ""}
              description={form.watch("metaDescription") ?? ""}
              fallbackDescription={form.watch("description") ?? ""}
              path={`/shop/${form.watch("slug") ?? ""}`}
              image={image?.url}
              noindex={!!form.watch("seoNoIndex")}
            />
            <FormField control={form.control} name="seoNoIndex" render={({ field }) => (
              <FormItem>
                <label className="flex items-start gap-3 text-sm">
                  <Checkbox checked={!!field.value} onCheckedChange={(c) => field.onChange(c === true)} className="mt-0.5" />
                  <span>
                    <span className="font-medium">Hide this category from search engines</span>
                    <span className="block text-xs text-muted-foreground">The category stays on your store, but is not listed by search engines or in the sitemap.</span>
                  </span>
                </label>
              </FormItem>
            )} />
            <FormField control={form.control} name="metaKeywords" render={({ field }) => (
              <FormItem><FormLabel>SEO keywords</FormLabel><FormControl><TagInput label="Category SEO keywords" value={field.value ?? []} onChange={field.onChange} /></FormControl><FormMessage /></FormItem>
            )} />
            <div className="space-y-2">
              <FormLabel>Image</FormLabel>
              <SingleImageUploader
                value={image}
                onChange={setImage}
                folder="categories"
                label="Category image"
              />
            </div>
            <FormField
              control={form.control}
              name="sortOrder"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Sort order</FormLabel>
                  <FormControl><Input type="number" {...field} value={field.value as string | number | undefined} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex flex-wrap gap-6">
              <FormField
                control={form.control}
                name="isFeatured"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-2 space-y-0">
                    <FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    <FormLabel className="font-normal">Feature on homepage</FormLabel>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center gap-2 space-y-0">
                    <FormControl><Checkbox checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    <FormLabel className="font-normal">Active (visible on the storefront)</FormLabel>
                  </FormItem>
                )}
              />
            </div>
            <Button type="submit" className="w-full" disabled={isPending}>
              {isPending ? "Saving…" : "Save category"}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
