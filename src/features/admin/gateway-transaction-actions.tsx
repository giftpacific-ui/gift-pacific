"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  recheckGatewayTransactionAction,
  recordGatewayRefundInAccountingAction,
  approveRefundAttestationAction,
  recoverStuckGatewayTransactionsAction,
  rejectRefundAttestationAction,
  resolveUncertainRefundAction,
  sendNeverSubmittedRefundAction,
  refundGatewayTransactionAction,
  syncGatewayRefundAction,
  testBkashConnectionAction,
} from "@/server/actions/gateway-payment.actions";

export function RecheckButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await recheckGatewayTransactionAction(id);
          if (!r.success) return void toast.error(r.message);
          toast.message(
            `Provider says: ${r.status.replaceAll("_", " ").toLowerCase()}`,
          );
          router.refresh();
        })
      }
    >
      {pending ? "Checking…" : "Re-check with bKash"}
    </Button>
  );
}

export function SyncRefundButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await syncGatewayRefundAction(id);
          if (!r.success) return void toast.error(r.message);
          toast.message(`Refund is ${r.status.toLowerCase()}`);
          router.refresh();
        })
      }
    >
      Check refund
    </Button>
  );
}

/** One idempotency key per mounted form: a double-click or retry of the same submission can never send two refunds. */
export function GatewayRefundForm({
  transactionId,
  max,
}: {
  transactionId: string;
  max: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [amount, setAmount] = useState(String(max));
  const [reason, setReason] = useState("");
  const [key] = useState(() => crypto.randomUUID());
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      <label>
        Amount
        <Input
          className="w-28"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="flex-1">
        Reason
        <Input
          value={reason}
          maxLength={200}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <Button
        type="button"
        size="sm"
        disabled={pending || reason.trim().length < 3}
        onClick={() => {
          if (
            !window.confirm("Send this refund to bKash? It cannot be undone.")
          )
            return;
          start(async () => {
            const r = await refundGatewayTransactionAction({
              transactionId,
              amount: Number(amount),
              reason,
              idempotencyKey: key,
            });
            if (!r.success) return void toast.error(r.message);
            toast.message(
              r.status === "SUCCEEDED"
                ? "bKash confirmed the refund"
                : r.status === "FAILED"
                  ? "bKash refused the refund"
                  : "Refund sent; waiting for bKash to confirm",
            );
            router.refresh();
          });
        }}
      >
        {pending ? "Sending…" : "Refund via bKash"}
      </Button>
    </div>
  );
}

export function TestConnectionButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await testBkashConnectionAction();
          if (r.success) toast.success("bKash accepted the credentials");
          else toast.error(r.message);
          router.refresh();
        })
      }
    >
      {pending ? "Testing…" : "Test connection"}
    </Button>
  );
}

export function RecoverAllButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await recoverStuckGatewayTransactionsAction();
          if (!r.success) return void toast.error(r.message);
          toast.message(
            `${r.totalStuck} stuck: ${r.settled} settled, ${r.stillOpen} still open at bKash, ${r.failed} could not be checked${r.notReached > 0 ? `, ${r.notReached} not reached yet (press again to continue)` : ""}${r.lateCompleted > 0 ? `; ${r.lateCompleted} closed payment(s) bKash says completed: see "Needs review"` : ""}`,
          );
          router.refresh();
        })
      }
    >
      {pending ? "Checking…" : "Re-check all stuck"}
    </Button>
  );
}

export function RecordAccountingButton({ refundId }: { refundId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          if (
            !window.confirm(
              "If this refund was already entered in accounting by hand, recording it again would count the same money twice. Record it?",
            )
          )
            return;
          const r = await recordGatewayRefundInAccountingAction(refundId);
          if (!r.success) return void toast.error(r.message);
          toast.success("Recorded in accounting");
          router.refresh();
        })
      }
    >
      Record in accounting
    </Button>
  );
}

export function SendNeverSentRefundButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (
          !window.confirm(
            "This refund was saved but never sent to bKash. Send it now?",
          )
        )
          return;
        start(async () => {
          const r = await sendNeverSubmittedRefundAction(id);
          if (!r.success) return void toast.error(r.message);
          toast.message(
            r.status === "SUCCEEDED"
              ? "bKash confirmed the refund"
              : r.status === "FAILED"
                ? "bKash refused the refund"
                : "Sent; waiting for bKash to confirm",
          );
          router.refresh();
        });
      }}
    >
      {pending ? "Sending…" : "Send to bKash"}
    </Button>
  );
}

type Proposal = {
  outcome: string;
  byMe?: never;
  proposedAt: string;
  evidence: string | null;
  note: string | null;
  trx: string | null;
};

/** For a refund that MAY have reached bKash. bKash is queried first; this only applies if that gave no answer. Nothing is resent. */
export function ResolveRefundForm({
  refundId,
  proposal,
}: {
  refundId: string;
  proposal: Proposal | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [outcome, setOutcome] = useState<"REFUNDED" | "NOT_REFUNDED">(
    "NOT_REFUNDED",
  );
  const [trx, setTrx] = useState("");
  const [day, setDay] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");

  if (proposal) {
    return (
      <div className="space-y-2 rounded-md border border-amber-300/60 bg-amber-50 p-3 text-xs">
        <p className="font-medium">
          Waiting for a second admin: “
          {proposal.outcome === "REFUNDED"
            ? `Refund was made${proposal.trx ? ` (${proposal.trx})` : ""}`
            : "No refund was made"}
          ”
        </p>
        <p className="text-muted-foreground">
          Evidence: {proposal.evidence} · {proposal.note}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() => {
              if (
                !window.confirm(
                  "Approve this decision? You are confirming you checked the evidence yourself. It cannot be undone.",
                )
              )
                return;
              start(async () => {
                const r = await approveRefundAttestationAction(refundId);
                if (!r.success) return void toast.error(r.message);
                toast.message(`Refund is now ${r.status.toLowerCase()}`);
                router.refresh();
              });
            }}
          >
            Approve (different admin)
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              const why = window.prompt(
                "Why is this decision being rejected or withdrawn?",
              );
              if (!why) return;
              start(async () => {
                const r = await rejectRefundAttestationAction(refundId, why);
                if (!r.success) return void toast.error(r.message);
                router.refresh();
              });
            }}
          >
            Reject / withdraw
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-end gap-2">
        <label>
          What the bKash dashboard shows
          <select
            value={outcome}
            onChange={(e) =>
              setOutcome(e.target.value as "REFUNDED" | "NOT_REFUNDED")
            }
            className="mt-1 block rounded-md border border-input bg-background px-2 py-2 text-sm"
          >
            <option value="NOT_REFUNDED">No refund was made</option>
            <option value="REFUNDED">The refund was made</option>
          </select>
        </label>
        {outcome === "REFUNDED" && (
          <>
            <label>
              Refund transaction id
              <Input
                className="w-40"
                value={trx}
                onChange={(e) => setTrx(e.target.value)}
              />
            </label>
            <label>
              Date shown
              <Input
                type="date"
                className="w-40"
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {outcome === "NOT_REFUNDED" && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive"
        >
          Careful: if bKash DID refund this and you choose “No refund was made”,
          the same amount can be refunded again, which is a duplicate refund and
          real money lost. Only choose it after seeing, in the bKash dashboard,
          that no refund exists.
        </p>
      )}
      <label className="block">
        Evidence reference (required): dashboard screenshot name, support ticket
        or statement line
        <Input
          value={evidence}
          maxLength={200}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </label>
      <label className="block">
        What you checked (required)
        <Input
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={
          pending || note.trim().length < 10 || evidence.trim().length < 6
        }
        onClick={() => {
          if (
            !window.confirm(
              "First bKash is asked. If it cannot answer, this records your decision with your evidence. Larger amounts then need a second admin. Continue?",
            )
          )
            return;
          start(async () => {
            const r = await resolveUncertainRefundAction({
              refundId,
              outcome,
              providerRefundTrxId: trx,
              confirmedOn: day,
              evidence,
              note,
            });
            if (!r.success) return void toast.error(r.message);
            toast.message(
              r.awaitingApproval
                ? "Saved. A different admin must approve it."
                : `Refund is now ${r.status.toLowerCase()}`,
            );
            router.refresh();
          });
        }}
      >
        {pending ? "Saving…" : "Check bKash, then resolve"}
      </Button>
    </div>
  );
}
