import { Product, BoxType, TeamMember } from "@/types";

export const DEFAULT_GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || "";

export const DELIVERY_CHARGE_INSIDE = 80;
export const DELIVERY_CHARGE_OUTSIDE = 130;

export const products: Product[] = [
  {
    id: 1,
    name: "The Love Box",
    price: 1500,
    oldPrice: 1800,
    tag: "Bestseller",
    cat: "combo",
    img: "https://images.unsplash.com/photo-1549465220-1a8b9238cd48?q=80&w=800&auto=format&fit=crop",
    desc: "সুগন্ধি ক্যান্ডেল, কাস্টম মাগ ও ব্যক্তিগত চিঠি।",
    details:
      "এই কম্বোতে রয়েছে হ্যান্ডমেড সুগন্ধি ক্যান্ডেল, একটি কাস্টমাইজড সিরামিক মগ এবং একটি হাতে লেখা ব্যক্তিগত চিঠি। উপহারের জন্য সেরা বিকল্প। নিখুঁত প্যাকেজিং ও ফিনিশিং সহ।",
  },
  {
    id: 2,
    name: "Crafty Surprise",
    price: 2200,
    tag: "New",
    cat: "combo",
    img: "https://images.unsplash.com/photo-1513885535751-8b9238bd3dda?q=80&w=800&auto=format&fit=crop",
    desc: "প্রিমিয়াম লেদার ওয়ালেট, চাবির রিং ও চকলেট।",
    details:
      "প্রিমিয়াম কোয়ালিটির লেদার ওয়ালেট, স্টাইলিশ চাবির রিং এবং বেলজিয়ান ডার্ক চকলেটের সমাহার। প্রিয়জনকে সারপ্রাইজ দেওয়ার সেরা প্যাকেজ।",
  },
  {
    id: 3,
    name: "Memory Lane",
    price: 1800,
    cat: "combo",
    img: "https://images.unsplash.com/photo-1607344645866-009c320b63e0?q=80&w=800&auto=format&fit=crop",
    desc: "কাস্টমাইজড ফটো ফ্রেম, হ্যান্ডমেড সাবান ও ড্রাই ফ্রুটস।",
    details:
      "কাঠের তৈরি কাস্টম ফটো ফ্রেম, হ্যান্ডমেড সুগন্ধি সাবান এবং প্রিমিয়াম ড্রাই ফ্রুটসের আকর্ষণীয় বক্স। স্মৃতি ধরে রাখার নিখুঁত উপহার।",
  },
  {
    id: 4,
    name: "Hair Clipper Set",
    price: 600,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1522338242992-e1a54906a8da?q=80&w=800&auto=format&fit=crop",
    desc: "প্রিমিয়াম চুল কাটার ক্লিপার সেট।",
    details:
      "চুল ও দাড়ি ট্রিম করার জন্য প্রিমিয়াম কোয়ালিটির ক্লিপার সেট। সাথে রাখা হয়েছে আফটারশেভ লোশন ও প্রটেকশন কিট।",
  },
  {
    id: 5,
    name: "Lip Balm Trio",
    price: 450,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1599733589046-8a35aae4f4f1?q=80&w=800&auto=format&fit=crop",
    desc: "হ্যান্ডমেড ন্যাচারাল লিপবাম।",
    details:
      "সম্পূর্ণ ন্যাচারাল ও অর্গানিক উপাদানে তৈরি ৩টি ভ্যারাইটির লিপবাম সেট। ঠোঁটের সুরক্ষা ও শীতের জন্য সেরা উপহার।",
  },
  {
    id: 6,
    name: "সুগন্ধি ক্যান্ডেল",
    price: 300,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1602874801006-e26c4e6c4ab2?q=80&w=800&auto=format&fit=crop",
    desc: "হ্যান্ডমেড সুগন্ধি সয় ক্যান্ডেল।",
    details:
      "প্রিমিয়াম কোয়ালিটির হ্যান্ডমেড সুগন্ধি সয় ক্যান্ডেল। শান্ত ও মোহনীয় সুবাস ছড়িয়ে দেয় ঘরের প্রতিটি কোণে।",
  },
  {
    id: 7,
    name: "কাস্টম সিরামিক মগ",
    price: 350,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1514228742587-6b1558fcca3d?q=80&w=800&auto=format&fit=crop",
    desc: "কাস্টমাইজড সিরামিক মগ।",
    details:
      "নিজের পছন্দমতো ডিজাইন বা নাম প্রিন্ট করার উপযোগী প্রিমিয়াম গ্রেড সিরামিক মগ। মাইক্রোওয়েভ ফ্রেন্ডলি।",
  },
  {
    id: 8,
    name: "ডার্ক চকলেট বক্স",
    price: 500,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1546484959-f9a381d1330d?q=80&w=800&auto=format&fit=crop",
    desc: "প্রিমিয়াম ডার্ক চকলেট বক্স।",
    details:
      "আর্টিস্যানাল বেলজিয়ান ডার্ক চকলেটের আকর্ষণীয় বক্স। মিষ্টি ভালোবাসার অনন্য অনুভূতি তৈরি করতে অতুলনীয়।",
  },
  {
    id: 9,
    name: "হ্যান্ডমেড সাবান",
    price: 250,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1607006344380-b6775f8f10a2?q=80&w=800&auto=format&fit=crop",
    desc: "ন্যাচারাল কোল্ড-প্রেসড সাবান।",
    details:
      "সম্পূর্ণ ন্যাচারাল উদ্ভিজ্জ তেল ও এসেনশিয়াল অয়েল দিয়ে তৈরি কেমিক্যাল-মুক্ত হ্যান্ডমেড স্কিন কেয়ার সাবান।",
  },
  {
    id: 10,
    name: "কাঠের ফটো ফ্রেম",
    price: 450,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1513519245088-0e12902e5a38?q=80&w=800&auto=format&fit=crop",
    desc: "কাস্টম কাঠের ফটো ফ্রেম।",
    details:
      "প্রাকৃতিক টেক্সচারযুক্ত কাঠের তৈরি প্রিমিয়াম ফটো ফ্রেম। টেবিলটপ ও ওয়াল হ্যাংগিং উভয় ব্যবস্থার সুবিধা রয়েছে।",
  },
  {
    id: 11,
    name: "হাতে লেখা কার্ড",
    price: 100,
    cat: "individual",
    img: "https://images.unsplash.com/photo-1456406644174-8ddd5cd354ce?q=80&w=800&auto=format&fit=crop",
    desc: "ব্যক্তিগত হাতে লেখা কার্ড।",
    details:
      "আপনার প্রিয় মানুষের জন্য বিশেষ বার্তা হাতে লিখে সিলমোহর করা খামে সাজিয়ে দেওয়ার জন্য স্পেশাল কার্ড।",
  },
];

export const boxTypes: BoxType[] = [
  {
    id: "b1",
    name: "Heart Shape Box",
    price: 200,
    img: "https://images.unsplash.com/photo-1549465220-1a8b9238cd48?q=80&w=800&auto=format&fit=crop",
    desc: "সুন্দর ডিজাইনের হার্ট শেপ বক্স, প্রিয়জনকে ভালোবাসা জানানোর জন্য সেরা।",
    details:
      "প্রিমিয়াম রিজিড কার্ডবোর্ডের তৈরি হার্ট শেপ বক্স। ভেতরে ভেলভেট ফিনিশ এবং সুরক্ষিত প্যাডিং রয়েছে।",
  },
  {
    id: "b2",
    name: "Square Premium Box",
    price: 250,
    img: "https://images.unsplash.com/photo-1513885535751-8b9238bd3dda?q=80&w=800&auto=format&fit=crop",
    desc: "স্কয়ার শেপের প্রিমিয়াম গিফট বক্স।",
    details:
      "যেকোনো উৎসব, জন্মদিন বা বিশেষ দিনের উপহারের জন্য মানানসই ক্লাসিক স্কয়ার ডিজাইনের শক্ত ও দৃষ্টিনন্দন বক্স।",
  },
  {
    id: "b3",
    name: "Circle Drawer Box",
    price: 300,
    img: "https://images.unsplash.com/photo-1607344645866-009c320b63e0?q=80&w=800&auto=format&fit=crop",
    desc: "গোলাকার ড্রয়ার স্টাইলের বক্স।",
    details:
      "স্লাইডিং ড্রয়ার স্টাইলের আধুনিক গোলাকার বক্স। উপহার খোলার মুহূর্তটিকে করে তোলে অত্যন্ত আকর্ষণীয় ও স্মরণীয়।",
  },
  {
    id: "b4",
    name: "Wooden Crate Box",
    price: 400,
    img: "https://images.unsplash.com/photo-1549465220-1a8b9238cd48?q=80&w=800&auto=format&fit=crop",
    desc: "কাঠের তৈরি প্রিমিয়াম ক্রেট বক্স।",
    details:
      "অরিজিনাল হস্তশিল্পের ছোঁয়াযুক্ত কাঠের তৈরি রাস্টিক ক্রেট বক্স। পরিবেশবান্ধব এবং উপহারের পরেও স্টোরেজ হিসেবে দীর্ঘস্থায়ী।",
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
