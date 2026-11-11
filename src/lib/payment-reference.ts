/**
 * Wallet / bank transaction references (bKash TrxID, Nagad txn id, …).
 *
 * `(method, providerRef)` is UNIQUE in the database, so one real transaction can only ever be counted once. To make that
 * guarantee meaningful the reference is NORMALISED before it is stored or compared: `8n7a 6d5ee7`, `8N7A6D5EE7` and
 * `8N7A-6D5EE7` are the same transaction. Pure and unit-tested.
 */
export function normalizeTxnRef(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== "string") return { ok: false, message: "Enter the transaction id as shown in the wallet statement." };
  const value = raw.normalize("NFKC").replace(/[\u2010-\u2015\s]+/g, "").replace(/-/g, "").toUpperCase();
  if (value.length < 4 || value.length > 60) return { ok: false, message: "The transaction id must be 4–60 characters." };
  if (!/^[A-Z0-9._/#]+$/.test(value)) return { ok: false, message: "The transaction id may only contain letters, numbers and . _ / #" };
  return { ok: true, value };
}
