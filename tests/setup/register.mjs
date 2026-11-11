// Replaces server-only modules with test stubs so real service code can be
// imported under plain Node (no Next.js / Prisma install needed). Covers
// both ESM (module hooks) and CommonJS (`require`, which tsx uses for .ts).
import Module, { register } from "node:module";
import { STUBS } from "./map.mjs";

register("./hooks.mjs", import.meta.url);

const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (STUBS[request]) return STUBS[request];
  return original.call(this, request, ...rest);
};
