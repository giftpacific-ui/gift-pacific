import type { Metadata } from 'next';
import ContactSection from '@/components/ContactSection';

export const metadata: Metadata = {
  title: 'যোগাযোগ করুন — Gift Pacific',
  description:
    'আমাদের সাথে যোগাযোগ করুন। হটলাইন: +880 1971 795775, ইমেইল: giftpacific@gmail.com।',
};

export default function ContactPage() {
  return (
    <main className="py-6">
      <ContactSection />
    </main>
  );
}
