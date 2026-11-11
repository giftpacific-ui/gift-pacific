"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  addCampaignProductAction,
  deleteCampaignAction,
  removeCampaignProductAction,
  saveCampaignAction,
  searchProductsForCampaignAction,
} from "@/server/actions/admin-campaign.actions";

import { SeoCounter, SeoPreview } from "@/features/admin/seo-preview";

export type CampaignView = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  image: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  isActive: boolean;
  startsAt: string | null; // YYYY-MM-DD (store time)
  endsAt: string | null;
  products: { id: string; name: string; status: string }[];
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function CampaignForm({
  campaign,
  onDone,
}: {
  campaign?: CampaignView;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(campaign?.name ?? "");
  const [slug, setSlug] = useState(campaign?.slug ?? "");
  const [description, setDescription] = useState(campaign?.description ?? "");
  const [image, setImage] = useState(campaign?.image ?? "");
  const [metaTitle, setMetaTitle] = useState(campaign?.metaTitle ?? "");
  const [metaDescription, setMetaDescription] = useState(campaign?.metaDescription ?? "");
  const [startsAt, setStartsAt] = useState(campaign?.startsAt ?? "");
  const [endsAt, setEndsAt] = useState(campaign?.endsAt ?? "");
  const [isActive, setIsActive] = useState(campaign?.isActive ?? true);

  function submit() {
    startTransition(async () => {
      const result = await saveCampaignAction(campaign?.id ?? null, {
        name,
        slug: slug || slugify(name),
        description,
        image,
        metaTitle,
        metaDescription,
        isActive,
        startsAt,
        endsAt,
      });
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(campaign ? "Campaign saved" : "Campaign created");
      if (!campaign) {
        setName("");
        setSlug("");
        setDescription("");
        setImage("");
        setStartsAt("");
        setEndsAt("");
      }
      onDone?.();
      router.refresh();
    });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Input
        placeholder="Campaign name"
        value={name}
        maxLength={100}
        onChange={(e) => {
          setName(e.target.value);
          if (!campaign && !slug) setSlug(slugify(e.target.value));
        }}
      />
      <Input
        placeholder="slug (e.g. eid-sale)"
        value={slug}
        maxLength={60}
        onChange={(e) => setSlug(e.target.value)}
      />
      <Textarea
        className="sm:col-span-2"
        placeholder="Short description (optional)"
        value={description}
        maxLength={500}
        rows={2}
        onChange={(e) => setDescription(e.target.value)}
      />
      <Input
        className="sm:col-span-2"
        placeholder="Header image URL (optional, https://…)"
        value={image}
        onChange={(e) => setImage(e.target.value)}
      />
      <div className="space-y-1 sm:col-span-2">
        <p className="text-sm font-medium">Search &amp; sharing (optional)</p>
        <Input placeholder="SEO title (defaults to the campaign name)" value={metaTitle} maxLength={120} onChange={(e) => setMetaTitle(e.target.value)} />
        <SeoCounter value={metaTitle} kind="title" fallbackNote="Using the campaign name." />
        <Textarea placeholder="SEO description (defaults to the description above)" value={metaDescription} maxLength={300} rows={2} onChange={(e) => setMetaDescription(e.target.value)} />
        <SeoCounter value={metaDescription} kind="description" fallbackNote="Using the description above." />
        <SeoPreview title={metaTitle} fallbackTitle={name} description={metaDescription} fallbackDescription={description} path="/campaign" image={image} />
      </div>
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">
          Starts (optional)
        </span>
        <Input
          type="date"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
        />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">
          Ends — inclusive (optional)
        </span>
        <Input
          type="date"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Active (shown at /campaign during its dates)
      </label>
      <Button
        onClick={submit}
        disabled={isPending || name.trim().length < 2}
        className="sm:justify-self-end"
      >
        {isPending ? "Saving…" : campaign ? "Save campaign" : "Create campaign"}
      </Button>
    </div>
  );
}

function CampaignProducts({ campaign }: { campaign: CampaignView }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<
    { id: string; name: string; status: string }[]
  >([]);

  function runSearch(value: string) {
    setSearch(value);
    if (value.trim().length < 2) return setResults([]);
    startTransition(async () => {
      const res = await searchProductsForCampaignAction(value);
      setResults(res);
    });
  }
  function add(productId: string) {
    startTransition(async () => {
      const r = await addCampaignProductAction(campaign.id, productId);
      if (!r.success) toast.error(r.message);
      setSearch("");
      setResults([]);
      router.refresh();
    });
  }
  function remove(productId: string) {
    startTransition(async () => {
      const r = await removeCampaignProductAction(campaign.id, productId);
      if (!r.success) toast.error(r.message);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">
        Products ({campaign.products.length})
      </p>
      <ul className="flex flex-wrap gap-2">
        {campaign.products.map((p) => (
          <li
            key={p.id}
            className="flex items-center gap-1 rounded-full border border-border px-3 py-1 text-sm"
          >
            {p.name}
            {p.status !== "ACTIVE" && (
              <span className="text-xs text-muted-foreground">
                ({p.status.toLowerCase()} — hidden)
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              disabled={isPending}
              onClick={() => remove(p.id)}
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
        {campaign.products.length === 0 && (
          <li className="text-sm text-muted-foreground">No products yet.</li>
        )}
      </ul>
      <Input
        placeholder="Search products to add…"
        value={search}
        onChange={(e) => runSearch(e.target.value)}
      />
      {results.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-secondary"
                disabled={isPending}
                onClick={() => add(p.id)}
              >
                {p.name}{" "}
                <span className="text-muted-foreground">
                  ({p.status.toLowerCase()})
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CampaignCard({ campaign }: { campaign: CampaignView }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);

  function remove() {
    if (
      !confirm(
        `Delete the campaign "${campaign.name}"? Its products are not deleted.`,
      )
    )
      return;
    startTransition(async () => {
      const r = await deleteCampaignAction(campaign.id);
      if (!r.success) {
        toast.error(r.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-heading text-lg">{campaign.name}</h2>
          <p className="text-xs text-muted-foreground">
            {campaign.isActive ? "Active" : "Inactive"}
            {campaign.startsAt && ` · from ${campaign.startsAt}`}
            {campaign.endsAt && ` · until ${campaign.endsAt}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Close" : "Edit"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={remove}
            aria-label="Delete campaign"
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>
      {editing && (
        <CampaignForm campaign={campaign} onDone={() => setEditing(false)} />
      )}
      <CampaignProducts campaign={campaign} />
    </div>
  );
}
