/**
 * That an unconfigured IGDB is visible to whoever has to configure it.
 *
 * Every other way of producing no completion time now names the stage it
 * stopped at. This branch did not:
 *
 *   const creds = credentials(env);
 *   if (!creds) return json({ completionTime: null });
 *
 * Six milliseconds, no exception and no log. It is also the branch that
 * matters most operationally - a missing credential is a fault someone has to
 * fix, while the others are ordinary facts about a game - and it is the one
 * that cost the most time in #69, where "the credentials are not reaching the
 * Worker" was the first hypothesis precisely because this path is invisible.
 * It turned out to be a stale cache.
 *
 * Logging on every request was never the answer: a deployment that has simply
 * never set the secrets would write a line on every page view for the lifetime
 * of the deployment. So it is said once, and it is said where somebody asking
 * the question would look.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index.ts";

const BASE = "https://howtoachieve.cloudils.com";

/** The pool has no Twitch credentials, which is the state under test. */
const WITHOUT = env;

/** The same deployment with them set, to prove the report is not a constant. */
const WITH = { ...env, TWITCH_CLIENT_ID: "id", TWITCH_CLIENT_SECRET: "secret" } as Env;

async function get(path: string, using: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`), using, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/api/health", () => {
  it("says which optional features this deployment can serve", async () => {
    const body = (await (await get("/api/health", WITHOUT)).json()) as {
      ok: boolean;
      features: Record<string, boolean>;
    };

    expect(body.ok).toBe(true);
    // Named for what a reader would miss, not for the credential behind it.
    // The absence is already visible on the page, so this reveals nothing a
    // visitor could not see - and an operator asking why the section is gone
    // has one place to look instead of a guess.
    expect(body.features).toMatchObject({ completionTime: false, upcoming: false });
  });

  it("reports them available once the credentials are set", async () => {
    const body = (await (await get("/api/health", WITH)).json()) as {
      features: Record<string, boolean>;
    };
    expect(body.features).toMatchObject({ completionTime: true, upcoming: true });
  });

  it("still answers the question it answered before", async () => {
    // The deploy waits on `"ok":true` in this body. Renaming or nesting it
    // would leave every deploy failing its own health check twelve times and
    // then reporting the site down.
    const text = await (await get("/api/health", WITHOUT)).text();
    expect(text).toContain('"ok":true');
  });
});

describe("a completion time that nobody configured", () => {
  it("says so, on the first request that wanted one", async () => {
    const said = vi.spyOn(console, "log").mockImplementation(() => {});

    await get("/api/time/413150", WITHOUT);

    expect(said.mock.calls.flat().join(" ")).toContain("not configured");
  });

  it("does not say so again", async () => {
    // The reason this was left silent in the first place, and still a good
    // one: a site that has never set the secrets would otherwise write a line
    // for every visitor, for ever.
    await get("/api/time/413150", WITHOUT);
    const said = vi.spyOn(console, "log").mockImplementation(() => {});

    await get("/api/time/292030", WITHOUT);
    await get("/api/upcoming", WITHOUT);

    expect(said.mock.calls.flat().join(" ")).not.toContain("not configured");
  });

  it("leaves the answer the page reads exactly as it was", async () => {
    const body = await (await get("/api/time/413150", WITHOUT)).json();
    expect(body).toEqual({ completionTime: null });
  });
});
