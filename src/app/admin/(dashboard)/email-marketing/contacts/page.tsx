import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminGetEmailContactStats, adminListEmailContacts } from "@/server/services/email-contact-admin.service";
import { Pagination } from "@/components/shared/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AddContactDialog } from "@/features/admin/email-contacts/add-contact-dialog";
import { ContactsTable } from "@/features/admin/email-contacts/contacts-table";
import { ImportCsvDialog } from "@/features/admin/email-contacts/import-csv-dialog";
import { CONTACT_FILTERS } from "@/lib/email-contacts";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Contacts · Email marketing · Admin" };

export default async function EmailContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin(); // the layout redirects too, but a page must not rely on that to protect its own data
  const sp = await searchParams;
  const [stats, list] = await Promise.all([
    adminGetEmailContactStats(admin.id),
    adminListEmailContacts(admin.id, { q: sp.q, filter: sp.filter, page: sp.page }),
  ]);
  const hrefFor = (filter: string) => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("filter", filter);
    if (list.q) params.set("q", list.q);
    const qs = params.toString();
    return `/admin/email-marketing/contacts${qs ? `?${qs}` : ""}`;
  };
  const cards = [
    { label: "Total contacts", value: stats.total },
    { label: "Eligible subscribers", value: stats.eligible, note: stats.eligibleChecked ? undefined : "Estimate: the first 500 were individually checked" },
    { label: "Unsubscribed", value: stats.unsubscribed },
    { label: "Suppressed", value: stats.suppressed, note: "Bounced, complained or blocked" },
    { label: "Inactive", value: stats.inactive },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Contacts</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            People who can be sent marketing e-mail. A contact is eligible only with explicit consent, no suppression and an active record. Adding or importing an address never grants consent, and suppressions cannot be lifted here.
          </p>
        </div>
        <div className="flex flex-wrap gap-2"><ImportCsvDialog /><AddContactDialog /></div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <div className="text-xs uppercase text-muted-foreground">{c.label}</div>
              <div className="text-2xl font-semibold">{c.value.toLocaleString("en-US")}</div>
              {c.note && <div className="text-xs text-muted-foreground">{c.note}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      <nav aria-label="Contact filters" className="flex gap-2 overflow-x-auto pb-1">
        {CONTACT_FILTERS.map((f) => (
          <Link key={f.value} href={hrefFor(f.value)} aria-current={list.filter === f.value ? "page" : undefined}
            className={cn("whitespace-nowrap rounded-full border px-3 py-1.5 text-sm", list.filter === f.value ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-secondary")}>
            {f.label}
          </Link>
        ))}
      </nav>

      <form method="get" className="flex flex-wrap items-center gap-2">
        {list.filter !== "all" && <input type="hidden" name="filter" value={list.filter} />}
        <Input name="q" defaultValue={list.q} maxLength={100} placeholder="Search name or email" className="w-full sm:w-80" aria-label="Search contacts" />
        <Button type="submit" variant="outline"><Search /> Search</Button>
        {list.q && <Button asChild variant="ghost"><Link href={list.filter === "all" ? "/admin/email-marketing/contacts" : `/admin/email-marketing/contacts?filter=${list.filter}`}>Clear</Link></Button>}
      </form>

      <p className="text-sm text-muted-foreground" aria-live="polite">{list.total.toLocaleString("en-US")} contact{list.total === 1 ? "" : "s"}</p>
      <ContactsTable rows={list.rows} />
      <Pagination page={list.page} pageCount={list.pageCount} basePath="/admin/email-marketing/contacts" searchParams={{ filter: list.filter === "all" ? undefined : list.filter, q: list.q || undefined }} />
    </div>
  );
}
