import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { resolveSeedConfig, type SeedConfig } from "./seed-config";

/** Thrown for an unsafe/invalid configuration. Always raised BEFORE a database client is created. */
export class SeedConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super("Invalid seed configuration — nothing was written to the database.");
    this.name = "SeedConfigError";
    this.errors = errors;
  }
}

export type SeedLogger = {
  log: (m: string) => void;
  warn: (m: string) => void;
};
export type SeedDeps = {
  /** Injected in unit tests; defaults to bcryptjs. */
  hash?: (plain: string, rounds: number) => Promise<string>;
  logger?: SeedLogger;
};
export type SeedOutcome = {
  adminCreated: boolean;
  adminEmail: string;
};

/**
 * Validates the environment FIRST. If the configuration is unsafe it throws
 * SeedConfigError without ever calling `createClient`, so no connection is
 * opened and nothing can be written. Only then is a client created.
 *
 * The seed creates exactly one thing: the admin user. Everything else
 * (settings, categories, products, coupons, banners, orders) is created
 * from the admin panel after going live.
 *
 * Messages never include passwords, secrets or DATABASE_URL.
 */
export async function runSeed(
  env: Record<string, string | undefined>,
  createClient: () => PrismaClient,
  deps: SeedDeps = {},
): Promise<SeedOutcome> {
  const resolved = resolveSeedConfig(env);
  if (!resolved.ok) throw new SeedConfigError(resolved.errors);
  const config = resolved.config;
  const logger = deps.logger ?? {
    log: (m: string) => console.log(m),
    warn: (m: string) => console.warn(m),
  };
  const hash =
    deps.hash ??
    ((plain: string, rounds: number) => bcrypt.hash(plain, rounds));
  for (const warning of config.warnings) logger.warn(`⚠️  ${warning}`);

  const prisma = createClient();
  try {
    return await seed(prisma, config, hash, logger);
  } finally {
    await prisma.$disconnect();
  }
}

async function seed(
  prisma: PrismaClient,
  config: SeedConfig,
  hash: NonNullable<SeedDeps["hash"]>,
  logger: SeedLogger,
): Promise<SeedOutcome> {
  const { adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD } = config;
  logger.log(`🌱 Seeding Gift Pacific (admin only)...`);

  // ---- Admin ----
  // An existing account is NEVER modified: it is looked up first and, if found,
  // there is no update/upsert/delete of any kind — its password hash, role and
  // permissions stay exactly as they are. The password is only hashed when a
  // new admin is actually created.
  const existing = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true, role: true },
  });
  let adminCreated = false;
  if (existing) {
    logger.log(
      existing.role === "ADMIN"
        ? `  admin: ${ADMIN_EMAIL} already exists — left unchanged (password and role NOT modified)`
        : `  admin: ${ADMIN_EMAIL} already exists with role ${existing.role} — left unchanged (NOT promoted, password NOT modified)`,
    );
  } else {
    const passwordHash = await hash(ADMIN_PASSWORD, 12);
    await prisma.user.create({
      data: {
        name: "Store Admin",
        email: ADMIN_EMAIL,
        passwordHash,
        role: "ADMIN",
      },
    });
    adminCreated = true;
    logger.log(
      `  admin: ${ADMIN_EMAIL} created (password from SEED_ADMIN_PASSWORD)`,
    );
  }

  logger.log(`✅ Seed complete. Admin: ${ADMIN_EMAIL}.`);
  return { adminCreated, adminEmail: ADMIN_EMAIL };
}
