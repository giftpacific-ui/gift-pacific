import { Product, BoxType, TeamMember } from "@/types";

export const DEFAULT_GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || "";

export const DELIVERY_CHARGE_INSIDE = 60;
export const DELIVERY_CHARGE_OUTSIDE = 120;

export const products: Product[] = [
  {
    id: 11,
    sku: "5pcSet01",
    slug: "royal-elegance-5-piece-stone-jewelry-set-emerald-green",
    inStock: true,
    name: "Royal Elegance – 5-Piece Stone Jewelry Set",
    nameEnglish: "The Love Box",
    price: 3299,
    oldPrice: 3499,
    tag: "Limited Edition",
    cat: "fullCombo",
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
    sku: "5pcSet02",
    slug: "royal-elegance-5-piece-stone-jewelry-set-ruby-red",
    inStock: true,
    name: "Royal Elegance – 5-Piece Stone Jewelry Set",
    nameEnglish: "The Love Box",
    price: 3299,
    oldPrice: 3499,
    tag: "Limited Edition",
    cat: "fullCombo",
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
    id: 21,
    sku: "Trdrp.p",
    slug: "pink-butterfly-zircon-pendant-set",
    inStock: true,
    name: "Pink Butterfly – Zircon Pendant Set",
    nameEnglish: "Pink Butterfly – Zircon Pendant Set",
    price: 299,
    oldPrice: 349,
    tag: "",
    cat: "miniCombo",
    img: "/img/products/combo/discount-1.png",
    desc: `স্নিগ্ধতায় সৌন্দর্য, প্রতিটি সাজে একটুখানি মুগ্ধতা।`,
    descEnglish: `A Little Sparkle, A Touch of Grace.`,
    details: `বিশেষ মুহূর্তের সাজে যোগ করুন নান্দনিকতার এক কোমল ছোঁয়া Gift Pacific এর Pink Butterfly Zircon Jewellery Set-এর সঙ্গে।

প্রজাপতির আকর্ষণীয় নকশা, সুন্দর গোলাপি জার্কন স্টোন এবং ঝলমলে সিলভার-টোন ডিটেইলিংয়ের সমন্বয়ে তৈরি এই জুয়েলারি সেটে রয়েছে একটি নেকলেস, এক জোড়া ইয়াররিং এবং একটি ম্যাচিং রিং।

পার্টি, জন্মদিন, উৎসব কিংবা বিশেষ কোনো আয়োজনে আপনার সাজকে আরও আকর্ষণীয় করে তুলতে এই Pink Butterfly Jewellery Set হতে পারে একটি সুন্দর সংযোজন।

পণ্যের বিবরণ
পণ্যের ধরন: Women's Zircon Jewellery Set
ডিজাইন: Butterfly-Inspired Design
স্টোন: Pink Zircon
রং: গোলাপি ও সিলভার-টোন ডিটেইলিং
সেটের মধ্যে রয়েছে: ১টি নেকলেস, ১ জোড়া ইয়াররিং এবং ১টি রিং
ব্যবহারের ধরন: পার্টি ও বিশেষ আয়োজনের জুয়েলারি

কেন পছন্দ করবেন?
আকর্ষণীয় প্রজাপতি নকশা।
সুন্দর গোলাপি জিরকন স্টোনের ডিটেইলিং।
নেকলেস, ইয়াররিং ও রিংয়ের সমন্বিত ডিজাইন।
পার্টি ও বিশেষ অনুষ্ঠানের সাজে মানানসই।
প্রিয়জনকে উপহার দেওয়ার জন্য সুন্দর একটি পছন্দ।

যেসব আয়োজনে মানানসই
জন্মদিন, পার্টি, উৎসব, বিশেষ অনুষ্ঠান কিংবা প্রিয়জনকে উপহার দেওয়ার জন্য।

প্রতিটি বিশেষ মুহূর্ত হয়ে উঠুক আরও সুন্দর, Gift Pacific এর সঙ্গে।
`,
    detailsEnglish: `Add a delicate touch of elegance to your special occasions with the Pink Butterfly Zircon Jewellery Set by Gift Pacific.

Designed with charming butterfly motifs, beautiful pink zircon stones and sparkling silver-tone detailing, this elegant jewellery set brings together a matching necklace, a pair of earrings and a ring. Its graceful design makes it a lovely choice for parties, celebrations and special moments.

Product Details
Product Type: Women's Zircon Jewellery Set
Design: Butterfly-Inspired Design
Stone: Pink Zircon
Color: Pink with Silver-Tone Detailing
Set Includes: 1 Necklace, 1 Pair of Earrings and 1 Ring
Style: Party Wear & Occasion Jewellery

Why You'll Love It
Beautiful pink zircon stone detailing.
Delicate and attractive butterfly design.
Coordinated necklace, earrings and matching ring.
An elegant addition to party and occasion outfits.
A thoughtful jewellery gift for someone special.

Perfect For
Birthday celebrations, parties, festive occasions, special events and gifting.

Make every special moment shine with Gift Pacific.`,
  },
  {
    id: 22,
    sku: "Trdrp.p",
    slug: "blush-teardrop-5-piece-stone-jewelry-set-pink",
    inStock: true,
    name: "Blush Teardrop – Pink Stone Pendant Set",
    nameEnglish: "Blush Teardrop – Pink Stone Pendant Set",
    price: 299,
    oldPrice: 349,
    tag: "",
    cat: "miniCombo",
    img: "/img/products/combo/discount-2.png",
    desc: ` প্রতিটি ডিটেইলে নান্দনিকতার ছোঁয়া।`,
    descEnglish: `Grace in Every Detail`,
    details: `বিশেষ মুহূর্তের সাজে যোগ করুন আভিজাত্য ও স্নিগ্ধতার সুন্দর সমন্বয় Gift Pacific-এর Blush Teardrop Pink Stone Jewellery Set-এর সঙ্গে।

পিয়ার-শেপড বা অশ্রুবিন্দু আকৃতির গোলাপি স্টোন, সূক্ষ্ম বো-ডিজাইন এবং ঝলমলে ক্রিস্টাল ডিটেইলিংয়ের সমন্বয়ে তৈরি এই জুয়েলারি সেটটি এনে দেয় এক মার্জিত ও আকর্ষণীয় লুক। সিলভার-টোন ফিনিশিংয়ের সঙ্গে গোলাপি স্টোনের সুন্দর সমন্বয় নেকলেস, ইয়াররিং ও রিংয়ের প্রতিটি অংশকে করে তুলেছে আরও নান্দনিক।

পণ্যের বিবরণ
পণ্যের ধরন: Women's Fashion Jewellery Set
ডিজাইন: Pear-Shaped / Teardrop with Bow Detailing
স্টোনের রং: ইরিডিসেন্ট গোলাপি
ফিনিশিং: সিলভার-টোন ও ক্রিস্টাল ডিটেইলিং
সেটের মধ্যে রয়েছে: ১টি নেকলেস, ১ জোড়া ইয়াররিং এবং ১টি রিং
ব্যবহারের ধরন: পার্টি ও বিশেষ আয়োজনের জুয়েলারি

কেন পছন্দ করবেন?
অশ্রুবিন্দু আকৃতির আকর্ষণীয় গোলাপি স্টোন।
সূক্ষ্ম বো-ডিজাইন ও নান্দনিক ডিটেইলিং।
মূল স্টোনের চারপাশে ঝলমলে ক্রিস্টাল অ্যাকসেন্ট।
নেকলেস, ইয়াররিং ও ম্যাচিং রিংয়ের সমন্বিত ডিজাইন।
বিশেষ অনুষ্ঠানের সাজে যোগ করবে মার্জিত সৌন্দর্য।

যেসব আয়োজনে মানানসই
জন্মদিন, পার্টি, বিয়ে, উৎসব, বিশেষ অনুষ্ঠান কিংবা প্রিয়জনকে উপহার দেওয়ার জন্য।

আপনার বিশেষ মুহূর্তের সাজে থাকুক Gift Pacific-এর নান্দনিক ছোঁয়া।
`,
    detailsEnglish: `Bring a touch of timeless elegance to your special occasions with the Blush Teardrop Pink Stone Jewellery Set by Gift Pacific.

Featuring beautiful pear-shaped pink stones, delicate bow-inspired detailing and sparkling crystal accents, this coordinated jewellery set creates a graceful and sophisticated look. The soft pink centerpiece stones are complemented by elegant silver-tone settings, making this necklace, earrings and ring combination a charming addition to your occasion wear collection.

Product Details
Product Type: Women's Fashion Jewellery Set
Design: Pear-Shaped / Teardrop with Bow Detailing
Stone Color: Iridescent Pink
Setting: Silver-Tone Finish with Crystal Accents
Set Includes: 1 Necklace, 1 Pair of Earrings and 1 Ring
Style: Elegant Party Wear & Occasion Jewellery

Why You'll Love It
Beautiful pear-shaped pink centerpiece stones.
Delicate bow-inspired design for a graceful appearance.
Sparkling crystal accents surrounding the main stones.
Coordinated necklace, earrings and matching ring.
A lovely statement accessory for special occasions.

Perfect For
Birthday celebrations, parties, weddings, festive gatherings, special events and thoughtful gifting.

Complete your special look with the elegance of Gift Pacific.`,
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
    sku: "ElgBox(01)",
    id: "b1",
    inStock: true,
    name: "Elegant Gift Box",
    price: 250,
    img: "/img/products/box/box-2.jpg",
    desc: "সুন্দর ডিজাইনের স্কয়ার শেপ বক্স, প্রিয়জনকে ভালোবাসা জানানোর জন্য সেরা।",
    details: `স্নিগ্ধ সাদা রঙ, সুন্দর সাটিন রিবন হ্যান্ডেল এবং সামনের দিকে থাকা এলিগ্যান্ট Jewelry লেখাটি বক্সটিকে দিয়েছে এক অনন্য প্রিমিয়াম লুক।`,
  },
  {
    sku: "ElgBox(02)",
    id: "b2",
    inStock: false,
    name: "Square Premium Box",
    price: 200,
    img: "/img/products/box/box-1.jpg",
    desc: "সুন্দর ডিজাইনের স্কয়ার শেপ বক্স, প্রিয়জনকে ভালোবাসা জানানোর জন্য সেরা।",
    details: `প্রিমিয়াম রিজিড কার্ডবোর্ডের তৈরি স্কয়ার শেপ বক্স। ভেতরে ভেলভেট ফিনিশ এবং সুরক্ষিত প্যাডিং রয়েছে।`,
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
