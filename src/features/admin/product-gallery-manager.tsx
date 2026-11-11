"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GalleryImageUploader, type GalleryImage } from "@/features/admin/gallery-image-uploader";
import {
  addProductImageAction,
  deleteProductImageAction,
  setMainProductImageAction,
  reorderProductImagesAction,
  updateProductImageAltAction,
} from "@/server/actions/admin-product.actions";
import { useReportDirty } from "@/features/admin/product-editor-dirty";
import { Input } from "@/components/ui/input";
import type { ProductImage } from "@prisma/client";

function toGalleryImage(image: ProductImage): GalleryImage {
  return { id: image.id, url: image.url, publicId: image.cloudinaryPublicId, isMain: image.isMain };
}

export function ProductGalleryManager({
  productId,
  productName,
  images,
}: {
  productId: string;
  /** Used for readable uploaded file names and as the alt-text suggestion. */
  productName?: string;
  images: ProductImage[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [localImages, setLocalImages] = useState<GalleryImage[]>(images.map(toGalleryImage));
  // Image changes are saved as they happen, so the only unsaved state is an upload/reorder still in flight.
  useReportDirty("media", isPending);
  const [alts, setAlts] = useState<Record<string, string>>(() => Object.fromEntries(images.map((i) => [i.id, i.altText ?? ""])));
  const savedAlts = images.reduce<Record<string, string>>((acc, i) => ({ ...acc, [i.id]: i.altText ?? "" }), {});

  function saveAlt(id: string) {
    const value = (alts[id] ?? "").trim();
    if (value === (savedAlts[id] ?? "")) return;
    startTransition(async () => {
      const result = await updateProductImageAltAction(id, productId, value);
      if (!result.success) toast.error(result.message);
      else router.refresh();
    });
  }

  function handleUpload(uploaded: { url: string; publicId: string }[]) {
    startTransition(async () => {
      const gallerySize = localImages.length;
      const newImages: GalleryImage[] = [];
      for (const item of uploaded) {
        const isFirstImage = gallerySize === 0 && newImages.length === 0;
        const result = await addProductImageAction(productId, item.url, isFirstImage, item.publicId);
        if (!result.success || !result.imageId) {
          toast.error(!result.success ? result.message : "Could not save an uploaded image.");
          continue;
        }
        newImages.push({ id: result.imageId, url: item.url, publicId: item.publicId, isMain: isFirstImage });
      }
      if (newImages.length > 0) {
        setLocalImages((current) => [...current, ...newImages]);
      }
      router.refresh();
    });
  }

  function handleRemove(id: string) {
    const wasMain = localImages.find((img) => img.id === id)?.isMain ?? false;
    setLocalImages((current) => {
      const remaining = current.filter((img) => img.id !== id);
      return wasMain && remaining.length > 0
        ? remaining.map((img, index) => ({ ...img, isMain: index === 0 }))
        : remaining;
    });
    startTransition(async () => {
      const deleted = await deleteProductImageAction(id, productId);
      if (!deleted.success) toast.error(deleted.message);
      // If the removed image was main, promote the new first image server-side too.
      if (deleted.success && wasMain) {
        const newFirst = localImages.find((img) => img.id !== id);
        if (newFirst) await setMainProductImageAction(productId, newFirst.id);
      }
      router.refresh();
    });
  }

  function handleSetMain(id: string) {
    setLocalImages((current) => current.map((img) => ({ ...img, isMain: img.id === id })));
    startTransition(async () => {
      const result = await setMainProductImageAction(productId, id);
      if (!result.success) toast.error(result.message);
      router.refresh();
    });
  }

  function handleReorder(orderedIds: string[]) {
    setLocalImages((current) =>
      orderedIds
        .map((id) => current.find((img) => img.id === id))
        .filter((img): img is GalleryImage => img !== undefined),
    );
    startTransition(async () => {
      const result = await reorderProductImagesAction(productId, orderedIds);
      if (!result.success) {
        toast.error(result.message);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-2">
      <GalleryImageUploader
        images={localImages}
        onUpload={handleUpload}
        onRemove={handleRemove}
        onSetMain={handleSetMain}
        onReorder={handleReorder}
        nameHint={productName}
      />
      {localImages.length > 0 && (
        <div className="space-y-2 pt-4">
          <h3 className="text-sm font-medium">Photo descriptions (alt text)</h3>
          <p className="text-xs text-muted-foreground">
            Describe what is in each photo, for example &ldquo;Blue ceramic mug with a hand-painted rim&rdquo;. It helps screen-reader users and image search.
            Left empty, the product name is used.
          </p>
          <ul className="space-y-2">
            {localImages.map((img, index) => (
              <li key={img.id} className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- admin thumbnail of a stored URL */}
                <img src={img.url} alt="" className="size-12 shrink-0 rounded-lg object-cover" />
                <Input
                  aria-label={`Description of photo ${index + 1}`}
                  placeholder={productName ? `${productName} — photo ${index + 1}` : "Describe this photo"}
                  maxLength={200}
                  value={alts[img.id] ?? ""}
                  onChange={(e) => setAlts((cur) => ({ ...cur, [img.id]: e.target.value }))}
                  onBlur={() => saveAlt(img.id)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {isPending && <p className="text-xs text-muted-foreground">Saving…</p>}
    </div>
  );
}
