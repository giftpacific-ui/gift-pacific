import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getAddressesForCurrentUser } from "@/server/services/address.service";
import { ProfileForm } from "@/features/account/profile-form";
import { enabledProviders } from "@/lib/oauth/config";
import { getConnectedAccounts } from "@/server/services/connected-accounts.service";
import { ConnectedAccounts } from "@/features/account/connected-accounts";
import { ChangePasswordForm } from "@/features/account/change-password-form";
import { AddressFormDialog } from "@/features/account/address-form-dialog";
import { AddressCard } from "@/features/account/address-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

export const metadata: Metadata = { title: "Account Settings" };

export default async function AccountSettingsPage({ searchParams }: { searchParams: Promise<{ link?: string; tab?: string }> }) {
  const { link, tab } = await searchParams;
  const user = await getCurrentUser();
  if (!user) redirect("/login?redirect=/account/settings");
  const addresses = await getAddressesForCurrentUser();
  const connected = await getConnectedAccounts(user.id);

  return (
    <div>
      <h1 className="mb-6 font-heading text-2xl">Account Settings</h1>

      <Tabs defaultValue={tab === "addresses" ? "addresses" : "profile"}>
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="addresses">Addresses ({addresses.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-6 max-w-md space-y-8">
          <div>
            <h2 className="mb-4 font-heading text-lg">Your details</h2>
            <ProfileForm user={{ name: user.name, email: user.email, phone: user.phone }} />
          </div>
          <Separator />
          <div>
            <h2 className="mb-4 font-heading text-lg">Change password</h2>
            {connected.hasPassword ? <ChangePasswordForm /> : <p className="text-sm text-muted-foreground">You sign in with a connected account. Add a password below.</p>}
          </div>
          <Separator />
          <div>
            <h2 className="mb-4 font-heading text-lg">Connected accounts</h2>
            <ConnectedAccounts available={enabledProviders()} status={link} hasPassword={connected.hasPassword} accounts={connected.accounts.map((a) => ({ provider: a.provider, emailAtLink: a.emailAtLink, linkedAt: a.linkedAt.toISOString(), canUnlink: a.canUnlink }))} />
          </div>
        </TabsContent>

        <TabsContent value="addresses" className="mt-6">
          <div className="mb-4 flex justify-end">
            <AddressFormDialog />
          </div>
          {addresses.length === 0 ? (
            <EmptyState title="No saved addresses" description="Add an address to check out faster next time." />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {addresses.map((address) => (
                <AddressCard key={address.id} address={address} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
