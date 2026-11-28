import Link from "next/link";

const LINKS = [
  { href: "/admin/fraud", label: "Review queue" },
  { href: "/admin/fraud/customers", label: "Customer lookup" },
  { href: "/admin/fraud/lists", label: "Block & allow lists" },
  { href: "/admin/fraud/reports", label: "Reports" },
  { href: "/admin/fraud/settings", label: "Settings" },
];

export function FraudNav({ active }: { active: string }) {
  return (
    <nav className="flex flex-wrap gap-2 border-b border-border/70 pb-3 text-sm">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={`rounded-md px-3 py-1.5 ${l.href === active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
