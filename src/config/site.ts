export const siteConfig = {
  name: "Gift Pacific",
  shortName: "Gift Pacific",
  version: "V1.0.0",
  release: "V1",
  description:
    "বাংলাদেশের সেরা প্রিমিয়াম হ্যান্ডমেড ক্রাফট ও কাস্টমাইজড কম্বো গিফট বক্স। ভালোবাসা প্রকাশের প্রতিটি মুহূর্তকে নিখুঁত ও অবিস্মরণীয় করে তুলতে আমরা বদ্ধপরিকর।.",
  // One production origin for canonicals, sitemaps, robots and Open Graph. Trailing slashes are removed so no URL gets "//".
  url: (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
    .split(",")[0]
    .trim()
    .replace(/\/+$/, ""),
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
