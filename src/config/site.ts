export const siteConfig = {
  name: "Gift Pacific",
  shortName: "Gift Pacific",
  version: "V1.0.0",
  release: "V1",
  description:
    "জন্মদিন, বার্ষিকী বা যেকোনো বিশেষ মুহূর্তের জন্য বাছাই করা উপহার, গিফট বক্স ও কাস্টমাইজড কম্বো। প্রিয়জনের জন্য সঠিক উপহারটি খুঁজে নিন Gift Pacific-এ।",
  // One production origin for canonicals, sitemaps, robots and Open Graph. Trailing slashes are removed so no URL gets "//".
  url: (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  // No default logo: the previous logo asset belonged to the discontinued brand and was removed. Until a Gift Pacific
  // logo is uploaded in Admin → Settings, every surface falls back to the text wordmark (the store name).
  logoUrl: "",
  currency: process.env.NEXT_PUBLIC_CURRENCY ?? "BDT",
  currencySymbol: process.env.NEXT_PUBLIC_CURRENCY_SYMBOL ?? "৳",
  // NOTE: social links and navigation categories are NOT hard-coded here.
  // Social URLs come from Admin → Settings (shown only when set) and the
  // category navigation comes from the database, so the storefront never links
  // to generic placeholder accounts or to categories that don't exist.
} as const;
