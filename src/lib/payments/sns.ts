import "server-only";
import { createVerify } from "node:crypto";

/**
 * Verification of an Amazon-SNS-style signed message, as used for bKash's server-to-server notifications (IPN).
 * This implements the standard, publicly documented SNS signature procedure; what bKash puts INSIDE the message is not
 * relied on for anything except finding which local attempt to re-check with bKash.
 */

export type SnsEnvelope = Record<string, unknown> & { Type?: string; Message?: string; TopicArn?: string };

/** Only real SNS endpoints may supply a signing certificate or be called back (stops a forged "SigningCertURL"/"SubscribeURL" from pointing at our network). */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isTrustedSnsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.port === "" && SNS_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

const FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

export function buildStringToSign(env: SnsEnvelope): string | null {
  const keys = FIELDS[String(env.Type)];
  if (!keys) return null;
  let out = "";
  for (const key of keys) {
    const value = env[key];
    if (value === undefined || value === null) {
      if (key === "Subject") continue; // optional
      return null;
    }
    out += `${key}\n${String(value)}\n`;
  }
  return out;
}

const certCache = new Map<string, { pem: string; at: number }>();

async function loadCert(url: string): Promise<string> {
  const hit = certCache.get(url);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.pem;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store", redirect: "error" });
    if (!res.ok) throw new Error("certificate fetch failed");
    const pem = (await res.text()).slice(0, 20_000);
    if (!pem.includes("BEGIN CERTIFICATE")) throw new Error("not a certificate");
    certCache.set(url, { pem, at: Date.now() });
    return pem;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifySnsSignature(env: SnsEnvelope): Promise<boolean> {
  try {
    const certUrl = env.SigningCertURL ?? env.SigningCertUrl;
    const signature = env.Signature;
    if (!isTrustedSnsUrl(certUrl) || !certUrl.endsWith(".pem") || typeof signature !== "string") return false;
    const toSign = buildStringToSign(env);
    if (!toSign) return false;
    const algorithm = env.SignatureVersion === "2" ? "RSA-SHA256" : env.SignatureVersion === "1" ? "RSA-SHA1" : null;
    if (!algorithm) return false;
    const verifier = createVerify(algorithm);
    verifier.update(toSign, "utf8");
    return verifier.verify(await loadCert(certUrl), signature, "base64");
  } catch {
    return false;
  }
}
