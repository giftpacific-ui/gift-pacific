"use client";

import { useState } from "react";
import Image from "next/image";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { getYouTubeGalleryEmbedUrl } from "@/utils/GetYoutubeUrl";

export function ProductGallery({
  images,
  productName,
  videoUrl,
}: {
  images: { url: string; altText: string | null }[];
  productName: string;
  videoUrl?: string | null;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isVideoActive, setIsVideoActive] = useState(false);

  const activeImage = images[activeIndex];
  const embedVideoUrl = getYouTubeGalleryEmbedUrl(videoUrl);
  const altFor = (i: number) => images[i]?.altText || (images.length > 1 ? `${productName} — photo ${i + 1} of ${images.length}` : productName);

  const thumb = "relative aspect-4/5 w-16 shrink-0 overflow-hidden rounded-[3px] border transition-all sm:w-[4.6rem]";

  return (
    <div className="space-y-3" role="group" aria-label={`${productName} photos`}>
      <div className="relative aspect-4/5 overflow-hidden rounded-[4px] bg-secondary">
        {isVideoActive && embedVideoUrl ? (
          <iframe
            src={embedVideoUrl}
            title={`${productName} video`}
            className="h-full w-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : activeImage ? (
          <Image
            key={activeImage.url}
            src={activeImage.url}
            alt={altFor(activeIndex)}
            fill
            priority
            sizes="(min-width: 1024px) 54vw, 100vw"
            className="product-image-tone rise-in object-cover"
          />
        ) : (
          <span className="grid h-full place-items-center px-6 text-center font-heading text-2xl text-muted-foreground">{productName}</span>
        )}
      </div>

      {(images.length > 1 || embedVideoUrl) && (
        <div className="flex flex-wrap gap-2.5">
          {images.map((image, index) => {
            const selected = !isVideoActive && index === activeIndex;
            return (
              <button
                key={image.url + index}
                type="button"
                onClick={() => {
                  setActiveIndex(index);
                  setIsVideoActive(false);
                }}
                aria-label={`Show photo ${index + 1} of ${images.length}${image.altText ? `: ${image.altText}` : ""}`}
                aria-pressed={selected}
                className={cn(thumb, selected ? "border-foreground" : "border-transparent opacity-60 hover:opacity-100")}
              >
                <Image src={image.url} alt="" fill sizes="80px" className="product-image-tone object-cover" />
              </button>
            );
          })}

          {embedVideoUrl && (
            <button
              type="button"
              onClick={() => setIsVideoActive(true)}
              aria-label="Play product video"
              aria-pressed={isVideoActive}
              className={cn(thumb, "grid place-items-center bg-foreground text-background", isVideoActive ? "border-foreground" : "border-transparent opacity-70 hover:opacity-100")}
            >
              {images[0] && <Image src={images[0].url} alt="" fill sizes="80px" className="object-cover opacity-40" />}
              <span className="relative z-10 grid size-8 place-items-center rounded-full bg-primary text-primary-foreground shadow-md">
                <Play className="ml-0.5 size-4 fill-current" aria-hidden />
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
