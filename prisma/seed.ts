import { PrismaClient } from "@prisma/client";
import { runSeed, SeedConfigError } from "./seed-runner";

runSeed(process.env, () => new PrismaClient()).catch((error: unknown) => {
  if (error instanceof SeedConfigError) {
    for (const message of error.errors) console.error(`❌ ${message}`);
    console.error(`❌ ${error.message}`);
  } else {
    console.error(
      "❌ Seed failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
  process.exit(1);
});
