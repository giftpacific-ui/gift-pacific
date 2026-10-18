import type { Metadata } from 'next';
import ShopSection from '@/components/ShopSection';
import { products } from '@/data/products';

export const metadata: Metadata = {
  title: 'শপ কালেকশন — Gift Pacific',
  description:
    'আমাদের সম্পূর্ণ গিফট কালেকশন: রেডিমেড কম্বো প্যাক এবং একক হ্যান্ডমেড উপাদান।',
};

export default function ShopPage() {
  return (
    <main className="py-6">
      <ShopSection products={products} />
    </main>
  );
}
