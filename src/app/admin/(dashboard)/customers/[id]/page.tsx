import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { adminGetCustomerById } from "@/server/services/admin-customer.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleCustomerActiveButton } from "@/features/admin/toggle-customer-active-button";
import { formatDate, formatPrice } from "@/lib/utils";
import {
  User,
  Mail,
  Phone,
  Calendar,
  ShoppingBag,
  MapPin,
  ArrowUpRight,
  PackageOpen,
} from "lucide-react";

export const metadata: Metadata = {
  title: "Customer Details · Admin Dashboard",
};

export default async function AdminCustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await adminGetCustomerById(id);
  if (!result) notFound();
  const { user, totalSpent } = result;

  return (
    <div className="max-w-5xl space-y-8 pb-16 mx-auto">
      {/* Header Info Section */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between bg-white border border-border/60 p-6 sm:p-8 rounded-3xl shadow-xs">
        <div className="flex items-center gap-4 min-w-0">
          <div className="size-16 rounded-2xl bg-primary/10 text-foreground flex items-center justify-center font-heading text-2xl font-bold shrink-0">
            {user.name ? (
              user.name.charAt(0).toUpperCase()
            ) : (
              <User className="size-8" />
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <h1 className="font-heading text-2xl font-bold text-foreground tracking-tight truncate">
              {user.name}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5 truncate">
                <Mail className="size-3.5 text-neutral-400" /> {user.email}
              </span>
              <span>•</span>
              <span className="flex items-center gap-1.5">
                <Phone className="size-3.5 text-neutral-400" />{" "}
                {user.phone ?? "No phone"}
              </span>
            </div>
          </div>
        </div>
        <div className="shrink-0 flex items-center">
          <ToggleCustomerActiveButton
            userId={user.id}
            isActive={user.isActive}
          />
        </div>
      </div>

      {/* Overview Analytics Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="rounded-3xl border-border/60 shadow-xs bg-white">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Total Orders
            </CardTitle>
            <div className="p-2 rounded-xl bg-blue-500/10 text-blue-600">
              <ShoppingBag className="size-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-heading font-bold text-foreground">
              {user.orders.length}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-border/60 shadow-xs bg-white">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Total Spent
            </CardTitle>
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600">
              <span className="font-bold text-xs">$</span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-heading font-bold text-emerald-600">
              {formatPrice(totalSpent)}
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-border/60 shadow-xs bg-white">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Member Since
            </CardTitle>
            <div className="p-2 rounded-xl bg-purple-500/10 text-purple-600">
              <Calendar className="size-4" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-base font-semibold text-foreground pt-1">
              {formatDate(user.createdAt)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Order History Section (Takes 2 cols) */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-lg font-bold text-foreground">
              Order history
            </h2>
            <span className="text-xs text-muted-foreground font-medium">
              {user.orders.length} orders placed
            </span>
          </div>

          <div className="bg-white border border-border/60 rounded-3xl p-6 shadow-xs space-y-3">
            {user.orders.length === 0 ? (
              <div className="py-12 text-center flex flex-col items-center justify-center space-y-2">
                <div className="p-3 rounded-2xl bg-secondary/60 text-muted-foreground">
                  <PackageOpen className="size-6" />
                </div>
                <p className="text-sm font-medium text-muted-foreground">
                  No orders yet from this customer.
                </p>
              </div>
            ) : (
              user.orders.map((order) => (
                <Link
                  key={order.id}
                  href={`/admin/orders/${order.id}`}
                  className="group flex items-center justify-between rounded-2xl border border-border/60 p-4 text-sm bg-neutral-50/40 hover:bg-neutral-50 hover:border-primary/40 transition-all"
                >
                  <div className="space-y-0.5">
                    <span className="font-semibold text-foreground transition-colors flex items-center gap-1.5">
                      {order.orderNumber}{" "}
                      <ArrowUpRight className="size-3.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </span>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(order.createdAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold text-foreground">
                      {formatPrice(Number(order.total))}
                    </span>
                    <Badge
                      variant="secondary"
                      className="rounded-full px-3 py-0.5 text-[10px] uppercase font-semibold"
                    >
                      {order.status.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Saved Addresses Section (Takes 1 col) */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-heading text-lg font-bold text-foreground">
              Saved addresses
            </h2>
            <span className="text-xs text-muted-foreground font-medium">
              {user.addresses.length} saved
            </span>
          </div>

          <div className="space-y-3">
            {user.addresses.length === 0 ? (
              <div className="bg-white border border-border/60 rounded-3xl p-6 text-center shadow-xs">
                <p className="text-sm text-muted-foreground py-6">
                  No saved addresses.
                </p>
              </div>
            ) : (
              user.addresses.map((address) => (
                <div
                  key={address.id}
                  className="bg-white border border-border/60 rounded-3xl p-5 shadow-xs space-y-2 text-sm"
                >
                  <div className="flex items-center gap-2 font-semibold text-foreground">
                    <MapPin className="size-4 text-primary shrink-0" />
                    <span>{address.fullName}</span>
                  </div>
                  <div className="text-muted-foreground text-xs space-y-0.5 pl-6">
                    <p>{address.line1}</p>
                    <p>
                      {address.city}, {address.postalCode}
                    </p>
                    <p className="font-medium text-foreground">
                      {address.country}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
