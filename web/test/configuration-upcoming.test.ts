/**
 * That the release list says it too.
 *
 * A separate file, and the separation is the point. `announced` is module
 * state, and the pool gives each test file its own copy - so the only way to
 * observe a branch that announces is to be the first thing in a file to reach
 * one. Alongside the completion-time cases, `/api/upcoming` ran with the flag
 * already set: the line was exercised and its behaviour was invisible.
 *
 * That was a live mutant. Deleting the announcement from this branch left all
 * 290 tests green, on half of what the change is named for, and review is what
 * caught it rather than the mutation table in the pull request.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("upcoming releases with no IGDB credentials", () => {
  it("says the credentials are missing", async () => {
    const said = vi.spyOn(console, "log").mockImplementation(() => {});

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://howtoachieve.cloudils.com/api/upcoming"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(said.mock.calls.flat().join(" ")).toContain("not configured");
    // And the home page is unchanged: the section is simply absent, as before.
    expect(await response.json()).toEqual({ releases: [] });
  });
});
