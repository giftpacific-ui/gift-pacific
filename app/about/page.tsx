import type { Metadata } from 'next';
import AboutSection from '@/components/AboutSection';

export const metadata: Metadata = {
  title: 'আমাদের সম্পর্কে — Gift Pacific',
  description:
    'আমাদের গল্প, উদ্দেশ্য, মান এবং Gift Pacific এর পেছনে থাকা দূরদর্শী টিম।',
};

export default function AboutPage() {
  return (
    <main className="py-6">
      <AboutSection />
    </main>
  );
}
