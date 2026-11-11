"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Address } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddressFormDialog } from "@/features/account/address-form-dialog";
import { deleteAddressAction, setDefaultAddressAction } from "@/server/actions/account.actions";

export function AddressCard({ address }: { address: Address }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      await deleteAddressAction(address.id);
      router.refresh();
    });
  }

  function handleSetDefault() {
    startTransition(async () => {
      await setDefaultAddressAction(address.id);
      toast.success("Default address updated");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-xl border border-border/70 p-4">
      <div className="flex items-center justify-between">
        <p className="font-medium">{address.fullName}</p>
        {address.isDefault && <Badge variant="secondary">Default</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">
        {address.line1}
        {address.line2 && `, ${address.line2}`}
        <br />
        {address.city}
        {address.state ? `, ${address.state}` : ""} {address.postalCode}
        <br />
        {address.country} · {address.phone}
      </p>
      <div className="flex gap-2 pt-1">
        <AddressFormDialog
          address={address}
          trigger={<Button size="sm" variant="outline">Edit</Button>}
        />
        {!address.isDefault && (
          <Button size="sm" variant="ghost" onClick={handleSetDefault} disabled={isPending}>
            Set as default
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={handleDelete} disabled={isPending} className="text-destructive">
          Delete
        </Button>
      </div>
    </div>
  );
}
