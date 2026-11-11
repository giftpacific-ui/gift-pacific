import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

let dummyHash: Promise<string> | null = null;

/**
 * Verifies a password. `hash` is NULL for social-only accounts (no password set): the
 * answer is then always `false`, but a real bcrypt comparison still runs against a dummy
 * hash so "no such password" and "wrong password" cost the same time.
 */
export async function verifyPassword(
  plainPassword: string,
  hash: string | null,
): Promise<boolean> {
  if (!hash) {
    dummyHash ??= bcrypt.hash("giftpacific-dummy-password", SALT_ROUNDS);
    await bcrypt.compare(plainPassword, await dummyHash);
    return false;
  }
  return bcrypt.compare(plainPassword, hash);
}
