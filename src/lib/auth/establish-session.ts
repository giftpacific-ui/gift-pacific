import "server-only";
import { cookies } from "next/headers";
import { createSessionToken, sessionCookieConfig } from "@/lib/auth/session";
import { mergeGuestCartIntoUserCart } from "@/server/services/cart.service";
import { peekGuestToken, clearGuestToken } from "@/lib/cart/guest-token";

/** Same session cookie the password login sets; used by the social-login callback. */
export async function establishCustomerSession(user: { id: string; role: "ADMIN" | "CUSTOMER"; email: string; name: string }) {
  const token = await createSessionToken({ sub: user.id, role: user.role, email: user.email, name: user.name });
  (await cookies()).set(sessionCookieConfig.name, token, sessionCookieConfig.options);
}

/** Keeps the guest's cart when they sign in (same behaviour as password login). */
export async function mergeGuestCartIfPresent(userId: string) {
  const guestToken = await peekGuestToken();
  if (!guestToken) return;
  await mergeGuestCartIntoUserCart(userId, guestToken);
  await clearGuestToken();
}
