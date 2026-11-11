import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const stub = (name) => path.join(here, "stubs", name);

/** Specifiers replaced by test stubs (server-only, Prisma, next/*, auth, cloudinary). */
export const STUBS = {
  "server-only": stub("empty.ts"),
  "@prisma/client": stub("prisma-client.ts"),
  "next/cache": stub("next-cache.ts"),
  "next/headers": stub("next-headers.ts"),
  "next/server": stub("next-server.ts"),
  "@/lib/db/prisma": stub("db-prisma.ts"),
  "@/lib/auth/current-user": stub("current-user.ts"),
  "@/lib/cart/guest-token": stub("guest-token.ts"),
  "@/lib/cloudinary/cloudinary": stub("cloudinary.ts"),
};
// If the project's own `zod` isn't installed (e.g. an offline sandbox), fall
// back to any zod copy found via TEST_ZOD_PATH. Once `pnpm install` has run,
// the real project zod is used and this block does nothing.
import { createRequire } from "node:module";
const req = createRequire(path.join(here, "../../package.json"));
try {
  req.resolve("zod");
} catch {
  if (process.env.TEST_ZOD_PATH) STUBS["zod"] = req.resolve(process.env.TEST_ZOD_PATH);
}

export const toUrl = (p) => pathToFileURL(p).href;
