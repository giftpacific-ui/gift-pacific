import "server-only";
import { createSteadfastHistoryAdapter } from "@/server/services/courier-intelligence-providers/steadfast";
import type { HistoryAdapter, IntelProviderKey } from "@/lib/courier-intelligence/types";

/**
 * Every courier that HAS a history adapter, and how to build it (null = not configured). The keys are exactly the couriers whose descriptor says
 * `supported` (a test keeps the two equal), so a descriptor can never claim a capability that has no adapter behind it, and an adapter can never
 * exist for a courier documented as unsupported.
 *
 * Pathao and REDX are deliberately ABSENT: neither publishes a customer-history contract (see lib/courier-intelligence/registry.ts). Adding one is
 * a new file in this folder plus one line here, after the checklist in that registry is met. Nothing else changes: each courier is looked up,
 * cached, budgeted and failed independently of the others.
 */
export const HISTORY_ADAPTER_FACTORIES: Partial<Record<IntelProviderKey, () => HistoryAdapter | null>> = {
  steadfast: () => createSteadfastHistoryAdapter(),
};
