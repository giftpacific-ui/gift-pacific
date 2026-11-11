import type { Metadata } from "next";
import Link from "next/link";
import { adminListCustomers } from "@/server/services/admin-customer.service";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/shared/pagination";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Customers · Admin" };

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const { items, total, page, pageCount } = await adminListCustomers({
    search: sp.q,
    page: sp.page ? Number(sp.page) : 1,
  });

  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl">Customers ({total})</h1>

      <form className="max-w-sm">
        <Input name="q" defaultValue={sp.q} placeholder="Search by name or email…" />
      </form>

      <div className="overflow-x-auto rounded-xl border border-border/70 bg-card">
        <table className="w-full min-w-170 text-sm">
          <thead className="border-b border-border/70 text-left text-muted-foreground">
            <tr>
              <th className="p-3">Name</th>
              <th className="p-3">Email</th>
              <th className="p-3">Orders</th>
              <th className="p-3">Joined</th>
              <th className="p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((user) => (
              <tr key={user.id} className="border-b border-border/50 last:border-0 hover:bg-secondary/40">
                <td className="p-3">
                  <Link href={`/admin/customers/${user.id}`} className="font-medium hover:underline">
                    {user.name}
                  </Link>
                </td>
                <td className="p-3 text-muted-foreground">{user.email}</td>
                <td className="p-3">{user._count.orders}</td>
                <td className="p-3 text-muted-foreground">{formatDate(user.createdAt)}</td>
                <td className="p-3">
                  <Badge variant={user.isActive ? "success" : "destructive"}>
                    {user.isActive ? "Active" : "Disabled"}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} pageCount={pageCount} basePath="/admin/customers" searchParams={sp} />
    </div>
  );
}
