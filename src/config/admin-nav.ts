import {
  Plug,
  Award, BarChart3, Briefcase, FolderTree, Gift, Image as ImageIcon, LayoutDashboard, Mail, Megaphone,
  MessageCircleQuestion, MessageSquareText, Package, ShoppingBasket, Receipt, Settings, ShieldCheck, ShoppingCart, SlidersHorizontal, Store, Ticket,
  Truck, UserCog, Users, Wallet, Warehouse, type LucideIcon,
} from "lucide-react";

export type AdminNavItem = { href: string; label: string; icon: LucideIcon };
export type AdminNavGroup = { id: string; label: string; items: AdminNavItem[] };

/** The single source for admin navigation (sidebar, mobile drawer and breadcrumbs). */
export const ADMIN_NAV: AdminNavGroup[] = [
  { id: "overview", label: "Overview", items: [{ href: "/admin", label: "Dashboard", icon: LayoutDashboard }] },
  {
    id: "catalog",
    label: "Catalog",
    items: [
      { href: "/admin/products", label: "Products", icon: Package },
      { href: "/admin/categories", label: "Categories", icon: FolderTree },
      { href: "/admin/attributes", label: "Attributes", icon: SlidersHorizontal },
      { href: "/admin/boxes", label: "Gift boxes", icon: Gift },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    items: [
      { href: "/admin/orders", label: "Orders", icon: ShoppingCart },
      { href: "/admin/customers", label: "Customers", icon: Users },
      { href: "/admin/abandoned-carts", label: "Abandoned carts", icon: ShoppingBasket },
      { href: "/admin/coupons", label: "Coupons", icon: Ticket },
      { href: "/admin/rewards", label: "Delivery reward", icon: Award },
    ],
  },
  {
    id: "fulfilment",
    label: "Stock & delivery",
    items: [
      { href: "/admin/inventory", label: "Inventory", icon: Warehouse },
      { href: "/admin/courier", label: "Courier", icon: Truck },
      { href: "/admin/channels", label: "Sales channels", icon: Store },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    items: [
      { href: "/admin/accounts", label: "Accounts", icon: Wallet },
      { href: "/admin/advance", label: "Advance & trust", icon: ShieldCheck },
      { href: "/admin/expenses", label: "Expenses", icon: Receipt },
      { href: "/admin/reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    items: [
      { href: "/admin/campaigns", label: "Campaigns", icon: Megaphone },
      { href: "/admin/banners", label: "Banners", icon: ImageIcon },
      { href: "/admin/reviews", label: "Reviews", icon: MessageSquareText },
      { href: "/admin/questions", label: "Product questions", icon: MessageCircleQuestion },
    ],
  },
  {
    id: "company",
    label: "Company",
    items: [
      { href: "/admin/contacts", label: "Messages", icon: Mail },
      { href: "/admin/careers", label: "Careers", icon: Briefcase },
      { href: "/admin/team", label: "Team", icon: UserCog },
    ],
  },
  { id: "settings", label: "Settings", items: [{ href: "/admin/settings", label: "Store settings", icon: Settings },
      { href: "/admin/integrations", label: "Integrations", icon: Plug }] },
];

export const ADMIN_NAV_ITEMS: AdminNavItem[] = ADMIN_NAV.flatMap((g) => g.items);

/** Active when the path equals the href or is nested under it (path-boundary aware, so /admin/box never matches /admin/boxes). */
export function isAdminLinkActive(pathname: string, href: string): boolean {
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Longest matching nav item for a path (used for breadcrumbs and the active group). */
export function findAdminNavItem(pathname: string): AdminNavItem | undefined {
  return ADMIN_NAV_ITEMS.filter((i) => isAdminLinkActive(pathname, i.href)).sort((a, b) => b.href.length - a.href.length)[0];
}
