import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizeBdPhone } from "@/lib/advance-policy";

/**
 * Identity normalisation for fraud matching (pure). The goal is that the SAME person typing the same identifier two different ways matches,
 * and that DIFFERENT people never do.
 *
 *  - Phone: the project's existing Bangladesh normaliser (`normalizeBdPhone`, 01XXXXXXXXX) is the only one; it is re-exported, not copied.
 *  - E-mail: lower-cased NFKC; for Gmail only, dots and "+tag" are removed (Gmail ignores them). Other providers are NOT altered: a "+tag" or dot
 *    may be significant there, so merging them would wrongly join two people.
 *  - IP: IPv4 as-is; IPv6 reduced to its /64 prefix (one household/device rotates the lower 64 bits); IPv4-mapped IPv6 becomes the IPv4.
 *  - Address: a hash of the letters+digits of the address lines and city, so "House 5, Road-2 ," and "house 5 road 2" are the same key and the key
 *    cannot be read back into an address.
 */
export { normalizeBdPhone };

export function normalizeEmailForRisk(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.normalize("NFKC").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1 || at !== e.lastIndexOf("@") || at === e.length - 1 || e.length > 254 || /\s/.test(e)) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

/** Normalised IP for matching, or null if it is not an IP address. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return null;
  // Expand "::" and keep the first four groups (the /64 network prefix).
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill("0"), ...t];
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}

export function normalizeIdentifier(kind: "PHONE" | "EMAIL" | "IP", raw: string): string | null {
  return kind === "PHONE" ? normalizeBdPhone(raw) : kind === "EMAIL" ? normalizeEmailForRisk(raw) : normalizeIp(raw);
}

type AddressLike = { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null };

/** Stable key for "the same delivery address", or null when there is too little text to be meaningful. */
export function addressKeyOf(a: AddressLike): string | null {
  const text = [a.line1, a.line2, a.city].filter(Boolean).join(" ").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (text.length < 6) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

/** The identity keys of an order, derived the same way at checkout (stored on the order) and when the risk engine evaluates it. */
export function orderIdentity(o: { phone?: string | null; email?: string | null; shippingSnapshot?: unknown }): {
  phones: string[]; phoneNorm: string | null; emailNorm: string | null; addressKey: string | null;
} {
  const snap = (o.shippingSnapshot && typeof o.shippingSnapshot === "object" ? o.shippingSnapshot : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const own = normalizeBdPhone(o.phone);
  const delivery = normalizeBdPhone(str(snap.phone));
  return {
    phones: [...new Set([own, delivery].filter((p): p is string => Boolean(p)))],
    phoneNorm: own ?? delivery,
    emailNorm: normalizeEmailForRisk(o.email),
    addressKey: addressKeyOf({ line1: str(snap.line1), line2: str(snap.line2), city: str(snap.city) }),
  };
}
