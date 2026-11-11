"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  rejectAdvanceAction,
  recheckFraudAction,
  reviewTrustAction,
  verifyAdvanceAction,
  waiveAdvanceAction,
} from "@/server/actions/admin-advance.actions";
import { formatPrice } from "@/lib/utils";
import type { PanelFraud } from "@/server/services/advance.service";

type Pay = {
  id: string;
  method: string;
  status: string;
  amount: number;
  customerReference: string | null;
  providerRef: string | null;
  sameReferenceOn?: string[];
};
export type AdvancePanelProps = {
  orderId: string;
  pending: boolean;
  data: {
    advanceRequired: number;
    advancePaid: number;
    total: number;
    remaining: number;
    trustScore: number | null;
    /** Delivery phone the fraud check is about (admin-only). */
    phone?: string | null;
    trust: {
      reasons: string[];
      tier: string | null;
      needsReview: boolean;
      explanation: string;
      insufficientEvidence: boolean;
  fraudCheck: PanelFraud | null;
  recheck: (PanelFraud & { score: number; tier: string; byId: string; insufficientEvidence: boolean; reasons: string[] }) | null;
    } | null;
    waived: { byId: string; reason: string; at?: Date | string | null } | null;
    payments: Pay[];
    review?: {
      required: boolean;
      reviewedAt: Date | string | null;
      note: string | null;
    };
    blockedReason?: string | null;
    drift?: boolean;
    audit?: { action: string; at: Date | string; detail: unknown }[];
  };
};

const REASON_TEXT: Record<string, string> = {
  no_provider: "no fraud-check provider is configured",
  disabled: "the fraud check is switched off",
  invalid_phone: "the order phone is not a valid Bangladesh mobile number",
  timeout: "the provider did not answer in time",
  error: "the provider could not be reached",
  invalid_response: "the provider returned an unusable response",
  rate_limited: "the call budget was used up or the provider asked us to slow down",
  auth_failed: "the provider rejected the API credentials",
  no_counts: "the provider gave no parcel counts, so nothing was estimated",
};
const utc = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? `${new Date(iso).toISOString().replace("T", " ").slice(0, 16)} UTC` : "not recorded");

/** One fraud result, in plain words. Never shown to customers. */
function FraudFacts({ fc, label }: { fc: PanelFraud; label: string }) {
  const count = (n: number | null) => (n === null ? "n/a" : String(n));
  return (
    <div className="rounded-md border border-border/60 p-2 text-xs">
      <p className="font-medium">
        {label}:{" "}
        {fc.source === "provider" ? "real provider data" : fc.source === "fallback" ? "fallback policy: no real check happened" : "source not recorded"}
      </p>
      <p>
        Provider: {fc.provider ?? "none"} · status: {fc.status ?? "unknown"}
        {fc.status === "unavailable" ? ` (${REASON_TEXT[fc.reason ?? ""] ?? fc.reason ?? "unknown reason"}): standard policy applied` : ""}
      </p>
      {fc.status === "ok" && (
        <p>
          Delivered {count(fc.delivered)} · cancelled {count(fc.cancelled)} · returned {count(fc.returned)} (shown, not scored) · total {count(fc.total)}
        </p>
      )}
      {fc.status === "no_history" && <p>The provider has no parcel history for this phone.</p>}
      <p>
        Last checked {utc(fc.checkedAt)} · phone {fc.phoneVerified ? "verified" : "not verified (delivered history is not credited)"}
      </p>
    </div>
  );
}

export function AdvancePanel({
  orderId,
  data,
  pending: orderPending,
}: AdvancePanelProps) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [ref, setRef] = useState<Record<string, string>>({});
  const [amt, setAmt] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const run = (
    fn: () => Promise<{ success: boolean; message?: string }>,
    ok: string,
  ) =>
    start(async () => {
      const r = await fn();
      if (r.success) {
        toast.success(ok);
        router.refresh();
      } else toast.error(r.message ?? "Failed");
    });

  if (data.advanceRequired <= 0 && data.trustScore === null) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Advance &amp; trust</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Required <strong>{formatPrice(data.advanceRequired)}</strong> ·
          verified received <strong>{formatPrice(data.advancePaid)}</strong> ·
          balance due on delivery <strong>{formatPrice(data.remaining)}</strong>
        </p>
        {data.trustScore !== null && (
          <div className="rounded-lg bg-secondary/50 p-3">
            <p className="font-medium">
              Trust score {data.trustScore}/100
              {data.trust?.needsReview ? " — review before dispatch" : ""}
              {data.trust?.insufficientEvidence ? " (no fraud-check record)" : ""}
            </p>
            <ul className="list-disc pl-5 text-xs text-muted-foreground">
              {(data.trust?.reasons ?? []).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <div className="mt-2 space-y-2">
              <p className="text-xs">
                <strong>Phone checked:</strong> {data.phone ?? "not available"} · <strong>Score:</strong> {data.trustScore}/100 ·{" "}
                <strong>Risk tier:</strong> {data.trust?.tier ?? "n/a"}
              </p>
              {data.trust?.fraudCheck ? (
                <>
                  <FraudFacts fc={data.trust.fraudCheck} label="At checkout" />
                  {data.phone && data.trust.fraudCheck.phoneLast4 && !data.phone.replace(/\D/g, "").endsWith(data.trust.fraudCheck.phoneLast4) && (
                    <p role="alert" className="text-xs text-destructive">The phone on this order no longer matches the phone that was checked.</p>
                  )}
                </>
              ) : (
                <p className="text-xs">Fraud check: not recorded (order placed before the fraud checker existed).</p>
              )}
              {data.trust?.recheck && (
                <>
                  <FraudFacts fc={data.trust.recheck} label="Latest recheck" />
                  <p className="text-xs">
                    Recheck score {data.trust.recheck.score}/100 ({data.trust.recheck.tier} tier). It does not change the advance, a waiver or the review flag: use the actions below to act on it.
                  </p>
                </>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run(() => recheckFraudAction({ orderId }), "Fraud result rechecked")}
              >
                Recheck fraud result now
              </Button>
              <p className="text-[11px] text-muted-foreground">Calls the provider again (max 20 per admin per hour, once a minute per order) and is recorded in the audit log.</p>
            </div>
            {data.trust?.explanation && (
              <p className="mt-1 text-xs">{data.trust.explanation}</p>
            )}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          The trust score is a rule-based heuristic (higher = more confidence in
          successful fulfilment). It is not a probability or a fraud verdict.
        </p>
        {data.blockedReason && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
          >
            Cannot be confirmed or dispatched yet: {data.blockedReason}
          </p>
        )}
        {data.drift && (
          <p
            role="alert"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
          >
            The recorded advance differs from the verified payment records.
            Check the payments below before relying on the balance.
          </p>
        )}
        {data.review?.required &&
          (data.review.reviewedAt ? (
            <p className="rounded-lg bg-secondary/50 p-2 text-xs">
              Low-trust review done
              {data.review.note ? `: “${data.review.note}”` : ""}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-72"
                placeholder="What did you check? (e.g. called the customer)"
                value={reviewNote}
                onChange={(e) => setReviewNote(e.target.value)}
                aria-label="Review note"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || reviewNote.trim().length < 3}
                onClick={() =>
                  run(
                    () => reviewTrustAction({ orderId, note: reviewNote }),
                    "Review recorded",
                  )
                }
              >
                Mark reviewed
              </Button>
            </div>
          ))}
        {data.waived && (
          <p className="rounded-lg bg-secondary/50 p-2 text-xs">
            Advance waived by staff
            {data.waived.at
              ? ` on ${new Date(data.waived.at).toLocaleString()}`
              : ""}
            : “{data.waived.reason}” (a waiver is not money received)
          </p>
        )}
        {data.payments.map((p) => (
          <div
            key={p.id}
            className="space-y-2 rounded-lg border border-border/70 p-3"
          >
            <p>
              {p.method} · {formatPrice(p.amount)} · <strong>{p.status}</strong>
            </p>
            <p className="text-xs text-muted-foreground">
              Customer says transaction: {p.customerReference ?? "—"}{" "}
              {p.status === "PENDING" ? "(unverified claim: not money)" : ""}
              {p.providerRef ? ` · verified id ${p.providerRef}` : ""}
            </p>
            {p.status === "PENDING" && (p.sameReferenceOn?.length ?? 0) > 0 && (
              <p className="text-xs text-amber-700">
                The same reference was also claimed on{" "}
                {p.sameReferenceOn!.join(", ")}. One transaction can be verified
                on only one order.
              </p>
            )}
            {p.status === "PENDING" && (
              <div className="flex flex-wrap items-end gap-2">
                <Input
                  className="h-8 w-44"
                  placeholder="Wallet transaction id"
                  value={ref[p.id] ?? p.customerReference ?? ""}
                  onChange={(e) => setRef({ ...ref, [p.id]: e.target.value })}
                  aria-label="Verified transaction id"
                />
                <Input
                  className="h-8 w-28"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Amount received"
                  value={amt[p.id] ?? String(p.amount)}
                  onChange={(e) => setAmt({ ...amt, [p.id]: e.target.value })}
                  aria-label="Amount received"
                />
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        verifyAdvanceAction({
                          orderId,
                          paymentId: p.id,
                          providerRef: ref[p.id] ?? p.customerReference ?? "",
                          amount: Number(amt[p.id] ?? p.amount),
                        }),
                      "Advance verified",
                    )
                  }
                >
                  Verify received
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const why = window.prompt(
                      "Reason for rejecting this payment?",
                    );
                    if (why)
                      run(
                        () =>
                          rejectAdvanceAction({
                            orderId,
                            paymentId: p.id,
                            reason: why,
                          }),
                        "Payment rejected",
                      );
                  }}
                >
                  Reject
                </Button>
              </div>
            )}
          </div>
        ))}
        {orderPending &&
          data.advanceRequired > data.advancePaid &&
          !data.waived && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-64"
                placeholder="Reason to waive the advance"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Waiver reason"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || reason.trim().length < 5}
                onClick={() =>
                  run(
                    () => waiveAdvanceAction({ orderId, reason }),
                    "Advance waived",
                  )
                }
              >
                Waive advance
              </Button>
            </div>
          )}
        {(data.audit?.length ?? 0) > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              Staff actions on this order ({data.audit!.length})
            </summary>
            <ul className="mt-1 list-disc pl-5">
              {data.audit!.map((e, i) => (
                <li key={i}>
                  {new Date(e.at).toLocaleString()} ·{" "}
                  {e.action.replaceAll("_", " ").toLowerCase()}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
