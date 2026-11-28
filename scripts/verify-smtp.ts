/**
 * OPERATOR SCRIPT: checks the SMTP settings in .env and, if they are valid, logs in to the SMTP server (no e-mail is sent).
 *   pnpm smtp:verify
 * Prints only a status line; never the password. Exit code 0 = connected, 1 = not configured / invalid / failed.
 */
import { describeSmtpConfig, parseSmtpConfig } from "../src/lib/email/config";
import { verifySmtpConnection } from "../src/lib/email/smtp";

async function main() {
  console.log("SMTP settings:", JSON.stringify(describeSmtpConfig(parseSmtpConfig()), null, 2));
  const r = await verifySmtpConnection();
  if (r.ok) {
    console.log(`OK: connected and logged in to ${r.host}:${r.port}. No e-mail was sent.`);
    return;
  }
  console.error(`FAILED (${r.code}): ${r.message}`);
  for (const p of r.problems ?? []) console.error(` - ${p}`);
  process.exitCode = 1;
}
void main();
