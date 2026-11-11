/** Pure rules for the operator password script (unit-tested). */
export const MIN_OPERATOR_PASSWORD = 10;

export type PasswordCheck = { ok: true; password: string } | { ok: false; message: string };

export function validateNewPassword(raw: string | undefined, email: string): PasswordCheck {
  const password = raw ?? "";
  if (password.trim() === "") return { ok: false, message: "NEW_PASSWORD is not set (a blank value counts as not set)." };
  if (password !== password.trim()) return { ok: false, message: "NEW_PASSWORD has leading/trailing spaces — remove them." };
  if (password.length < MIN_OPERATOR_PASSWORD) {
    return { ok: false, message: `NEW_PASSWORD must be at least ${MIN_OPERATOR_PASSWORD} characters.` };
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return { ok: false, message: "NEW_PASSWORD needs a lower-case letter, an upper-case letter and a digit." };
  }
  const local = email.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    return { ok: false, message: "NEW_PASSWORD must not contain the account's email name." };
  }
  return { ok: true, password };
}
