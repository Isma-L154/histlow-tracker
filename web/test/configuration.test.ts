/**
 * That an unconfigured IGDB is visible to whoever has to configure it.
 *
 * Every other way of producing no completion time names the stage it stopped
 * at. This branch did not: six milliseconds, no exception and no log, on the
 * one case that is somebody's to fix rather than an ordinary fact about a
 * game. Logging on every request was never the answer either - a deployment
 * that never set the secrets would write a line for every visitor - so it is
 * said once, where somebody asking the question would look.
 */

import { env } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import { serve } from "./serve.ts";

const BASE = "https://howtoachieve.cloudils.com";

/** The pool has no Twitch credentials, which is the state under test. */
const WITHOUT = env;

/** The same deployment with them set, to prove the report is not a constant. */
const WITH = { ...env, TWITCH_CLIENT_ID: "id", TWITCH_CLIENT_SECRET: "secret" };

async function get(path: string, using: Env): Promise<Response> {
  const response = await serve(new Request(`${BASE}${path}`), using);
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
    expect(body.features).toEqual({ completionTime: false });
  });

  it("reports them available once the credentials are set", async () => {
    const body = (await (await get("/api/health", WITH)).json()) as {
      features: Record<string, boolean>;
    };
    expect(body.features).toEqual({ completionTime: true });
  });

  it("still answers the question it answered before", async () => {
    // The deploy waits on `"ok":true` here; renaming it fails every deploy.
    const text = await (await get("/api/health", WITHOUT)).text();
    expect(text).toContain('"ok":true');
  });
});

describe("a completion time that nobody configured", () => {
  it("says so, on the first request that wanted one", async () => {
    // Must be the first test here to reach an IGDB route: `announced` is module
    // state, and the pool gives each file its own copy.
    const said = vi.spyOn(console, "log").mockImplementation(() => {});

    await get("/api/time/413150", WITHOUT);

    expect(said.mock.calls.flat().join(" ")).toContain("not configured");
  });

  it("does not say so again", async () => {
    // A site that never set the secrets would otherwise log for every visitor.
    await get("/api/time/413150", WITHOUT);
    const said = vi.spyOn(console, "log").mockImplementation(() => {});

    await get("/api/time/292030", WITHOUT);
    await get("/api/time/620", WITHOUT);

    expect(said.mock.calls.flat().join(" ")).not.toContain("not configured");
  });

  it("leaves the answer the page reads exactly as it was", async () => {
    const body = await (await get("/api/time/413150", WITHOUT)).json();
    expect(body).toEqual({ completionTime: null });
  });
});

describe("upcoming releases", () => {
  it("are no longer served: the home page stopped showing them", async () => {
    expect((await get("/api/upcoming", WITH)).status).toBe(404);
  });
});
