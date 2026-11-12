"use client";

import { useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ImagePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { validateImageFileClientSide } from "@/lib/upload-validation";
import { Button } from "@/components/ui/button";
import { uploadImageFile } from "@/lib/cloudinary/upload-image";
import { cn } from "@/lib/utils";
import { deleteCloudinaryImageAction } from "@/server/actions/upload.actions";

export type ImageValue = { url: string; publicId: string | null };

export function SingleImageUploader({
  value,
  onChange,
  folder,
  label = "Image",
  aspectClassName = "aspect-video",
  deferDelete = false,
  nameHint,
}: {
  nameHint?: string;
  value: ImageValue | null;
  onChange: (value: ImageValue | null) => void;
  folder: "products" | "banners" | "branding" | "categories" | "team" | "boxes";
  /** When true the parent deletes replaced/removed assets after the record is saved (avoids orphaned DB references). */
  deferDelete?: boolean;
  label?: string;
  aspectClassName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [isDragOver, setIsDragOver] = useState(false);

  function handlePick() {
    inputRef.current?.click();
  }

  function uploadFile(file: File) {
    // Instant client-side feedback (type only; there is no size cap). The file goes straight to Cloudinary.
    const problem = validateImageFileClientSide(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    startTransition(async () => {
      const result = await uploadImageFile(file, folder, nameHint);
      if (!result.success) {
        toast.error(result.message);
        return;
      }

      // Replacing an existing image: delete the old Cloudinary asset only
      // after the new one has uploaded successfully.
      const previous = value;
      onChange({ url: result.url, publicId: result.publicId });
      if (previous?.publicId && !deferDelete) {
        await deleteCloudinaryImageAction(previous.publicId);
      }
      toast.success("Image uploaded");
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) uploadFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const file = (Array.from(e.dataTransfer.files) as File[]).find((f) => f.type.startsWith("image/"));
    if (file) uploadFile(file);
  }

  function handleRemove() {
    const previous = value;
    onChange(null);
    if (previous?.publicId && !deferDelete) {
      startTransition(async () => {
        await deleteCloudinaryImageAction(previous.publicId!);
      });
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          "relative w-full max-w-sm overflow-hidden rounded-xl border border-dashed bg-secondary",
          aspectClassName,
          isDragOver ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        {value ? (
          <>
            <Image src={value.url} alt="" fill className="object-cover" />
            <button
              type="button"
              onClick={handleRemove}
              disabled={isPending}
              aria-label="Remove image"
              className="absolute right-2 top-2 rounded-full bg-card/90 p-1 shadow-sm"
            >
              <X className="size-4" />
            </button>
            {isDragOver && (
              <div className="absolute inset-0 flex items-center justify-center bg-primary/10 text-sm font-medium text-primary">
                Drop to replace
              </div>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={handlePick}
            disabled={isPending}
            className="flex size-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            {isPending ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
            {isPending ? "Uploading…" : isDragOver ? "Drop to upload" : "Click or drag to upload"}
          </button>
        )}
      </div>
      {value && (
        <Button type="button" variant="outline" size="sm" onClick={handlePick} disabled={isPending}>
          {isPending ? "Uploading…" : "Replace image"}
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
