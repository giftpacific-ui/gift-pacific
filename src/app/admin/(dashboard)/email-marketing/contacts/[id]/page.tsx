import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/current-user";
import { adminGetEmailContactDetail } from "@/server/services/email-contact-admin.service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ContactActiveButton } from "@/features/admin/email-contacts/contact-active-button";
import { ContactConsentPanel } from "@/features/admin/email-contacts/contact-consent-panel";
import {
  CONSENT_SOURCE_LABEL, CONSENT_STATUS_LABEL, INELIGIBLE_LABEL, SOURCE_LABEL, SUPPRESSION_LABEL, UNSUBSCRIBE_SOURCE_LABEL, csvSafe,
} from "@/lib/email-contacts";

export const metadata: Metadata = { title: "Contact · Email marketing · Admin" };

const when = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso)) + " UTC";
const WHY: Record<string, string> = {
  suppressed: "This address is suppressed, so it will not receive marketing e-mail. A suppression cannot be lifted from this page.",
  inactive: "The contact is inactive. Activate it to make it eligible again, if it has consent and no suppression.",
  no_consent: "There is no current marketing consent on file. Only a new, explicit opt-in can change that.",
  no_contact: "There is no contact record for this address.",
  invalid_email: "The address is not valid.",
  unverifiable: "Eligibility could not be verified right now, so the contact is treated as not eligible.",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-1 py-2 sm:grid-cols-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-words text-sm sm:col-span-2">{children}</dd></div>;
}

export default async function EmailContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;
  const c = await adminGetEmailContactDetail(admin.id, id);
  if (!c) notFound();
  const reason = c.eligibility.eligible ? null : c.eligibility.reason;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button asChild variant="link" className="h-auto p-0"><Link href="/admin/email-marketing/contacts">← All contacts</Link></Button>
          <h1 className="break-all font-heading text-2xl">{csvSafe(c.name) || csvSafe(c.email)}</h1>
          {c.name && <p className="break-all text-sm text-muted-foreground">{csvSafe(c.email)}</p>}
        </div>
        <ContactActiveButton contactId={c.id} isActive={c.isActive} size="default" />
      </div>

      <Card>
        <CardContent className="space-y-2 p-5">
          <h2 className="font-heading text-lg">Marketing eligibility</h2>
          <div className="flex flex-wrap items-center gap-2">
            {c.eligibility.eligible ? <Badge variant="success">Eligible</Badge> : <Badge variant="outline">Not eligible</Badge>}
            <Badge variant={c.consentStatus === "given" ? "success" : c.consentStatus === "unsubscribed" ? "destructive" : "secondary"}>{CONSENT_STATUS_LABEL[c.consentStatus]}</Badge>
            <Badge variant={c.isActive ? "success" : "secondary"}>{c.isActive ? "Active" : "Inactive"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {reason ? (WHY[reason] ?? INELIGIBLE_LABEL[reason] ?? "Not eligible.") : "Active, with current explicit consent and no suppression. This is decided by the eligibility check every time mail is considered."}
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <h2 className="font-heading text-lg">Contact information</h2>
            <dl className="divide-y divide-border/60">
              <Row label="Email">{csvSafe(c.email)}</Row>
              <Row label="Name">{csvSafe(c.name) || "—"}</Row>
              <Row label="Original source">{SOURCE_LABEL[c.source] ?? c.source}</Row>
              <Row label="Status">{c.isActive ? "Active" : "Inactive"}</Row>
              <Row label="Added">{when(c.createdAt)}</Row>
              <Row label="Added by">{c.createdBy ? csvSafe(c.createdBy) : "System / the customer"}</Row>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <h2 className="font-heading text-lg">Linked customer</h2>
            {c.customer ? (
              <dl className="divide-y divide-border/60">
                <Row label="Name">{csvSafe(c.customer.name)}</Row>
                <Row label="Account email">{csvSafe(c.customer.email)}</Row>
                <Row label="Profile"><Link className="underline" href={`/admin/customers/${c.customer.id}`}>Open customer</Link></Row>
              </dl>
            ) : <p className="pt-2 text-sm text-muted-foreground">Not linked to a customer account. Being a customer never counts as marketing consent.</p>}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="font-heading text-lg">Marketing consent</h2>
          <p className="text-sm text-muted-foreground">Current status: <strong>{CONSENT_STATUS_LABEL[c.consentStatus]}</strong>.</p>
          <ContactConsentPanel contactId={c.id} hasOpenConsent={c.consents.some((k) => k.open)} suppressed={Boolean(c.suppression?.active)} isActive={c.isActive} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="font-heading text-lg">Suppression</h2>
          {!c.suppression ? <p className="text-sm text-muted-foreground">This address has never been suppressed.</p> : (
            <dl className="divide-y divide-border/60">
              <Row label="Status">{c.suppression.active ? <Badge variant="destructive">Active</Badge> : <Badge variant="secondary">Lifted</Badge>}</Row>
              <Row label="Reason">{SUPPRESSION_LABEL[c.suppression.reason] ?? c.suppression.reason}</Row>
              {c.suppression.note && <Row label="Note">{csvSafe(c.suppression.note)}</Row>}
              <Row label="Suppressed">{when(c.suppression.createdAt)}</Row>
              {c.suppression.liftedAt && <Row label="Lifted">{when(c.suppression.liftedAt)}</Row>}
            </dl>
          )}
          <p className="text-xs text-muted-foreground">Suppressions can only end through the person&apos;s own new opt-in; there is no way to remove one from this page.</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="font-heading text-lg">Consent history</h2>
          {c.consents.length === 0 ? <p className="text-sm text-muted-foreground">No marketing consent has ever been recorded for this contact.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-150 text-sm">
                <thead className="border-b border-border/70 text-left text-muted-foreground"><tr><th className="p-2">Given</th><th className="p-2">Source</th><th className="p-2">Evidence</th><th className="p-2">Recorded by</th><th className="p-2">Ended</th></tr></thead>
                <tbody>
                  {c.consents.map((k) => (
                    <tr key={k.id} className="border-b border-border/50 align-top last:border-0">
                      <td className="whitespace-nowrap p-2">{when(k.grantedAt)} {k.open && <Badge variant="success">Current</Badge>}</td>
                      <td className="p-2">{CONSENT_SOURCE_LABEL[k.source] ?? k.source}</td>
                      <td className="max-w-80 break-words p-2">{csvSafe(k.evidence) || "—"}</td>
                      <td className="p-2">{k.recordedBy ? csvSafe(k.recordedBy) : "—"}</td>
                      <td className="p-2">{k.unsubscribedAt ? `${when(k.unsubscribedAt)}${k.unsubscribeSource ? ` (${UNSUBSCRIBE_SOURCE_LABEL[k.unsubscribeSource] ?? k.unsubscribeSource})` : ""}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Consent history is append-only. Rows are never edited or deleted.</p>
        </CardContent>
      </Card>
    </div>
  );
}
