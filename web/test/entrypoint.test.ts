/**
 * That the entry module exports nothing but its handler.
 *
 * The runtime treats every named export of the entry module as a handler or a
 * binding and refuses to start otherwise - and `wrangler deploy --dry-run` does
 * not catch it, so the first sign would be production failing to come up. A
 * written rule caught nothing: a helper was exported here anyway and shipped.
 */

import { describe, expect, it } from "vitest";
import entry from "../src/index.ts?raw";
import * as module_ from "../src/index.ts";

/** Every Worker module, since the routes, the cache helpers and the pages live apart. */
const WORKER = Object.values(
  import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
).join("\n");

describe("src/index.ts", () => {
  it("exports only its default handler", () => {
    // The loaded module, so a re-export counts the same as an `export const`.
    expect(Object.keys(module_).filter((name) => name !== "default")).toEqual([]);
  });

  it("has a default export that the runtime would accept", () => {
    expect(typeof module_.default?.fetch).toBe("function");
  });

  it("writes no export keyword other than the default one", () => {
    // A type-only export compiles away, but reads the same as a value export a
    // later edit could turn real, so this reads the source.
    const exports = [...entry.matchAll(/^export\s+(?!default\b)(\w+)/gm)].map((m) => m[1]);
    expect(exports, "move it to a module that is allowed to export").toEqual([]);
  });
});

/**
 * That a cached answer cannot outlive the deploy that changed it.
 *
 * `cached()` keys on a normalised path and ignores the query string, so nothing
 * outside the Worker can force a fresh answer. Twice in two days a route kept
 * serving what it returned before its own fix. Every key carries the deployment
 * id now, and the failure this guards is silent: a stale answer nobody can explain.
 *
 * They read every Worker module, and reach only as far as a key written as a
 * literal at the call site. One built into a variable first - as the guide
 * corpus and the IGDB token both are, deliberately - has to be read by a person.
 */
describe("cache keys are scoped to the deployment", () => {
  it("builds every key through the one function that adds the version", () => {
    // A route calling `cache.match` with its own string bypasses the versioning.
    const rogue = [...WORKER.matchAll(/cache\.(?:match|put)\(\s*[`"']/g)];
    expect(rogue.map((m) => m[0]), "build the key with key(url, …, env)").toEqual([]);
  });

  it("passes env to every key it builds", () => {
    // A future overload or default could make an unscoped call compile.
    const calls = [...WORKER.matchAll(/\bkey\(url,[\s\S]{0,200}?\)\s*,/g)].map((m) => m[0]);
    expect(calls.length).toBeGreaterThan(3);
    for (const call of calls) {
      expect(call, `${call.slice(0, 60)} is not scoped`).toMatch(/,\s*env\s*\)/);
    }
  });
});
