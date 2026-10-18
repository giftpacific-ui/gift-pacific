import type { Metadata } from "next";
import CustomBuilder from "@/components/CustomBuilder";
import { products, boxTypes } from "@/data/products";

export const metadata: Metadata = {
  title: "নিজে কম্বো বানান  — Gift Pacific",
  description:
    "পছন্দের বক্স বাছাই করে নিজের মতো করে কম্বো গিফট বক্স সাজান এবং ক্যাশ অন ডেলিভারিতে অর্ডার করুন।",
};

export default function CustomPage() {
  return (
    <main className="py-6">
      <CustomBuilder products={products} boxTypes={boxTypes} />
    </main>
  );
}
