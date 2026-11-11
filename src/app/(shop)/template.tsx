/**
 * Re-mounts on every storefront navigation, giving each page a light CSS
 * entrance (see `.rise-in` in globals.css). Server component, no JS, and
 * disabled automatically for visitors who prefer reduced motion.
 */
export default function ShopTemplate({ children }: { children: React.ReactNode }) {
  return <div className="rise-in">{children}</div>;
}
