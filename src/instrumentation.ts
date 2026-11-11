import { logServerError, logServerWarning } from "@/lib/logger";
import { findProductionConfigProblems } from "@/lib/production-checks";

/** Runs once when the server starts: logs production misconfigurations (never the secret values). */
export async function register() {
  for (const problem of findProductionConfigProblems(process.env)) {
    logServerWarning(`config.${problem.severity}`, problem.message);
  }
}

/**
 * Next.js calls this for every UNHANDLED server error (render errors, route
 * handlers, server actions that throw). Combined with the contextual logs in
 * lib/errors.ts (checkout, upload, courier) this gives operators one
 * searchable JSON line per failure. No request bodies, headers, cookies or
 * query strings are logged — only the method, path and route type.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routeType?: string; routePath?: string; routerKind?: string },
) {
  logServerError("unhandled-request-error", error, {
    method: request.method,
    path: request.path.split("?")[0].slice(0, 200),
    routeType: context.routeType ?? null,
    routePath: context.routePath ?? null,
  });
}
