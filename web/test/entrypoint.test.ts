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

/**
 * That a cached answer cannot outlive the deploy that changed it.
 *
 * `cached()` keys on a normalised path and deliberately ignores the query
 * string, so nothing outside the Worker can force a fresh answer. Twice in two
 * days a route kept serving what it returned before its own fix — the
 * completion time and the release list — and both times the diagnosis went
 * down the wrong path first.
 *
 * Every key now carries the deployment id, so a publish invalidates by
 * construction. These assert that it stays that way, because the failure is
 * silent and only visible as a stale answer nobody can explain.
 *
 * They reach only as far as a key written as a literal at the call site. One
 * built into a variable first — as the guide corpus and the IGDB token both
 * are, deliberately, for reasons written where they are built — is invisible
 * here and has to be read by a person.
 */
describe("cache keys are scoped to the deployment", () => {
  it("builds every key through the one function that adds the version", () => {
    // A route that calls `cache.match` with a string of its own bypasses the
    // versioning entirely, which is how this would come back.
    const rogue = [...entry.matchAll(/cache\.(?:match|put)\(\s*[`"']/g)];
    expect(rogue.map((m) => m[0]), "build the key with key(url, …, env)").toEqual([]);
  });

  it("passes env to every key it builds", () => {
    // Without `env` the version is unavailable, and the call would not compile
    // — but a future overload or a default could make it compile and silently
    // drop the scoping.
    const calls = [...entry.matchAll(/\bkey\(url,[\s\S]{0,200}?\)\s*,/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      expect(call, `${call.slice(0, 60)} is not scoped`).toMatch(/,\s*env\s*\)/);
    }
  });
});
