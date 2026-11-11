export interface Banner {
  id: string;
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  cloudinaryPublicId?: string | null;
  ctaLabel?: string | null;
  ctaHref?: string | null;
  placement: string;
  sortOrder: number;
  isActive: boolean;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}
