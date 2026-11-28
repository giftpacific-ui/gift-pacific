/**
 * Stable unsubscribe tokens and URLs (Prompt 11). PURE: no database, no network; the only input besides the arguments is the environment object it
 * is given. Server-side only like the rest of src/lib/email.
 *
 * DESIGN
 *   token = base64url( HMAC-SHA256( EMAIL_UNSUBSCRIBE_SECRET, "giftpacific:email-unsubscribe:v1\n" + contactId ) )          (43 characters)
 *
 *  - STABLE: the same contact always gets the same token, so sending another campaign can never invalidate a link already in someone's inbox.
 *  - UNPREDICTABLE: without the secret a token cannot be computed or guessed (256 bits), and one contact's token reveals nothing about another's.
 *  - NOT STORED: the token is recomputed whenever it is needed. The database keeps only SHA-256(token) in the EXISTING EmailContact.unsubscribeTokenHash
 *    column, purely as the lookup index that turns a token from a link back into a contact without putting the contact id in the URL.
 *  - VERIFIED TWICE: the hash lookup finds a candidate contact, then the token is recomputed for THAT contact and compared in constant time. A hash
 *    that does not belong to the contact (corruption, a legacy random token, a changed secret) is rejected.
 *  - The contact id and the e-mail address never appear in the URL.
 *
 * Changing EMAIL_UNSUBSCRIBE_SECRET changes every token, i.e. it invalidates every link already sent. That is the one deliberate way to revoke links
 * (for example after a leak). There is no overlap window: the single hash column holds one token per contact.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { hashUnsubscribeToken } from "@/lib/email/marketing";
import { isRecordId } from "@/lib/email/template-rules";
import { checkUnsubscribeUrlShape, type ListUnsubscribeHeaders, buildListUnsubscribeHeaders } from "@/lib/email/list-unsubscribe";
import {
  readUnsubscribeBaseUrl, UNSUBSCRIBE_SECRET_MIN_LENGTH, type UnsubscribeConfig,
} from "@/lib/email/unsubscribe-config";
export {
  readUnsubscribeBaseUrl, readUnsubscribeConfig, readUnsubscribeSecret, UNSUBSCRIBE_SECRET_ENV, UNSUBSCRIBE_SECRET_MIN_LENGTH,
  type UnsubscribeBaseUrl, type UnsubscribeConfig, type UnsubscribeSecret, type UnsubscribeSecretFailure,
} from "@/lib/email/unsubscribe-config";
import { UNSUBSCRIBE_ROUTE_PREFIX, UNSUBSCRIBE_TOKEN_PATTERN, isWellFormedUnsubscribeToken } from "@/lib/email/unsubscribe-path";

type Env = Record<string, string | undefined>;
const TOKEN_CONTEXT = "giftpacific:email-unsubscribe:v1";

// ---------------------------------------------------------------------------------------------------------------------------------- token

/** The stable token of one contact, or null for an unusable id or secret. Deterministic: same secret + same contact = same token. */
export function deriveUnsubscribeToken(secret: string, contactId: unknown): string | null {
  if (typeof secret !== "string" || secret.length < UNSUBSCRIBE_SECRET_MIN_LENGTH || !isRecordId(contactId)) return null;
  const token = createHmac("sha256", secret).update(`${TOKEN_CONTEXT}\n${contactId}`).digest("base64url");
  return UNSUBSCRIBE_TOKEN_PATTERN.test(token) ? token : null;
}

/** Constant-time comparison of two tokens. Anything that is not a well-formed token is simply "not equal". */
export function unsubscribeTokensMatch(expected: unknown, supplied: unknown): boolean {
  if (!isWellFormedUnsubscribeToken(expected) || !isWellFormedUnsubscribeToken(supplied)) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(supplied, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Does `token` belong to `contactId` under this secret? (Recomputes the contact's own token and compares it in constant time.) */
export function verifyUnsubscribeToken(secret: string, contactId: unknown, token: unknown): boolean {
  const expected = deriveUnsubscribeToken(secret, contactId);
  return expected !== null && unsubscribeTokensMatch(expected, token);
}

// ------------------------------------------------------------------------------------------------------------------------------------- url

declare const validated: unique symbol;
/** An unsubscribe URL that passed `validateUnsubscribeUrl`. Only that function (and the builders here, which call it) can produce one. */
export type UnsubscribeUrl = string & { readonly [validated]: true };

/**
 * The only way to obtain an `UnsubscribeUrl`. Checks: canonical, visible-ASCII, no credentials/query/fragment, https in production (see
 * checkUnsubscribeUrlShape), the host is exactly the configured public origin (so a template or a bug cannot point a link at another site: no open
 * redirect), and the path is exactly the unsubscribe route plus one well-formed token.
 */
export function validateUnsubscribeUrl(url: unknown, env: Env = process.env): { ok: true; url: UnsubscribeUrl } | { ok: false } {
  const base = readUnsubscribeBaseUrl(env);
  if (!base.ok) return { ok: false };
  const shape = checkUnsubscribeUrlShape(url, env.NODE_ENV);
  if (!shape.ok || shape.url.origin !== base.origin) return { ok: false };
  const path = shape.url.pathname;
  if (!path.startsWith(UNSUBSCRIBE_ROUTE_PREFIX) || !isWellFormedUnsubscribeToken(path.slice(UNSUBSCRIBE_ROUTE_PREFIX.length))) return { ok: false };
  return { ok: true, url: url as UnsubscribeUrl };
}

export type UnsubscribeLink =
  | { ok: true; url: UnsubscribeUrl; /** SHA-256 (hex) of the token: the ONLY form that is ever stored. */ tokenHash: string }
  | { ok: false; reason: "invalid_contact" | "url_invalid" };

/** The unsubscribe URL of one contact (and the hash to store), from a config that `readUnsubscribeConfig` accepted. */
export function createUnsubscribeLink(config: Extract<UnsubscribeConfig, { ok: true }>, contactId: unknown, env: Env = process.env): UnsubscribeLink {
  const token = deriveUnsubscribeToken(config.secret, contactId);
  if (!token) return { ok: false, reason: "invalid_contact" };
  const tokenHash = hashUnsubscribeToken(token);
  if (!tokenHash) return { ok: false, reason: "invalid_contact" };
  const checked = validateUnsubscribeUrl(`${config.origin}${UNSUBSCRIBE_ROUTE_PREFIX}${token}`, { ...env, NEXT_PUBLIC_APP_URL: config.origin, NODE_ENV: config.nodeEnv });
  return checked.ok ? { ok: true, url: checked.url, tokenHash } : { ok: false, reason: "url_invalid" };
}

/** The `List-Unsubscribe` and `List-Unsubscribe-Post` headers for a validated unsubscribe URL. */
export function unsubscribeHeadersFor(url: UnsubscribeUrl, env: Env = process.env): { ok: true; headers: ListUnsubscribeHeaders } | { ok: false } {
  return buildListUnsubscribeHeaders(url, env.NODE_ENV);
}
