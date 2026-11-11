<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Gift Pacific — project rules (permanent)

<!-- branding-guard:allow (mandated instruction names the old brand) -->
**The active brand is Gift Pacific. Never reintroduce Aura & Petals or Aura branding in new development.**

Branding
- Human-readable name: `Gift Pacific`. Technical identifier: `giftpacific`. The previous brand is permanently discontinued: do not use it (or abbreviations derived from it) in code, UI, metadata, configuration, storage/cookie/cache keys, test fixtures, seed values, generated content or documentation.
- `pnpm check:branding` (`scripts/check-branding.mjs`) must pass before any change is finished. It fails on old-brand text, file names, image metadata and the retired logo/favicon files. Do not weaken it. The only exceptions are `prisma/migrations/**` (history is never rewritten) and lines explicitly marked `branding-guard:allow` for documented legacy compatibility (see `HANDOFF_GIFTPACIFIC.md` §1.1). Do not add new exceptions without the owner's approval.
- No Gift Pacific logo/favicon asset exists yet. Never invent, generate or restore one; the UI uses the text store name until the owner supplies assets.

Working rules
- Project documents: `HANDOFF_GIFTPACIFIC.md` is the **only** project handoff (read it first; update it when behaviour changes). `MASTER_ROADMAP.md` is the authoritative Phase 0–11 plan: **never delete, rename, merge or silently replace a phase**, never mark a phase Completed without evidence, and map every deferred item to its original phase. `RELEASE_AUDIT.md` and `RELEASE_CHECKLIST.md` record the emergency release. Do not create other handoff, status or changelog files.
- Production safety: never run `migrate reset`, `db push`, destructive SQL or `migrate deploy` against production without the owner's explicit approval; production-only checks stay BLOCKED / OWNER ACTION REQUIRED until the owner performs them. Optional records (banners, campaigns, categories) can be absent: never dereference them unguarded.
- Inspect the real source before changing anything. Do not describe a feature as working because code exists; say what was actually executed. Never claim a check passed unless you ran it, and report blocked checks as NOT RUN with the reason.
- Never edit, rename or delete an applied Prisma migration; add a new one. Use `prisma migrate deploy` on real databases, never `migrate dev`/`reset`/`db push`.
- Never commit secrets or `.env` files. Do not change pricing, stock, order-lifecycle, payment/refund, fraud-scoring or courier behaviour as a side effect of another task.
- Do not invent third-party API details or integrations (Pathao, RedX, Nagad); every adapter needs official documentation.
- Files with `"use server"` may export only `async function`s (Next.js 16 / Turbopack).
