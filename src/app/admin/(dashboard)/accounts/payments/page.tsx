import type { Metadata } from "next";
import Link from "next/link";
import {
  getGatewayReconciliation,
  getPaymentReconciliation,
  STALE_CLAIM_HOURS,
} from "@/server/services/payment-reconciliation.service";
import { getBkashConfig } from "@/lib/payments/bkash";
import {
  GatewayRefundForm,
  RecheckButton,
  RecordAccountingButton,
  RecoverAllButton,
  ResolveRefundForm,
  SendNeverSentRefundButton,
  SyncRefundButton,
} from "@/features/admin/gateway-transaction-actions";
import { formatDate, formatPrice } from "@/lib/utils";

export const metadata: Metadata = { title: "Payment reconciliation · Admin" };
export const dynamic = "force-dynamic";

function Section({
  title,
  hint,
  empty,
  children,
  count,
}: {
  title: string;
  hint: string;
  empty: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 rounded-xl border border-border/70 bg-card p-4">
      <div>
        <h2 className="font-heading text-lg">
          {title}{" "}
          <span className="text-sm text-muted-foreground">({count})</span>
        </h2>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function PaymentReconciliationPage() {
  const [data, gateway] = await Promise.all([
    getPaymentReconciliation(),
    getGatewayReconciliation(),
  ]);
  const bkash = getBkashConfig();
  const orderLink = (o: { id: string; orderNumber: string }) => (
    <Link
      href={`/admin/orders/${o.id}`}
      className="text-primary hover:underline"
    >
      {o.orderNumber}
    </Link>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl">Payment reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Read-only checks of recorded payments. Nothing on this page changes an
          order or a payment.
        </p>
      </div>

      <section className="rounded-xl border border-border/70 bg-card p-4 text-sm">
        <h2 className="font-heading text-lg">Online wallet gateways</h2>
        <ul className="mt-2 space-y-1">
          <li>
            <span className="font-medium">bKash:</span>{" "}
            {bkash.problem
              ? `not active. ${bkash.problem}`
              : `active (${bkash.environment.toLowerCase()})`}{" "}
            <Link
              href="/admin/integrations"
              className="text-primary hover:underline"
            >
              Integration settings
            </Link>
          </li>
          <li>
            <span className="font-medium">Nagad:</span> not available. The Nagad
            integration contract has not been provided; see Integration
            settings.
          </li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Provider-confirmed payments are those bKash itself confirmed to this
          server. Money sitting at bKash with no local attempt cannot be
          detected from here (it needs a bKash statement).
        </p>
        {gateway.byStatus.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2 text-xs">
            {gateway.byStatus.map((g) => (
              <li
                key={g.status}
                className="rounded-full border border-border px-3 py-1"
              >
                {g.status.replaceAll("_", " ").toLowerCase()}: {g.count} ·{" "}
                {formatPrice(g.amount)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section
        title="Needs review (provider took money, not credited)"
        count={gateway.needsReview.length}
        hint="bKash confirmed a payment but it could not be credited automatically (amount/invoice mismatch, order no longer payable, duplicate id). Nothing was credited."
        empty="Nothing needs review."
      >
        {gateway.needsReview.map((t) => (
          <tr
            key={t.id}
            className="border-b border-border/40 last:border-0 align-top"
          >
            <td className="py-2">{orderLink(t.order)}</td>
            <td>{formatPrice(Number(t.amount))}</td>
            <td className="font-mono text-xs">
              {t.providerTrxId ?? t.providerPaymentId ?? "—"}
            </td>
            <td className="text-xs">{t.failureReason}</td>
          </tr>
        ))}
      </Section>

      <Section
        title="Online attempts past their time limit"
        count={gateway.stuck.length}
        hint="Never completed, or waiting on bKash for too long. Re-check asks bKash what happened; it credits only if bKash confirms."
        empty="No stuck attempts."
      >
        {gateway.stuck.map((t) => (
          <tr key={t.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(t.order)}</td>
            <td>{formatPrice(Number(t.amount))}</td>
            <td className="text-xs text-muted-foreground">
              {t.status.replaceAll("_", " ").toLowerCase()} ·{" "}
              {formatDate(t.createdAt)}
            </td>
            <td>
              <RecheckButton id={t.id} />
            </td>
          </tr>
        ))}
      </Section>

      {gateway.stuck.length > 1 && (
        <div>
          <RecoverAllButton />
        </div>
      )}

      <Section
        title="Confirmed refunds not in accounting"
        count={gateway.refundsNoAccounting.length}
        hint="bKash refunded these, but no refund record exists in accounting yet (it may already have been entered by hand, which the accounting rules refuse to double-count). Check the order, then record it."
        empty="Every confirmed refund is in accounting."
      >
        {gateway.refundsNoAccounting.map((r) => (
          <tr key={r.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(r.transaction.order)}</td>
            <td>{formatPrice(Number(r.amount))}</td>
            <td className="font-mono text-xs">{r.providerRefundTrxId ?? ""}</td>
            <td>
              <RecordAccountingButton refundId={r.id} />
            </td>
          </tr>
        ))}
      </Section>

      <Section
        title="Credited amount differs from provider"
        count={gateway.mismatched.length}
        hint="The local payment amount is not the amount bKash confirmed."
        empty="All credited online payments match the provider."
      >
        {gateway.mismatched.map((t) => (
          <tr key={t.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(t.order)}</td>
            <td>Provider {formatPrice(Number(t.amount))}</td>
            <td>Local {formatPrice(Number(t.payment?.amount ?? 0))}</td>
            <td className="font-mono text-xs">{t.providerTrxId}</td>
          </tr>
        ))}
      </Section>

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
        <div>
          <h2 className="font-heading text-lg">
            Refund an online payment{" "}
            <span className="text-sm text-muted-foreground">
              ({gateway.refundable.length})
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            Only payments bKash confirmed, on orders that are cancelled or have
            a refund request. A refund counts as done only when bKash confirms
            it.
          </p>
        </div>
        {gateway.refundable.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to refund.</p>
        ) : (
          gateway.refundable.map((t) => (
            <div
              key={t.id}
              className="space-y-2 border-t border-border/40 pt-3 first:border-0 first:pt-0"
            >
              <p className="text-sm">
                {orderLink(t.order)}{" "}
                <span className="text-xs text-muted-foreground">
                  · {t.order.status.replaceAll("_", " ").toLowerCase()} ·
                  refundable {formatPrice(t.remaining)}
                </span>
              </p>
              <GatewayRefundForm transactionId={t.id} max={t.remaining} />
            </div>
          ))
        )}
      </section>

      <Section
        title="Refunds saved but never sent to bKash"
        count={gateway.refundsNeverSent.length}
        hint="The app stopped after saving the refund and before sending it. No request reached bKash, so it is safe to send."
        empty="None."
      >
        {gateway.refundsNeverSent.map((r) => (
          <tr key={r.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(r.transaction.order)}</td>
            <td>{formatPrice(Number(r.amount))}</td>
            <td className="text-xs text-muted-foreground">
              {r.reason} · {formatDate(r.createdAt)}
            </td>
            <td>
              <SendNeverSentRefundButton id={r.id} />
            </td>
          </tr>
        ))}
      </Section>

      <section className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
        <div>
          <h2 className="font-heading text-lg">
            Refunds with an unknown result{" "}
            <span className="text-sm text-muted-foreground">
              ({gateway.refundsUncertain.length})
            </span>
          </h2>
          <p className="text-xs text-muted-foreground">
            The request may have reached bKash but no answer was recorded. These
            are never resent. Checking asks bKash; only if it cannot answer can
            you record what its dashboard shows.
          </p>
        </div>
        {gateway.refundsUncertain.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          gateway.refundsUncertain.map((r) => (
            <div
              key={r.id}
              className="space-y-2 border-t border-border/40 pt-3 first:border-0 first:pt-0"
            >
              <p className="text-sm">
                {orderLink(r.transaction.order)}{" "}
                <span className="text-xs text-muted-foreground">
                  · {formatPrice(Number(r.amount))} · sent{" "}
                  {r.submittedAt ? formatDate(r.submittedAt) : ""}
                </span>
              </p>
              <ResolveRefundForm
                refundId={r.id}
                proposal={
                  r.proposedById
                    ? {
                        outcome: r.proposedOutcome ?? "",
                        proposedAt: r.proposedAt?.toISOString() ?? "",
                        evidence: r.proposedEvidence,
                        note: r.proposedNote,
                        trx: r.proposedTrxId,
                      }
                    : null
                }
              />
            </div>
          ))
        )}
      </section>

      <Section
        title="Online refunds"
        count={gateway.refunds.length}
        hint="Refunds sent to bKash. Pending means bKash has not confirmed yet. Order-level refund accounting is handled by the existing refund process."
        empty="No online refunds."
      >
        {gateway.refunds.map((r) => (
          <tr key={r.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(r.transaction.order)}</td>
            <td>{formatPrice(Number(r.amount))}</td>
            <td className="text-xs">
              {r.status.toLowerCase()}
              {r.providerRefundTrxId ? ` · ${r.providerRefundTrxId}` : ""}
            </td>
            <td className="text-xs text-muted-foreground">{r.reason}</td>
            <td>
              {r.status === "PENDING" ? <SyncRefundButton id={r.id} /> : null}
            </td>
          </tr>
        ))}
      </Section>

      <Section
        title="Recent online attempts"
        count={gateway.recent.length}
        hint="Latest 30 attempts, any outcome. Failed, cancelled or expired attempts never changed any payment."
        empty="No online attempts yet."
      >
        {gateway.recent.map((t) => (
          <tr key={t.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(t.order)}</td>
            <td>{t.provider}</td>
            <td>{formatPrice(Number(t.amount))}</td>
            <td className="text-xs">
              {t.status.replaceAll("_", " ").toLowerCase()}
            </td>
            <td className="text-xs text-muted-foreground">
              {t.failureReason ?? t.providerTrxId ?? ""}
            </td>
            <td className="text-xs text-muted-foreground">
              {formatDate(t.createdAt)}
            </td>
          </tr>
        ))}
      </Section>

      <Section
        title="Waiting for verification"
        count={data.stale.length}
        hint={`Payment claims waiting more than ${STALE_CLAIM_HOURS} hours for a decision.`}
        empty="No old claims are waiting."
      >
        {data.stale.map((p) => (
          <tr key={p.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(p.order)}</td>
            <td>{p.method}</td>
            <td>{formatPrice(Number(p.amount))}</td>
            <td className="text-xs text-muted-foreground">
              ref {p.customerReference ?? "—"}
            </td>
            <td className="text-xs text-muted-foreground">
              {formatDate(p.createdAt)}
            </td>
          </tr>
        ))}
      </Section>

      <Section
        title="Duplicate references"
        count={data.duplicates.length}
        hint="The same wallet reference submitted more than once."
        empty="No repeated references."
      >
        {data.duplicates.map((d) => (
          <tr
            key={`${d.method}-${d.reference}`}
            className="border-b border-border/40 last:border-0"
          >
            <td className="py-2">{d.method}</td>
            <td className="font-mono text-xs">{d.reference}</td>
            <td>{d.claims} claims</td>
            <td className="text-xs">{d.orders.join(", ")}</td>
          </tr>
        ))}
      </Section>

      <Section
        title="Paid amount does not match"
        count={data.mismatched.length}
        hint="Verified advance payments that differ from the order's recorded paid amount, or exceed the order total."
        empty="All orders match."
      >
        {data.mismatched.map((m) => (
          <tr key={m.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">
              <Link
                href={`/admin/orders/${m.id}`}
                className="text-primary hover:underline"
              >
                {m.orderNumber}
              </Link>
            </td>
            <td>Order total {formatPrice(Number(m.total))}</td>
            <td>Recorded paid {formatPrice(Number(m.advancePaid))}</td>
            <td>Verified payments {formatPrice(Number(m.verified))}</td>
          </tr>
        ))}
      </Section>

      <Section
        title="Verified without a provider reference"
        count={data.unreferenced.length}
        hint="Cannot be matched to a wallet statement."
        empty="Every verified wallet payment has a reference."
      >
        {data.unreferenced.map((p) => (
          <tr key={p.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(p.order)}</td>
            <td>{p.method}</td>
            <td>{formatPrice(Number(p.amount))}</td>
            <td className="text-xs text-muted-foreground">
              {formatDate(p.createdAt)}
            </td>
          </tr>
        ))}
      </Section>

      <Section
        title="Recently rejected"
        count={data.recentRejected.length}
        hint="The last claims staff did not accept."
        empty="No rejected claims."
      >
        {data.recentRejected.map((p) => (
          <tr key={p.id} className="border-b border-border/40 last:border-0">
            <td className="py-2">{orderLink(p.order)}</td>
            <td>{p.method}</td>
            <td>{formatPrice(Number(p.amount))}</td>
            <td className="text-xs text-muted-foreground">
              ref {p.customerReference ?? "—"}
            </td>
            <td className="text-xs text-muted-foreground">
              {p.verifiedAt ? formatDate(p.verifiedAt) : ""}
            </td>
          </tr>
        ))}
      </Section>
    </div>
  );
}
