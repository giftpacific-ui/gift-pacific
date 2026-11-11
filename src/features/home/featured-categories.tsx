import { CategoryShowcase } from "@/features/home/category-showcase";
import { Reveal } from "@/components/shared/reveal";

type Category = {
  name: string;
  slug: string;
  image: string | null;
  parentId: string | null;
};

export function FeaturedCategories({ categories }: { categories: Category[] }) {
  if (categories.length === 0) return null;

  return (
    <section className="bg-background">
      <div
        className="container-boutique section-y"
        aria-labelledby="categories-heading"
      >
        <Reveal>
          <div className="mb-10 sm:mb-12">
            <p className="eyebrow">Collections</p>
            <h2
              id="categories-heading"
              className="font-heading text-[clamp(1.9rem,3.6vw,2.9rem)] leading-tight font-semibold"
            >
              What are you looking for?
            </h2>
          </div>
          <CategoryShowcase
            categories={categories.map((c) => ({
              name: c.name,
              slug: c.slug,
              imageUrl: c.image,
              parentId: c.parentId,
            }))}
          />
        </Reveal>
      </div>
    </section>
  );
}
