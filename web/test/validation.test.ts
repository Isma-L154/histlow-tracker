/**
 * Input bounds on the public routes.
 *
 * Every one of these is reachable by anyone with the URL, so the limits are
 * the whole defence. They are asserted against the real handler in workerd,
 * not against a re-implementation of the regexes.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const BASE = "https://example.com";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("search query bounds", () => {
  it("rejects a query below the minimum", async () => {
    expect((await get("/api/search?q=a")).status).toBe(400);
  });

  it("rejects a query above the maximum", async () => {
    // Steam's longest title is nowhere near this. An unbounded parameter was
    // forwarded whole to Steam, which is free amplification against its quota.
    const long = "a".repeat(200);
    expect((await get(`/api/search?q=${long}`)).status).toBe(400);
  });

  it("names the limit rather than repeating the minimum", async () => {
    const body = await (await get(`/api/search?q=${"a".repeat(200)}`)).json();
    expect((body as { error: string }).error).not.toMatch(/dos caracteres|two characters/i);
  });

  it("accepts a realistic title at the boundary", async () => {
    // 100 characters exactly: allowed. Off-by-one here would reject real games.
    const response = await get(`/api/search?q=${"a".repeat(100)}`);
    expect(response.status).not.toBe(400);
  });
});

describe("route patterns", () => {
  it("refuses an app id longer than ten digits", async () => {
    expect((await get("/api/game/12345678901")).status).toBe(404);
  });

  it("refuses a non-numeric app id", async () => {
    expect((await get("/api/game/abc")).status).toBe(404);
  });

  it("refuses an achievement key past the length cap", async () => {
    expect((await get(`/api/howto/367520/${"k".repeat(200)}`)).status).toBe(404);
  });

  it("rejects malformed percent encoding with 400, not 500", async () => {
    expect((await get("/api/howto/367520/%FF%FE")).status).toBe(400);
  });

  it("answers health without any credential", async () => {
    expect((await get("/api/health")).status).toBe(200);
  });
});
