/**
 * That the entry module exports nothing but its handler.
 *
 * The Workers runtime treats every named export of the entry module as a
 * handler or a binding, and rejects anything that is not one — at startup, with
 * *"the provided value is not of type 'function or ExportedHandler'"*. The
 * comment at the top of `http.ts` records this, which is why that file exists.
 *
 * A written rule caught nothing: a helper was exported from `index.ts` anyway
 * during #48 and shipped, surviving only because the runtime's check happens to
 * accept a function. Turning it into a constant later would have failed the
 * deploy — and `wrangler deploy --dry-run` does not catch it, so the first sign
 * would have been production refusing to start.
 */

import { describe, expect, it } from "vitest";
import entry from "../src/index.ts?raw";
import * as module_ from "../src/index.ts";

describe("src/index.ts", () => {
  it("exports only its default handler", () => {
    // Checked against the loaded module rather than the text, so a re-export or
    // an `export { x }` further down counts the same as an `export const`.
    expect(Object.keys(module_).filter((name) => name !== "default")).toEqual([]);
  });

  it("has a default export that the runtime would accept", () => {
    expect(typeof module_.default?.fetch).toBe("function");
  });

  it("writes no export keyword other than the default one", () => {
    // The module check above cannot see a type-only export, which compiles away
    // and is harmless — but it also cannot distinguish one from a value export
    // that a later edit turns real. This reads the source instead.
    const exports = [...entry.matchAll(/^export\s+(?!default\b)(\w+)/gm)].map((m) => m[1]);
    expect(exports, "move it to a module that is allowed to export").toEqual([]);
  });
});
