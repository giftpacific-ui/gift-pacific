import type { Metadata } from 'next';
import OurBoxes from '@/components/OurBoxes';
import { boxTypes } from '@/data/products';

export const metadata: Metadata = {
  title: 'আমাদের বক্স — Gift Pacific',
  description:
    'প্রিমিয়াম কোয়ালিটির গিফট ও ক্রেট বক্স। শুধু বক্স কিনুন বা নিজে কাস্টমাইজ করে উপহার সাজান।',
};

export default function BoxesPage() {
  return (
    <main className="py-6">
      <OurBoxes boxTypes={boxTypes} />
    </main>
  );
}
