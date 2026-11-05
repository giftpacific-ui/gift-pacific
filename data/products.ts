import { Product, BoxType, TeamMember } from "@/types";

export const DEFAULT_GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || "";

export const DELIVERY_CHARGE_INSIDE = 60;
export const DELIVERY_CHARGE_OUTSIDE = 120;

export const products: Product[] = [
  {
    id: 11,
    sku:'5pcSet01',
    slug: "royal-elegance-5-piece-stone-jewelry-set-emerald-green",
    inStock: true,
    name: "Royal Elegance – 5-Piece Stone Jewelry Set",
    nameEnglish: "The Love Box",
    price: 3299,
    oldPrice: 3499,
    tag: "Limited Edition",
    cat: "combo",
    img: "/img/products/combo/necklace-combo-green.jpg",
    desc: ` এক সেটেই পূর্ণ হোক আপনার বিশেষ দিনের সাজ! \nআভিজাত্য`,
    descEnglish: `A Touch of Elegance for Every Special Moment.`,
    details: `আভিজাত্য, সৌন্দর্য আর নান্দনিকতার এক অপূর্ব সমন্বয় – নিয়ে এলাম Gift Pacific-এর *Royal Elegance 5-Piece Jewelry Set*।

ঝলমলে Diamond-Cut Zircon Stones এবং আকর্ষণীয় ডিজাইনের এই সম্পূর্ণ সেটে থাকছে:

💎 Elegant Necklace
💎 Matching Earrings
💎 Beautiful Bangles
💎 Stylish Ring
💎 Traditional Maang Tikka

❤️ *Available in Two Stunning Colors:*
🔴 Ruby Red
💚 Emerald Green

Check Ruby Red: [Royal Elegance – 5-Piece Stone Jewelry Set (Ruby Red)](/product/royal-elegance-5-piece-stone-jewelry-set-ruby-red)

বিয়ে, পার্টি, উৎসব কিংবা প্রিয় কোনো মানুষের বিশেষ মুহূর্তে নিজেকে সাজিয়ে তুলতে এই কালেকশনটি হতে পারে আপনার পছন্দের একটি সংযোজন।

🎁 নিজের জন্য হোক কিংবা প্রিয় কাউকে উপহার দেওয়ার জন্য – Gift Pacific-এর সঙ্গে প্রতিটি উপহার হয়ে উঠুক আরও বিশেষ।

*অর্ডার করতে অথবা বিস্তারিত জানতে ইনবক্স করুন।*

বিশেষ দ্রষ্টব্য: প্রদর্শিত গিফট বক্সটি নিয়মিত পণ্যের সঙ্গে অন্তর্ভুক্ত নয়। প্রয়োজন হলে আলাদাভাবে Gift Box ও Premium Gift Packaging অর্ডার করতে পারবেন।

*GIFT PACIFIC*
Make Her Feel Special.`,
    detailsEnglish: `This combo includes a handmade scented candle, a customized ceramic mug, and a personalized handwritten letter.

The best choice for gifting, featuring perfect packaging and finishing.`,
  },
  {
    id: 12,
    sku: '5pcSet02',
    slug: "royal-elegance-5-piece-stone-jewelry-set-ruby-red",
    inStock: true,
    name: "Royal Elegance – 5-Piece Stone Jewelry Set",
    nameEnglish: "The Love Box",
    price: 3299,
    oldPrice: 3499,
    tag: "Limited Edition",
    cat: "combo",
    img: "/img/products/combo/necklace-combo-red.jpg",
    desc: ` এক সেটেই পূর্ণ হোক আপনার বিশেষ দিনের সাজ! \nআভিজাত্য`,
    descEnglish: `A Touch of Elegance for Every Special Moment.`,
    details: `আভিজাত্য, সৌন্দর্য আর নান্দনিকতার এক অপূর্ব সমন্বয় – নিয়ে এলাম Gift Pacific-এর *Royal Elegance 5-Piece Jewelry Set*।

ঝলমলে Diamond-Cut Zircon Stones এবং আকর্ষণীয় ডিজাইনের এই সম্পূর্ণ সেটে থাকছে:

💎 Elegant Necklace
💎 Matching Earrings
💎 Beautiful Bangles
💎 Stylish Ring
💎 Traditional Maang Tikka

❤️ *Available in Two Stunning Colors:*
🔴 Ruby Red
💚 Emerald Green

Check Emerald Green: [Royal Elegance – 5-Piece Stone Jewelry Set (Emerald Green)](/product/royal-elegance-5-piece-stone-jewelry-set-emerald-green)

বিয়ে, পার্টি, উৎসব কিংবা প্রিয় কোনো মানুষের বিশেষ মুহূর্তে নিজেকে সাজিয়ে তুলতে এই কালেকশনটি হতে পারে আপনার পছন্দের একটি সংযোজন।

🎁 নিজের জন্য হোক কিংবা প্রিয় কাউকে উপহার দেওয়ার জন্য – Gift Pacific-এর সঙ্গে প্রতিটি উপহার হয়ে উঠুক আরও বিশেষ।

*অর্ডার করতে অথবা বিস্তারিত জানতে ইনবক্স করুন।*

বিশেষ দ্রষ্টব্য: প্রদর্শিত গিফট বক্সটি নিয়মিত পণ্যের সঙ্গে অন্তর্ভুক্ত নয়। প্রয়োজন হলে আলাদাভাবে Gift Box ও Premium Gift Packaging অর্ডার করতে পারবেন।

*GIFT PACIFIC*
Make Her Feel Special.`,
    detailsEnglish: `This combo includes a handmade scented candle, a customized ceramic mug, and a personalized handwritten letter.

The best choice for gifting, featuring perfect packaging and finishing.`,
  },
  {
    id: 2,
    sku: "Brclt(01)",
    slug: "rose-gold-ad-stone-tie-bracelet",
    inStock: true,
    name: "টাই ব্রেসলেট — রোজ গোল্ড এডি স্টোন",
    nameEnglish: "Rose Gold AD Stone Tie Bracelet",
    price: 350,
    oldPrice: 400,
    cat: "individual",
    img: "/img/products/single/ad-bracelate.jpg",
    desc: "ছোট্ট একটি জিনিস, আপনার সাজে যোগ করুক নান্দনিকতার ছোঁয়া।",
    descEnglish: "A touch of elegance for every occasion.",
    details: `GIFT PACIFIC-এর এই এলিগ্যান্ট টাই ব্রেসলেটটিতে রয়েছে আকর্ষণীয় রোজ গোল্ড বডি কালার, ঝলমলে হোয়াইট এডি স্টোন এবং স্টাইলিশ ডায়মন্ড কাট লক। এর মিনিমাল ও এস্থেটিক ডিজাইন ক্যাজুয়াল আউটফিট থেকে শুরু করে পার্টি কিংবা বিশেষ অনুষ্ঠানের সাজেও মানিয়ে যায়।

নিজের প্রতিদিনের লুককে আরও আকর্ষণীয় করতে কিংবা প্রিয় কাউকে ছোট্ট একটি উপহার দিতে এই ব্রেসলেট হতে পারে সুন্দর একটি পছন্দ।

✨ পণ্যের বিশেষত্ব
প্রোডাক্ট: টাই ব্রেসলেট
বডি কালার: রোজ গোল্ড
স্টোন: হোয়াইট এডি স্টোন
লক ডিজাইন: ডায়মন্ড কাট লক
সাইজ: ফ্রি সাইজ
ব্যবহার: ক্যাজুয়াল আউটফিট, পার্টি ও বিভিন্ন অনুষ্ঠানে
প্যাকেজিং: গিফট প্যাকেজিং সুবিধা রয়েছে
কালার: যত্ন সহকারে ব্যাবহারে ১২ মাসের কালার গ্যারান্টি

🎁 কেন বেছে নেবেন?
একটি ব্রেসলেট, নানা ধরনের সাজের সঙ্গে মানিয়ে নেওয়ার মতো ডিজাইন। নিজের জন্য হোক কিংবা প্রিয়জনকে সারপ্রাইজ দেওয়ার জন্য GIFT PACIFIC এর এই ব্রেসলেট হতে পারে আপনার পছন্দের অ্যাকসেসরিজ।

মূল্য: মাত্র ৳৩৫০

💌 অর্ডার করতে GIFT PACIFIC-এর ইনবক্সে মেসেজ করুন।
GIFT PACIFIC - উপহারে থাকুক অনুভূতির ছোঁয়া।

যত্নসহকারে ব্যবহার ও সংরক্ষণ করলে ১২ মাসের বেশি ব্যবহার করা যেতে পারে। প্রকৃত স্থায়িত্ব ব্যবহার ও যত্নের ওপর নির্ভরশীল।`,
    detailsEnglish: `Complete your look with the Rose Gold AD Stone Tie Bracelet from GIFT PACIFIC. Featuring a rose gold-tone body, sparkling white AD stones, and a stylish diamond-cut clasp, this bracelet brings a delicate, aesthetic finish to your accessory collection.

Its versatile design pairs beautifully with casual outfits, party wear, and special-occasion looks. Whether you're adding a little sparkle to your own style or choosing a thoughtful gift for someone special, this bracelet is an elegant choice.

✨ Product Highlights
Product type: Tie bracelet
Body colour: Rose gold
Stone details: White AD stones
Clasp: Diamond-cut design
Size: Free size
Style: Minimal, elegant, and aesthetic
Occasions: Everyday wear, parties, celebrations, and special events
Packaging: Gift packaging available
Colour assurance: Colour guarantee as stated by the seller

🎁 A Beautiful Addition to Your Accessory Collection
Easy to style with a variety of outfits, this bracelet is a thoughtful choice for personal wear or gifting.

Price: BDT 350

Gift it to someone special, or treat yourself.
💌 Message GIFT PACIFIC to place your order.
GIFT PACIFIC - Make Every Gift Meaningful.

Care note: The bracelet may last over 12 months with careful use. Actual lifespan depends on wear, storage, and care.`,
  },
];

export const boxTypes: BoxType[] = [
  {
    id: "b1",
    inStock: false,
    name: "Square Premium Box",
    price: 200,
    img: "/img/products/box/box-1.jpg",
    desc: "সুন্দর ডিজাইনের স্কয়ার শেপ বক্স, প্রিয়জনকে ভালোবাসা জানানোর জন্য সেরা।",
    details:
      "প্রিমিয়াম রিজিড কার্ডবোর্ডের তৈরি স্কয়ার শেপ বক্স। ভেতরে ভেলভেট ফিনিশ এবং সুরক্ষিত প্যাডিং রয়েছে।",
  },
];

export const teamMembers: TeamMember[] = [
  {
    name: "Bikrom Hossain",
    role: "Operations & Support Lead",
    desc: "অর্ডার প্রসেসিং এবং কাস্টমার সাপোর্ট হ্যান্ডেল করে নিরবচ্ছিন্ন সেবা নিশ্চিত করেন।",
    link: "https://bikuvai.vercel.app/",
    img: "/img/about/bikubuy.jpg",
    fallbackInitials: "BB",
  },
  {
    name: "Abul Hasan",
    role: "Sourcing & Inventory Lead",
    desc: "সেরা কোয়ালিটির প্রোডাক্ট সোর্সিং এবং ইনভেন্টরি ম্যানেজমেন্টের দায়িত্ব সামলান।",
    link: "#",
    img: "/img/about/abull.jpg",
    fallbackInitials: "AH",
  },
  {
    name: "Rahat Iqbal",
    role: "Marketing & SEO Lead",
    desc: "ব্র্যান্ডের ডিজিটাল প্রেজেন্স এবং মার্কেটিং স্ট্র্যাটেজি পরিচালনা করেন।",
    link: "#",
    img: "/img/about/rht.jpg",
    fallbackInitials: "RHT",
  },
  {
    name: "Muhammad Maruf",
    role: "Tech & Development Lead",
    desc: "ওয়েবসাইট ডেভেলপমেন্ট এবং টেকনিক্যাল ইনফ্রাস্ট্রাকচার ম্যানেজ করেন।",
    link: "https://muhammad-maruf.vercel.app/",
    img: "/img/about/3rudit3.jpg",
    fallbackInitials: "3E",
  },
];
