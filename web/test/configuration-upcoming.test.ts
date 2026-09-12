/**
 * That the release list says it too.
 *
 * A separate file, and the separation is the point: `announced` is module
 * state and the pool gives each file its own copy, so a branch that announces
 * can only be observed by the first thing in a file to reach one. Beside the
 * completion-time cases this ran with the flag already set, and deleting the
 * announcement left every test green.
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
