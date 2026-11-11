"use client";

import { useRef, useState, type ComponentProps } from "react";
import { ProductForm } from "@/features/admin/product-form";
import { ProductAttributesCard, type AttributeDraft } from "@/features/admin/product-attributes-card";
import { GalleryImageUploader, type GalleryImage } from "@/features/admin/gallery-image-uploader";
import { ProductCustomizationManager, customizationPayload, type CustomizationDraft } from "@/features/admin/product-customization-manager";
import { ProductEditorDirtyProvider, useReportDirty } from "@/features/admin/product-editor-dirty";
import { saveCustomizationFieldAction, addProductImageAction } from "@/server/actions/admin-product.actions";
import { saveProductAttributesAction } from "@/server/actions/admin-attribute.actions";
import { discardUnsavedUploadAction } from "@/server/actions/upload.actions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type AttributeDefs = ComponentProps<typeof ProductAttributesCard>["defs"];
type Categories = ComponentProps<typeof ProductForm>["categories"];

const EMPTY_DRAFT: AttributeDraft = { assigned: [], values: {} };

/**
 * Create page. Variants, attributes and media are available before the first save: what the admin enters is kept in
 * state and written right after the product exists. If a nested write fails the product stays (a later save updates
 * it instead of creating a duplicate) and the unsaved drafts stay on screen.
 */
function CreateInner({ categories, defs }: { categories: Categories; defs: AttributeDefs }) {
  const [tab, setTab] = useState("basic");
  const [attrDraft, setAttrDraft] = useState<AttributeDraft>(EMPTY_DRAFT);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [productType, setProductType] = useState<string>("SIMPLE");
  const [fieldDrafts, setFieldDrafts] = useState<CustomizationDraft[]>([]);
  const fieldsRef = useRef(fieldDrafts);
  const persistedFieldKeys = useRef(new Set<string>());
  const typeRef = useRef(productType);
  const attrRef = useRef(attrDraft);
  const imagesRef = useRef(images);
  const persistedUrls = useRef(new Set<string>());
  const attrsSaved = useRef(false);

  const updateAttr = (d: AttributeDraft) => {
    attrRef.current = d;
    setAttrDraft(d);
  };
  const updateImages = (next: GalleryImage[]) => {
    imagesRef.current = next;
    setImages(next);
  };

  const updateFields = (next: CustomizationDraft[]) => {
    fieldsRef.current = next;
    setFieldDrafts(next);
  };

  useReportDirty("create-customization", fieldDrafts.length > 0);
  useReportDirty("create-attributes", attrDraft.assigned.length > 0);
  useReportDirty("create-media", images.length > 0);

  async function persist(productId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const problems: string[] = [];

    const draft = attrRef.current;
    if (draft.assigned.length > 0 && !attrsSaved.current) {
      const r = await saveProductAttributesAction(
        productId,
        draft.assigned.map((attributeId) => ({ attributeId, value: draft.values[attributeId] ?? "" })),
      );
      if (r.success) attrsSaved.current = true;
      else problems.push(`the attributes were not saved (${r.message})`);
    }

    const pending = fieldsRef.current.filter((f) => !persistedFieldKeys.current.has(f.key));
    if (pending.length > 0 && typeRef.current !== "PERSONALIZED") {
      problems.push("the personalization fields were not saved because the product type is not “Personalized”");
    } else {
      for (const f of pending) {
        const r = await saveCustomizationFieldAction(productId, null, customizationPayload(f));
        if (r.success) persistedFieldKeys.current.add(f.key);
        else problems.push(`personalization field “${f.label}” was not saved (${r.message})`);
      }
    }

    const list = imagesRef.current;
    const hasMain = list.some((i) => i.isMain);
    for (let index = 0; index < list.length; index++) {
      const image = list[index];
      if (persistedUrls.current.has(image.url)) continue;
      const r = await addProductImageAction(productId, image.url, hasMain ? image.isMain : index === 0, image.publicId);
      if (r.success) persistedUrls.current.add(image.url);
      else problems.push(`an image was not saved (${r.message})`);
    }

    if (problems.length > 0) return { ok: false, message: `${problems.join("; ")}.` };
    updateAttr(EMPTY_DRAFT);
    updateImages([]);
    updateFields([]);
    return { ok: true };
  }

  return (
    <>
      <ProductForm
        categories={categories}
        activeTab={tab}
        onTabChange={setTab}
        extraTabs={[
          { key: "variants", label: "Variants & attributes" },
          { key: "media", label: "Media" },
        ]}
        createExtras={{ persist }}
        galleryImages={images.map((i) => ({ url: i.url }))}
        onTypeChange={(t) => {
          typeRef.current = t;
          setProductType(t);
        }}
      />

      <div id="tab-panel-variants" role="tabpanel" aria-labelledby="tab-variants" hidden={tab !== "variants"} className="mt-8 space-y-8">
        <Card id="attributes" className="scroll-mt-24">
          <CardHeader>
            <CardTitle>Attributes</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductAttributesCard productId={null} defs={defs} current={{}} initialDraft={attrDraft} onDraftChange={updateAttr} />
          </CardContent>
        </Card>
      </div>

      {productType === "PERSONALIZED" && (
        <div hidden={tab !== "variants"} className="mt-8">
          <Card>
            <CardHeader>
              <CardTitle>Personalization fields</CardTitle>
            </CardHeader>
            <CardContent>
              <ProductCustomizationManager productId={null} fields={[]} drafts={fieldDrafts} onDraftsChange={updateFields} />
            </CardContent>
          </Card>
        </div>
      )}

      <div id="tab-panel-media" role="tabpanel" aria-labelledby="tab-media" hidden={tab !== "media"} className="mt-8 space-y-8">
        <Card>
          <CardHeader>
            <CardTitle>Images</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <GalleryImageUploader
              images={images}
              onUpload={(uploaded) => {
                const base = imagesRef.current;
                const added = uploaded.map<GalleryImage>((u, i) => ({
                  id: crypto.randomUUID(),
                  url: u.url,
                  publicId: u.publicId,
                  isMain: base.length === 0 && i === 0,
                }));
                updateImages([...base, ...added]);
              }}
              onRemove={(id) => {
                const removed = imagesRef.current.find((i) => i.id === id);
                // Never attached to a product → delete the orphaned asset (the action re-checks that nothing references it).
                if (removed?.publicId && !persistedUrls.current.has(removed.url)) {
                  void discardUnsavedUploadAction(removed.publicId, removed.url);
                }
                const remaining = imagesRef.current.filter((i) => i.id !== id);
                updateImages(remaining.some((i) => i.isMain) || remaining.length === 0 ? remaining : remaining.map((i, n) => ({ ...i, isMain: n === 0 })));
              }}
              onSetMain={(id) => updateImages(imagesRef.current.map((i) => ({ ...i, isMain: i.id === id })))}
              onReorder={(ids) =>
                updateImages(ids.map((id) => imagesRef.current.find((i) => i.id === id)).filter((i): i is GalleryImage => i !== undefined))
              }
            />
            <p className="text-xs text-muted-foreground">Images are attached to the product when you publish it. Removing one here also deletes the uploaded file.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export function ProductCreateFlow(props: { categories: Categories; defs: AttributeDefs }) {
  return (
    <ProductEditorDirtyProvider>
      <CreateInner {...props} />
    </ProductEditorDirtyProvider>
  );
}
