"use client";

import { useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ImagePlus, Loader2, MoveLeft, MoveRight, Star, X } from "lucide-react";
import { toast } from "sonner";
import { validateImageFileClientSide } from "@/lib/upload-validation";
import { readFileAsDataUrl } from "@/lib/cloudinary/read-file";
import { uploadImageAction } from "@/server/actions/upload.actions";
import { cn } from "@/lib/utils";

export type GalleryImage = {
  id: string;
  url: string;
  publicId: string | null;
  isMain: boolean;
};

const MAX_IMAGES = 10;

/**
 * Purely presentational — every mutation (upload/remove/set-main/reorder)
 * is reported to the parent via a dedicated callback rather than a single
 * diffed onChange(images[]). This keeps each operation an explicit,
 * unambiguous intent instead of something the parent has to infer by
 * comparing array snapshots, which is fragile once uploads are async.
 */
export function GalleryImageUploader({
  images,
  onUpload,
  onRemove,
  onSetMain,
  onReorder,
  nameHint,
}: {
  /** Readable name for uploaded file names (the product name). */
  nameHint?: string;
  images: GalleryImage[];
  onUpload: (uploaded: { url: string; publicId: string }[]) => void;
  onRemove: (id: string) => void;
  onSetMain: (id: string) => void;
  onReorder: (orderedIds: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [isDragOver, setIsDragOver] = useState(false);

  function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []) as File[];
    e.target.value = "";
    uploadFiles(files);
  }

  function uploadFiles(files: File[]) {
    if (files.length === 0) return;

    const remainingSlots = MAX_IMAGES - images.length;
    if (remainingSlots <= 0) {
      toast.error(`You can have at most ${MAX_IMAGES} gallery images.`);
      return;
    }
    const toUpload = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      toast.info(`Only uploading ${remainingSlots} — the ${MAX_IMAGES}-image limit was reached.`);
    }

    const rejected = toUpload.map(validateImageFileClientSide).find((p) => p !== null);
    if (rejected) {
      toast.error(rejected);
      return;
    }

    startTransition(async () => {
      // Uploaded in parallel (the actual "simultaneous" fix) rather than
      // one-at-a-time. Results are collected into a single batch and
      // reported to the parent in one onUpload call, rather than once per
      // file — the parent decides "is this the first image" from its own
      // current state, which would race (all calls seeing the same stale
      // "gallery is empty" snapshot) if fired once per file back-to-back.
      const results = await Promise.all(
        toUpload.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          return uploadImageAction(dataUrl, "products", nameHint);
        }),
      );

      const succeeded: { url: string; publicId: string }[] = [];
      for (const result of results) {
        if (!result.success) {
          toast.error(result.message);
          continue;
        }
        succeeded.push({ url: result.url, publicId: result.publicId });
      }
      if (succeeded.length > 0) onUpload(succeeded);
    });
  }

  function handleMove(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= images.length) return;
    const updated = [...images];
    [updated[index], updated[targetIndex]] = [updated[targetIndex], updated[index]];
    onReorder(updated.map((img) => img.id));
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">
        Gallery images ({images.length}/{MAX_IMAGES})
      </p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
        {images.map((image, index) => (
          <div
            key={image.id}
            className={cn(
              "group relative aspect-square overflow-hidden rounded-lg border-2 bg-secondary",
              image.isMain ? "border-primary" : "border-transparent",
            )}
          >
            <Image src={image.url} alt="" fill className="object-cover" />
            {image.isMain && (
              <span className="absolute left-1 top-1 flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                <Star className="size-2.5 fill-current" /> Main
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/50 px-1 py-1 opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={() => handleMove(index, -1)}
                disabled={index === 0}
                aria-label="Move left"
                className="p-1 text-white disabled:opacity-30"
              >
                <MoveLeft className="size-3.5" />
              </button>
              {!image.isMain && (
                <button
                  type="button"
                  onClick={() => onSetMain(image.id)}
                  aria-label="Set as main image"
                  className="p-1 text-white"
                >
                  <Star className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onRemove(image.id)}
                aria-label="Remove image"
                className="p-1 text-white"
              >
                <X className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleMove(index, 1)}
                disabled={index === images.length - 1}
                aria-label="Move right"
                className="p-1 text-white disabled:opacity-30"
              >
                <MoveRight className="size-3.5" />
              </button>
            </div>
          </div>
        ))}

        {images.length < MAX_IMAGES && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragOver(false);
              uploadFiles(
                (Array.from(e.dataTransfer.files) as File[]).filter((f) => f.type.startsWith("image/")),
              );
            }}
            disabled={isPending}
            className={cn(
              "flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground",
              isDragOver ? "border-primary bg-primary/5" : "border-border",
            )}
          >
            {isPending ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
            {isPending ? "Uploading…" : isDragOver ? "Drop to upload" : "Add image"}
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={handleFilesChange}
      />
      <p className="text-xs text-muted-foreground">
        Click the star to set the main image shown on the shop and product cards.
      </p>
    </div>
  );
}
