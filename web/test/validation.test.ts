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
import { DICTIONARY } from "../public/i18n.js";

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

describe("profile resolution bounds", () => {
  it("refuses an empty query", async () => {
    expect((await get("/api/steamid?q=")).status).toBe(400);
  });

  it("refuses an input past the cap before Steam sees it", async () => {
    // Same reasoning as the search ceiling: an unbounded parameter forwarded
    // upstream is free amplification against a quota this project cannot
    // afford to lose.
    expect((await get(`/api/steamid?q=${"a".repeat(500)}`)).status).toBe(400);
  });

  it.each([
    ["a link from another site", "https%3A%2F%2Fexample.com%2Fwhoever"],
    ["a mistyped id", "7656119800000000"],
    ["a name with a space", "some%20name"],
  ])("refuses %s", async (_name, query) => {
    expect((await get(`/api/steamid?q=${query}`)).status).toBe(400);
  });

  it("says something different for each way of being wrong", async () => {
    // The panel shows these, so one message for every failure would make a
    // mistyped id indistinguishable from a link to the wrong site.
    const messages = await Promise.all(
      ["", "7656119800000000", "https%3A%2F%2Fexample.com%2Fx", `${"a".repeat(500)}`].map(async (q) =>
        ((await (await get(`/api/steamid?q=${q}`)).json()) as { error: string }).error,
      ),
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("never echoes the query back", async () => {
    // `logFailure` redacts a steamid from a URL; an error message that quoted
    // the input would put one straight back into the response.
    const body = await (await get("/api/steamid?q=7656119800000000")).text();
    expect(body).not.toContain("7656119800000000");
  });
});

describe("profile errors carry a code, not just prose", () => {
  it.each([
    ["", "profile.empty"],
    ["7656119800000000", "profile.wrong length for an id"],
    ["https%3A%2F%2Fexample.com%2Fx", "profile.unrecognised link"],
    ["https%3A%2F%2Fsteamcommunity.com%2Fprofiles%2Fnotanid", "profile.not an id"],
  ])("%s reports %s", async (query, reason) => {
    // The client shows these in two languages, so it cannot use the sentence.
    // Without a code it falls back to the status table - which is written
    // about games, and answers a bad profile link with "this game has no
    // achievements on Steam".
    const body = (await (await get(`/api/steamid?q=${query}`)).json()) as { reason?: string };
    expect(body.reason).toBe(reason);
  });

  it("uses a code the dictionary actually has", async () => {
    const body = (await (await get("/api/steamid?q=")).json()) as { reason: string };
    expect(DICTIONARY.en[body.reason], `${body.reason} is not in the dictionary`).toBeDefined();
  });
});
