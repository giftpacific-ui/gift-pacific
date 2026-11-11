import type { Metadata } from "next";

// The cart page is a client component (it cannot export metadata itself); this layout keeps it out of search results.
export const metadata: Metadata = { title: "Your cart", robots: { index: false, follow: false } };

export default function CartLayout({ children }: { children: React.ReactNode }) {
  return children;
}
