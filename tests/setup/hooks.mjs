import { STUBS, toUrl } from "./map.mjs";

export async function resolve(specifier, context, nextResolve) {
  if (STUBS[specifier]) return { url: toUrl(STUBS[specifier]), shortCircuit: true };
  return nextResolve(specifier, context);
}
