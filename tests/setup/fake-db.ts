/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A small in-memory stand-in for the Prisma client, used so the REAL service
 * code (cart, order, admin product, inventory…) can run in unit tests
 * without PostgreSQL.
 *
 * What it models faithfully: where-filters (equality, gt/gte/lt/lte/in/not,
 * AND/OR/NOT, relation `some`), increment/decrement, updateMany/deleteMany
 * counts (which is what the atomic "stock >= qty" guards rely on), unique
 * constraints (P2002), include of relations, and interactive transactions
 * with rollback-on-throw.
 *
 * What it does NOT model: real row locks / isolation levels. Transactions
 * are serialized (a mutex), so these tests check the LOGIC of the guarded
 * updates, not PostgreSQL's concurrency behavior. See tests/integration for
 * the real-database variant (requires TEST_DATABASE_URL).
 */
type Row = Record<string, any>;
type Rel = { kind: "one" | "many"; target: string; fk: string };

const ENUM_ORDER: Record<string, string[]> = { kind: ["SINGLE", "COMBO"] };

const RELATIONS: Record<string, Record<string, Rel>> = {
  cart: { items: { kind: "many", target: "cartItem", fk: "cartId" } },
  cartItem: {
    product: { kind: "one", target: "product", fk: "productId" },
    variant: { kind: "one", target: "productVariant", fk: "variantId" },
    selections: { kind: "many", target: "cartItemSelection", fk: "cartItemId" },
  },
  product: {
    images: { kind: "many", target: "productImage", fk: "productId" },
    variants: { kind: "many", target: "productVariant", fk: "productId" },
    customizationFields: { kind: "many", target: "productCustomizationField", fk: "productId" },
    bundleItems: { kind: "many", target: "productBundleItem", fk: "bundleId" },
    comboSlots: { kind: "many", target: "comboSlot", fk: "comboId" },
        attributeValues: { kind: "many", target: "productAttributeValue", fk: "productId" },
    attributeOptions: { kind: "many", target: "productAttributeOption", fk: "productId" },
    category: { kind: "one", target: "category", fk: "categoryId" },
    reviews: { kind: "many", target: "review", fk: "productId" },
    collections: { kind: "many", target: "productCollection", fk: "productId" },
  },
  stockAdjustment: { variant: { kind: "one", target: "productVariant", fk: "variantId" } },
  wishlist: { items: { kind: "many", target: "wishlistItem", fk: "wishlistId" } },
  wishlistItem: { product: { kind: "one", target: "product", fk: "productId" } },
  collection: { products: { kind: "many", target: "productCollection", fk: "collectionId" } },
  productCollection: { product: { kind: "one", target: "product", fk: "productId" } },
  review: {
    user: { kind: "one", target: "user", fk: "userId" },
    product: { kind: "one", target: "product", fk: "productId" },
    orderItem: { kind: "one", target: "orderItem", fk: "orderItemId" },
    events: { kind: "many", target: "reviewModerationEvent", fk: "reviewId" },
  },
  productVariant: { product: { kind: "one", target: "product", fk: "productId" } },
  productBundleItem: {
    component: { kind: "one", target: "product", fk: "componentId" },
    variant: { kind: "one", target: "productVariant", fk: "variantId" },
  },
    orderItemComponent: {
    orderItem: { kind: "one", target: "orderItem", fk: "orderItemId" },
    product: { kind: "one", target: "product", fk: "productId" },
    variant: { kind: "one", target: "productVariant", fk: "variantId" },
  },
            teamMember: {},
  box: { product: { kind: "one", target: "product", fk: "productId" } },
  orderCostLine: {},
  expense: {},
  salesChannel: {},
  oAuthAccount: { user: { kind: "one", target: "user", fk: "userId" } },
  attributeGroup: { attributes: { kind: "many", target: "attribute", fk: "groupId" } },
  attribute: {
    group: { kind: "one", target: "attributeGroup", fk: "groupId" },
    options: { kind: "many", target: "attributeOption", fk: "attributeId" },
  },
  attributeOption: {},
  productAttributeValue: {
    attribute: { kind: "one", target: "attribute", fk: "attributeId" },
    product: { kind: "one", target: "product", fk: "productId" },
  },
  productAttributeOption: {
    attribute: { kind: "one", target: "attribute", fk: "attributeId" },
    option: { kind: "one", target: "attributeOption", fk: "optionId" },
  },
  jobPost: {
    questions: { kind: "many", target: "jobQuestion", fk: "jobPostId" },
    applications: { kind: "many", target: "jobApplication", fk: "jobPostId" },
  },
  jobApplication: {
    job: { kind: "one", target: "jobPost", fk: "jobPostId" },
    answers: { kind: "many", target: "jobApplicationAnswer", fk: "applicationId" },
  },
  comboSlot: { options: { kind: "many", target: "comboSlotOption", fk: "slotId" } },
  comboSlotOption: {
    product: { kind: "one", target: "product", fk: "productId" },
    variant: { kind: "one", target: "productVariant", fk: "variantId" },
  },
  order: {
    items: { kind: "many", target: "orderItem", fk: "orderId" },
    trackingEvents: { kind: "many", target: "orderTrackingEvent", fk: "orderId" },
    coupon: { kind: "one", target: "coupon", fk: "couponId" },
    shippingAddress: { kind: "one", target: "address", fk: "shippingAddressId" },
    billingAddress: { kind: "one", target: "address", fk: "billingAddressId" },
    costLines: { kind: "many", target: "orderCostLine", fk: "orderId" },
    channel: { kind: "one", target: "salesChannel", fk: "channelId" },
    payments: { kind: "many", target: "payment", fk: "orderId" },
    settlements: { kind: "many", target: "marketplaceSettlement", fk: "orderId" },
  },
  payment: { order: { kind: "one", target: "order", fk: "orderId" } },
  gatewayTransaction: {
    order: { kind: "one", target: "order", fk: "orderId" },
    refunds: { kind: "many", target: "gatewayRefund", fk: "transactionId" },
  },
  gatewayRefund: { transaction: { kind: "one", target: "gatewayTransaction", fk: "transactionId" } },
  marketplaceSettlement: { order: { kind: "one", target: "order", fk: "orderId" } },
  orderItem: {
        product: { kind: "one", target: "product", fk: "productId" },
    order: { kind: "one", target: "order", fk: "orderId" },
    components: { kind: "many", target: "orderItemComponent", fk: "orderItemId" },
  },
};

const UNIQUES: Record<string, (string | string[])[]> = {
  productCollection: [["productId", "collectionId"]],
  collection: ["slug"],
  review: [["userId", "productId"], "orderItemId"],
  notification: [["userId", "dedupeKey"]],
  order: ["orderNumber", "confirmationToken", ["channelId", "externalOrderRef"]],
  oAuthAccount: [["provider", "providerAccountId"], ["userId", "provider"]],
  salesChannel: ["key"],
  payment: [["method", "providerRef"]],
  gatewayTransaction: ["merchantInvoiceNumber", "providerPaymentId", "paymentId"],
  gatewayRefund: ["idempotencyKey"],
  marketplaceSettlement: ["idempotencyKey", ["orderId", "reference"]],
  financialIncident: ["idempotencyKey"],
  procurementReceipt: ["idempotencyKey"],
  stockAdjustment: ["idempotencyKey"],
  box: ["slug"],
  customerReward: ["orderId"],
  productVariant: ["sku"],
  product: ["slug"],
  coupon: ["code"],
  productCustomizationField: [],
};

const DEFAULTS: Record<string, () => Row> = {
  // Real PostgreSQL defaults (User.isActive @default(true)); the fake would otherwise leave them undefined.
  user: () => ({ isActive: true, emailVerified: null, passwordHash: null }),
  product: () => ({
    stock: 0, allowBackorder: false, trackInventory: true, status: "DRAFT", type: "STANDARD",
    lowStockThreshold: 5, badges: [], currency: "BDT", isFeatured: false,
    costPrice: null, isBoxProduct: false, procurementPending: 0, procurementLimit: null, backorderNote: null, kind: "SINGLE", comboMode: null, comboPricing: null, comboStockPolicy: null,
  }),
  productVariant: () => ({ stock: 0, allowBackorder: false, isDefault: false, procurementPending: 0, procurementLimit: null }),
  cartItem: () => ({ quantity: 1, customization: null, variantId: null }),
      attributeGroup: () => ({ sortOrder: 0, isActive: true }),
  attribute: () => ({ unit: null, minNumber: null, maxNumber: null, maxLength: null, isRequired: false, isFilterable: false, showOnProduct: true, sortOrder: 0, isActive: true }),
  attributeOption: () => ({ sortOrder: 0 }),
    oAuthAccount: () => ({ emailAtLink: null, emailVerifiedByProvider: false, lastLoginAt: null }),
  marketplaceSettlement: () => ({ reference: null, idempotencyKey: null, note: null, legacyAssumed: false, recordedById: null }),
  payment: () => ({ kind: "FULL", customerReference: null, providerRef: null, verifiedById: null, verifiedAt: null, currency: "BDT" }),
  financialIncident: () => ({ idempotencyKey: null, quantity: 0, stockEffect: "NONE", lossAmount: 0, refundAmount: 0, courierFee: 0, orderId: null, orderItemId: null }),
  customerReward: () => ({ status: "AVAILABLE", maxDiscount: null, minOrderAmount: 0, stackable: true, expiresAt: null, usedOrderId: null, usedAt: null }),
  box: () => ({ description: null, imageUrl: null, imagePublicId: null, price: 0, sortOrder: 0, isActive: true, productId: null, seoTitle: null, seoDescription: null, seoKeywords: [] }),
  teamMember: () => ({ bio: null, imageUrl: null, imageCloudinaryPublicId: null, sortOrder: 0, isPublished: false }),
  jobPost: () => ({ department: null, location: null, employmentType: null, requirements: null, status: "DRAFT", closesAt: null }),
  jobQuestion: () => ({ kind: "TEXT", options: [], isRequired: false, sortOrder: 0 }),
  jobApplication: () => ({ phone: null, coverNote: null, portfolioUrl: null, status: "NEW", adminNote: null }),
  cartItemSelection: () => ({ quantity: 1 }),
  comboSlot: () => ({ minSelect: 1, maxSelect: 1, maxPerOption: 1, sortOrder: 0, helpText: null, source: "MANUAL", categoryId: null }),
  comboSlotOption: () => ({ priceDelta: 0, variantId: null, sortOrder: 0 }),
  stockAdjustment: () => ({ variantId: null, kind: null, sourceType: null, sourceId: null, idempotencyKey: null, createdById: null }),
  orderItemComponent: () => ({ procurementQty: 0, procurementReceivedQty: 0, stockReturnedQty: 0, stockDiscardedQty: 0, stockDeducted: 0, stockRestoredAt: null, variantId: null, variantName: null, slotLabel: null, unitCost: null }),
  review: () => ({ status: "PENDING", orderItemId: null, isApproved: false, rejectedAt: null }),
  reviewModerationEvent: () => ({ actorId: null, note: null }),
    salesChannel: () => ({ isActive: true }),
  orderCostLine: () => ({ note: null, enteredById: null }),
  expense: () => ({ channelId: null, note: null }),
  order: () => ({ settlementStatus: "NOT_APPLICABLE", settledAt: null, advanceRequired: 0, advancePaid: 0, trustScore: null, trustSnapshot: null, advanceWaivedById: null, advanceWaivedReason: null, advanceWaivedAt: null, trustReviewRequired: false, trustReviewedById: null, trustReviewedAt: null, trustReviewNote: null, deliveryDiscount: 0, channelId: "channel_website", externalOrderRef: null, externalPlacedAt: null, fulfillmentMode: "SELF_SHIP", createdById: null, status: "PENDING", paymentStatus: "UNPAID", courierBookingStatus: "NOT_BOOKED", courierBookingStartedAt: null, courierLastStatus: null, courierLastError: null, courierConsignmentId: null, confirmationToken: `c${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}` }),
  orderItem: () => ({ stockReturnedQty: 0, stockDiscardedQty: 0, stockDeducted: 0, procurementQty: 0, procurementReceivedQty: 0, stockRestoredAt: null, variantId: null, unitCost: null, comboSnapshot: null }),
  coupon: () => ({ usageCount: 0, isActive: true }),
  productImage: () => ({ isMain: false, sortOrder: 0, cloudinaryPublicId: null }),
  productCustomizationField: () => ({ isRequired: true, options: [], maxLength: null, sortOrder: 0 }),
  productBundleItem: () => ({ quantity: 1, variantId: null }),
};

const clone = <T,>(v: T): T => structuredClone(v);
const arr = (v: any) => (Array.isArray(v) ? v : [v]);
const isOpObject = (v: any) =>
  v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);

const same = (a: any, b: any) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null);

function cond(val: any, v: any): boolean {
  if (!isOpObject(v)) return same(val, v);
  const ci = v.mode === "insensitive";
  const low = (x: any) => (ci && typeof x === "string" ? x.toLowerCase() : x);
  return Object.entries(v).every(([op, arg]: [string, any]) => {
    switch (op) {
      case "equals": return same(low(val), low(arg));
      case "not": return isOpObject(arg) ? !cond(val, arg) : !same(val, arg);
      case "in": return arg.includes(val);
      case "notIn": return !arg.includes(val);
      case "gt": return val > arg;
      case "gte": return val >= arg;
      case "lt": return val < arg;
      case "lte": return val <= arg;
      case "contains": return String(val ?? "").toLowerCase().includes(String(arg).toLowerCase());
      case "mode": return true;
      case "has": return Array.isArray(val) && val.includes(arg);
      case "hasSome": return Array.isArray(val) && arg.some((a: any) => val.includes(a));
      default: throw new Error(`fake-db: unsupported operator ${op}`);
    }
  });
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  private counter = 0;
  private seqValue = 0;
  private lock: Promise<void> = Promise.resolve();
  /** Every status of every `order` update, for assertions. */
  log: string[] = [];

  [key: string]: any;

  constructor() {
    const names = new Set<string>([
      ...Object.keys(RELATIONS),
      ...Object.values(RELATIONS).flatMap((r) => Object.values(r).map((x) => x.target)),
      "user", "address", "category", "orderTrackingEvent", "storeSettings", "wishlist", "wishlistItem", "coupon", "review", "stockAdjustment", "banner", "customerReward", "financialIncident", "payment", "marketplaceSettlement", "adminAuditEvent", "procurementReceipt", "productImage", "orderItemComponent", "notification", "courierCodEntry", "slugRedirect",
    ]);
    for (const n of names) {
      this.tables[n] = [];
      Object.defineProperty(this, n, { get: () => this.delegate(n), enumerable: false });
    }
  }

  insert(table: string, row: Row): Row {
    return this.create(table, row, true);
  }
  rows(table: string): Row[] {
    return clone(this.tables[table]);
  }
  /** Deletes the rows of `table` matching `pred` (test setup only). */
  remove(table: string, pred: (row: Row) => boolean): void {
    const rows = this.tables[table];
    for (let i = rows.length - 1; i >= 0; i--) if (pred(rows[i])) rows.splice(i, 1);
  }
  /** Changes fields of a LIVE row. (`get()` returns a copy: assigning to it changes nothing.) */
  patch(table: string, id: string, fields: Row): void {
    const r = this.tables[table].find((x) => x.id === id);
    if (!r) throw new Error(`fake-db: ${table}/${id} missing`);
    Object.assign(r, fields);
  }
  get(table: string, id: string): Row {
    const r = this.tables[table].find((x) => x.id === id);
    if (!r) throw new Error(`fake-db: ${table}/${id} missing`);
    return clone(r);
  }

  // ---- matching ----
  private match(table: string, row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, v]: [string, any]) => {
      if (v === undefined) return true;
      if (k === "AND") return arr(v).every((w: Row) => this.match(table, row, w));
      if (k === "OR") return arr(v).some((w: Row) => this.match(table, row, w));
      if (k === "NOT") return !arr(v).some((w: Row) => this.match(table, row, w));
      const rel = RELATIONS[table]?.[k];
      if (rel) {
        const related = this.related(table, row, rel);
        if (rel.kind === "many") {
          if (v.some) return related.some((r) => this.match(rel.target, r, v.some));
          if (v.none) return !related.some((r) => this.match(rel.target, r, v.none));
          if (v.every) return related.every((r) => this.match(rel.target, r, v.every));
          throw new Error("fake-db: unsupported many-relation filter");
        }
        const one = related[0];
        return !!one && this.match(rel.target, one, v.is ?? v);
      }
      return cond(row[k], v);
    });
  }
  private related(table: string, row: Row, rel: Rel): Row[] {
    return rel.kind === "one"
      ? this.tables[rel.target].filter((r) => row[rel.fk] != null && r.id === row[rel.fk])
      : this.tables[rel.target].filter((r) => r[rel.fk] === row.id);
  }
  /** `select: { product: { select: ... } }` also loads that relation (projection itself is not applied). */
  private includeOf(table: string, a: Row): Row | undefined {
    if (a.include) return a.include;
    if (!a.select) return undefined;
    const inc: Row = {};
    for (const [k, v] of Object.entries(a.select) as [string, any][]) {
      if (RELATIONS[table]?.[k] && v) inc[k] = v;
    }
    return inc;
  }
  /** Prisma `omit`: the listed columns are removed from the returned row (what customer-facing projections rely on). */
  private omitKeys(row: Row, omit?: Row): Row {
    if (!omit) return row;
    for (const [k, v] of Object.entries(omit)) if (v) delete row[k];
    return row;
  }
  /** Shapes a result the way Prisma does for `include` / `select` / `omit`. */
  private shape(table: string, row: Row, a: Row): Row {
    return this.omitKeys(this.withInclude(table, row, this.includeOf(table, a)), a.omit);
  }
  private withInclude(table: string, row: Row, include?: Row): Row {
    const out = clone(row);
    if (!include) return out;
    for (const [k, spec] of Object.entries(include) as [string, any][]) {
      const rel = RELATIONS[table]?.[k];
      if (!rel || !spec) continue;
      let rows = this.related(table, row, rel);
      if (spec !== true) {
        if (spec.where) rows = rows.filter((r) => this.match(rel.target, r, spec.where));
        if (spec.orderBy) rows = this.sortRows(rows, spec.orderBy);
        if (spec.take) rows = rows.slice(0, spec.take);
        const nested = this.includeOf(rel.target, spec);
        rows = rows.map((r) => this.omitKeys(this.withInclude(rel.target, r, nested), spec.omit));
        out[k] = rel.kind === "one" ? (rows[0] ?? null) : rows;
        continue;
      }
      out[k] = rel.kind === "one" ? (clone(rows[0]) ?? null) : rows.map(clone);
    }
    return out;
  }
  private sortRows(rows: Row[], orderBy: any): Row[] {
    const specs = arr(orderBy).flatMap((o: Row) => Object.entries(o));
    return [...rows].sort((a, b) => {
      for (const [f, dir] of specs as [string, string][]) {
        // PostgreSQL orders enum columns by DECLARATION order, not alphabetically.
        const rank = ENUM_ORDER[f];
        const av = rank ? rank.indexOf(a[f]) : a[f];
        const bv = rank ? rank.indexOf(b[f]) : b[f];
        if (av < bv) return dir === "desc" ? 1 : -1;
        if (av > bv) return dir === "desc" ? -1 : 1;
      }
      return 0;
    });
  }

  // ---- mutation helpers ----
  private apply(row: Row, data: Row) {
    for (const [k, v] of Object.entries(data) as [string, any][]) {
      if (v === undefined) continue;
      if (isOpObject(v) && ("increment" in v || "decrement" in v || "set" in v)) {
        if ("increment" in v) row[k] = (row[k] ?? 0) + v.increment;
        if ("decrement" in v) row[k] = (row[k] ?? 0) - v.decrement;
        if ("set" in v) row[k] = v.set;
      } else row[k] = v;
    }
  }
  private create(table: string, data: Row, raw = false): Row {
    const row: Row = { ...(DEFAULTS[table]?.() ?? {}) };
    const nested: [Rel, any][] = [];
    for (const [k, v] of Object.entries(data) as [string, any][]) {
      const rel = RELATIONS[table]?.[k];
      if (rel && !raw) nested.push([rel, v]);
      else if (v !== undefined) row[k] = v;
    }
    row.id ??= `${table}_${++this.counter}`;
    row.createdAt ??= new Date(); // schema: createdAt @default(now())
    for (const spec of UNIQUES[table] ?? []) {
      const cols = Array.isArray(spec) ? spec : [spec];
      if (cols.every((c) => row[c] != null) && this.tables[table].some((r) => cols.every((c) => r[c] === row[c]))) {
        throw Object.assign(new Error(`Unique constraint failed on the fields: (${cols.join(",")})`), { code: "P2002" });
      }
    }
    this.tables[table].push(row);
    for (const [rel, v] of nested) {
      for (const child of arr(v.create ?? [])) this.create(rel.target, { ...child, [rel.fk]: row.id });
    }
    return row;
  }

  private delegate(table: string) {
    const self = this;
    const y = () => Promise.resolve(); // yield, so concurrent callers interleave
    const find = (where: Row) => self.tables[table].filter((r) => self.match(table, r, where));
    return {
      async findFirst(a: Row = {}) {
        await y();
        let rows = find(a.where);
        if (a.orderBy) rows = self.sortRows(rows, a.orderBy);
        return rows[0] ? self.shape(table, rows[0], a) : null;
      },
      async findUnique(a: Row) {
        await y();
        const r = find(a.where)[0];
        return r ? self.shape(table, r, a) : null;
      },
      async findUniqueOrThrow(a: Row) {
        const r = await this.findUnique(a);
        if (!r) throw Object.assign(new Error("No record found"), { code: "P2025" });
        return r;
      },
      async findMany(a: Row = {}) {
        await y();
        let rows = find(a.where);
        if (a.orderBy) rows = self.sortRows(rows, a.orderBy);
        if (a.skip) rows = rows.slice(a.skip);
        if (a.take) rows = rows.slice(0, a.take);
        return rows.map((r) => self.shape(table, r, a));
      },
            /** Only `_sum` over numeric/Decimal-like fields, which is all the app uses. */
      async aggregate(a: Row = {}) {
                await y();
        const rows = find(a.where);
        const sums: Row = {};
        for (const field of Object.keys(a._sum ?? {})) {
          const vals = rows.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
          sums[field] = vals.length === 0 ? null : vals.reduce((t: number, v: unknown) => t + Number(v), 0);
        }
        return { _sum: sums };
      },
      async count(a: Row = {}) {
        await y();
        return find(a.where).length;
      },
      async create(a: Row) {
        await y();
        return self.withInclude(table, self.create(table, a.data), self.includeOf(table, a));
      },
      /** groupBy with `by` and `_count: { _all }` only (all that the code under test uses): one row per distinct combination of the `by` fields. */
      async groupBy(a: Row) {
        await y();
        const groups = new Map<string, Row>();
        for (const r of find(a.where)) {
          const key = JSON.stringify((a.by as string[]).map((k) => r[k]));
          const g = groups.get(key) ?? { ...Object.fromEntries((a.by as string[]).map((k) => [k, r[k]])), _count: { _all: 0 } };
          g._count._all++;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
      /** createMany: one row per entry; with skipDuplicates a unique-constraint clash is skipped (ON CONFLICT DO NOTHING), as in PostgreSQL. */
      async createMany(a: Row) {
        await y();
        let count = 0;
        for (const d of arr(a.data)) {
          try { self.create(table, { ...d }, true); count++; }
          catch (e: any) { if (a.skipDuplicates && e?.code === "P2002") continue; throw e; }
        }
        return { count };
      },
      async update(a: Row) {
        await y();
        const r = find(a.where)[0];
        if (!r) throw Object.assign(new Error("Record to update not found"), { code: "P2025" });
        self.apply(r, a.data);
        return clone(r);
      },
      async updateMany(a: Row) {
        await y();
        const rows = find(a.where);
        rows.forEach((r) => self.apply(r, a.data));
        return { count: rows.length };
      },
      async upsert(a: Row) {
        await y();
        const r = find(a.where)[0];
        if (r) self.apply(r, a.update);
        const row = r ?? self.create(table, a.create);
        return self.shape(table, row, a);
      },
      async delete(a: Row) {
        await y();
        const r = find(a.where)[0];
        if (!r) throw Object.assign(new Error("Record to delete does not exist"), { code: "P2025" });
        self.tables[table] = self.tables[table].filter((x) => x !== r);
        return clone(r);
      },
      async deleteMany(a: Row = {}) {
        await y();
        const rows = find(a.where);
        self.tables[table] = self.tables[table].filter((x) => !rows.includes(x));
        return { count: rows.length };
      },
    };
  }

  async $queryRaw(strings: TemplateStringsArray) {
    await Promise.resolve();
    if (strings.join("?").includes("nextval('order_number_seq')")) {
      return [{ n: BigInt(++this.seqValue) }];
    }
    throw new Error("fake-db: unsupported raw query");
  }

  /**
   * Advisory locks (`SELECT pg_advisory_xact_lock(...)`) are no-ops here: this double already runs transactions one at a time.
   * Real lock behaviour is NOT proven by tests that use this double (see tests/integration for the real-database checks).
   */
  async $executeRaw(strings: TemplateStringsArray) {
    await Promise.resolve();
    if (strings.join("?").includes("pg_advisory_xact_lock")) return 0;
    throw new Error("fake-db: unsupported raw statement");
  }

  async $transaction(arg: any) {
    if (Array.isArray(arg)) return Promise.all(arg);
    const release = this.lock;
    let done!: () => void;
    this.lock = new Promise<void>((r) => (done = r));
    await release;
    const snapshot = clone(this.tables);
    try {
      return await arg(this);
    } catch (e) {
      this.tables = snapshot; // roll back every write made in the transaction
      throw e;
    } finally {
      done();
    }
  }
}

export function installDb(db: FakeDb) {
  (globalThis as any).__TEST_DB__ = db;
}
export function setSession(session: { sub: string } | null) {
  (globalThis as any).__TEST_SESSION__ = session;
}
export function setAdmin(isAdmin: boolean) {
  (globalThis as any).__TEST_ADMIN__ = isAdmin;
}
