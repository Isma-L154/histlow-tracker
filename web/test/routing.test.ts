/**
 * Which requests reach Worker code at all.
 *
 * `run_worker_first` decides it, and nothing else in the suite can see it: the
 * other tests call the handler directly, so they prove what it does once
 * reached and never that anything reaches it. That gap produced a bug here - a
 * list of literal routes left every path matching no file with the asset
 * runtime, so the redirect from the former address never ran for them.
 *
 * These assert the shape of the pattern, which is the most that can be checked
 * without a deployed Worker; the behaviour was measured against `wrangler dev`.
 */

import { describe, expect, it } from "vitest";
import config from "../wrangler.jsonc?raw";

/** `run_worker_first`, parsed out of the commented config. */
function runWorkerFirst(): string[] {
  const withoutComments = config.replace(/^\s*\/\/.*$/gm, "");
  const match = /"run_worker_first"\s*:\s*\[([^\]]*)\]/.exec(withoutComments);
  expect(match, "run_worker_first is not an array in wrangler.jsonc").not.toBeNull();
  return [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("run_worker_first", () => {
  it("routes every document to the Worker, including paths that match no file", () => {
    // The SPA fallback serves unmatched paths without Worker code, which is
    // exactly where the redirect from the former address is most needed.
    expect(runWorkerFirst()).toContain("/*");
  });

  it("keeps static files off the Worker", () => {
    // The bulk of the requests, and none of them can be bookmarked or shared.
    const negated = runWorkerFirst().filter((pattern) => pattern.startsWith("!"));
    for (const extension of [".css", ".js", ".png"]) {
      expect(negated, `${extension} should be served by the asset runtime`).toContain(`!/*${extension}`);
    }
  });

  it("negates only file extensions, never a path", () => {
    // A negation like `!/game/*` would silently reopen the hole this closes,
    // and would look reasonable in a diff.
    for (const pattern of runWorkerFirst().filter((p) => p.startsWith("!"))) {
      expect(pattern, `${pattern} excludes a path, not a file type`).toMatch(/^!\/\*\.[a-z0-9]+$/);
    }
  });
});
