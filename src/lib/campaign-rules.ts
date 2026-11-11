import { isSafeImageUrl } from "@/lib/url-safety";

export type CampaignInput = {
  name: string;
  slug: string;
  description?: string | null;
  image?: string | null;
};

export function validateCampaignInput(input: CampaignInput): string | null {
  const name = input.name?.trim() ?? "";
  if (name.length < 2 || name.length > 100) return "Campaign name must be 2–100 characters.";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length < 2 || input.slug.length > 60) {
    return "Slug may use lowercase letters, numbers and hyphens (2–60 characters).";
  }
  if ((input.description?.length ?? 0) > 500) return "Description can be at most 500 characters.";
  if (input.image && !isSafeImageUrl(input.image)) return "Image must be a valid http(s) URL.";
  return null;
}
