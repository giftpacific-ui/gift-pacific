import "server-only";
import { cookies } from "next/headers";
import {
  CONFIRMATION_COOKIE,
  CONFIRMATION_COOKIE_PATH,
  CONFIRMATION_MAX_AGE_SECONDS,
  LEGACY_CONFIRMATION_COOKIE,
  encodeConfirmation,
  tokenForOrder,
} from "@/lib/confirmation-cookie";

export async function setConfirmationCookie(orderNumber: string, token: string) {
  const value = encodeConfirmation(orderNumber, token);
  if (!value) return;
  const store = await cookies();
  store.set(CONFIRMATION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: CONFIRMATION_COOKIE_PATH,
    maxAge: CONFIRMATION_MAX_AGE_SECONDS,
  });
}

export async function readConfirmationToken(orderNumber: string): Promise<string | undefined> {
  const store = await cookies();
  // Current cookie first, then the pre-rebrand cookie (each holds one order, so check both for this order number).
  return (
    tokenForOrder(store.get(CONFIRMATION_COOKIE)?.value, orderNumber) ??
    tokenForOrder(store.get(LEGACY_CONFIRMATION_COOKIE)?.value, orderNumber)
  );
}
