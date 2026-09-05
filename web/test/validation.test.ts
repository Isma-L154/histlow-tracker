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
import { credentials } from "../src/igdb.ts";
import { storable } from "../src/http.ts";
import { resolveSteamId } from "../src/profile.ts";
import { SteamError, unknownGame } from "../src/steam.ts";

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

describe("the profile route protects the Steam key", () => {
  it("caches the answer for a name Steam does not know", async () => {
    // The route spends the API key, and a name Steam has never heard of cannot
    // be answered from cache the first time. Without a lifetime on the failure,
    // the same wrong guess spends the key on every retry - so this is the one
    // failure in the Worker that is deliberately cacheable.
    //
    // Steam answers 200 with `success: 42` for a name it does not know, so the
    // status alone says nothing and the body has to be stubbed.
    const real = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ response: { success: 42 } }), {
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;

    try {
      const response = await get("/api/steamid?q=nobodyHasThisName");
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control"), "a stable failure with no lifetime").toMatch(/max-age=\d+/);
      expect(((await response.json()) as { reason: string }).reason).toBe("profile.unknown");
    } finally {
      globalThis.fetch = real;
    }
  });

  it.each([
    ["a rate-limit reply carries a code", "profile.tooMany"],
    ["an unknown profile carries a code", "profile.unknown"],
  ])("%s the dictionary has", (_name, reason) => {
    expect(DICTIONARY.en[reason], `${reason} is missing`).toBeDefined();
    expect(DICTIONARY.es[reason], `${reason} is missing in Spanish`).toBeDefined();
  });
});

describe("the completion-time route tells a failure from an absence", () => {
  /**
   * Replaces fetch, and supplies the credentials, for one call.
   *
   * The credentials matter: without them the route takes its "not configured"
   * branch and never reaches IGDB at all. Both of these tests passed for that
   * reason before it was noticed, which is worse than failing.
   */
  async function withIgdb<T>(handler: (url: string) => Response, run: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    const configured = env as unknown as { TWITCH_CLIENT_ID?: string; TWITCH_CLIENT_SECRET?: string };
    configured.TWITCH_CLIENT_ID = "test-client-id";
    configured.TWITCH_CLIENT_SECRET = "test-client-secret";
    globalThis.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(handler(typeof input === "string" ? input : String(input)))) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = real;
      delete configured.TWITCH_CLIENT_ID;
      delete configured.TWITCH_CLIENT_SECRET;
    }
  }

  it("reaches IGDB at all when the credentials are there", () => {
    // Guards the guard. If this ever stops being true, every test below starts
    // asserting the behaviour of the unconfigured branch instead.
    expect(credentials({ TWITCH_CLIENT_ID: "a", TWITCH_CLIENT_SECRET: "b" })).not.toBeNull();
  });

  it("does not cache an IGDB outage as a day of no data", async () => {
    // The bug this replaces: every failure was swallowed into a 200 saying
    // "no data", which `cached` then stored for a day. One outage during the
    // first request for a game poisoned that game for everyone until it
    // expired - long after IGDB had recovered.
    const response = await withIgdb(
      () => new Response("nope", { status: 500 }),
      () => get("/api/time/918274655"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control"), "an outage cached like an answer").toMatch(
      /no-store|max-age=(?:[0-9]|[1-9][0-9]|[1-9][0-9]{2})\b/,
    );
  });

  it("does cache a game IGDB genuinely has nothing for", async () => {
    // The other half. A game with no reported times is a stable fact, and
    // re-asking IGDB about it on every visit would spend the budget on an
    // answer that will not change.
    const response = await withIgdb(
      (url) =>
        url.includes("id.twitch.tv")
          ? new Response(JSON.stringify({ access_token: "t", expires_in: 5_000_000 }))
          : new Response("[]", { headers: { "Content-Type": "application/json" } }),
      () => get("/api/time/918274656"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ completionTime: null });
    expect(response.headers.get("Cache-Control") ?? "").not.toMatch(/no-store/);
  });
});

describe("storable", () => {
  it.each([
    ["a plain success", null, true, true],
    ["a success that set its own lifetime", "public, max-age=60", true, true],
    ["a stable failure with a lifetime", "public, max-age=3600", false, true],
    ["a transient failure", null, false, false],
    ["anything marked no-store", "no-store", true, false],
    ["a failure marked no-store", "no-store", false, false],
    ["no-store among other directives", "private, no-store, max-age=0", true, false],
  ])("%s", (_name, control, ok, expected) => {
    // Asserted here because the test pool does not exercise `caches.default`.
    // Without this, a rule that stopped honouring `no-store` would pass every
    // other test in the suite and cache the responses written to avoid it.
    expect(storable(control, ok)).toBe(expected);
  });
});

describe("resolveSteamId", () => {
  // The line between the path the cache defends and the path that cannot be
  // cached at all, so it decides which requests have to be limited instead.
  it.each([
    ["a request that names an id", "76561190000000000", undefined, "76561190000000000"],
    ["the deployment's own id when none is asked for", null, "76561190000000001", "76561190000000001"],
    ["a request overriding the deployment's id", "76561190000000000", "76561190000000001", "76561190000000000"],
    ["nothing asked for and none configured", null, undefined, null],
    ["sixteen digits", "7656119000000000", undefined, null],
    ["eighteen digits", "765611900000000000", undefined, null],
    ["digits with a space", "76561190000000000 ", undefined, null],
    ["something that is not a number", "notanid", undefined, null],
    ["an empty parameter", "", undefined, null],
  ])("%s", (_name, requested, fallback, expected) => {
    expect(resolveSteamId(requested, fallback)).toBe(expected);
  });

  it("refuses an injection dressed as an id", () => {
    // This value is forwarded into an upstream query, so its shape is the only
    // thing standing between a caller and Steam's parameters.
    expect(resolveSteamId("76561190000000000&key=x", undefined)).toBeNull();
  });
});

describe("unknownGame", () => {
  // Asserted here because reaching it through the route means calling Steam,
  // and the suite is offline. What it decides is whether a 404 is stored: get
  // it wrong upward and an outage silences a real game for a day; wrong
  // downward and every repeat of a wrong id spends the key again.
  it("recognises a game Steam has nothing for", () => {
    expect(unknownGame(new SteamError("no achievements", 404))).toBe(true);
  });

  it("recognises Steam's own 404", () => {
    expect(unknownGame(new SteamError("no achievements", 404, 404))).toBe(true);
  });

  it("refuses an outage wearing a 404", () => {
    // The case that must never be cached: Steam broke, the game is fine.
    expect(unknownGame(new SteamError("upstream failed", 404, 503))).toBe(false);
  });

  it("refuses a status that is not a 404", () => {
    expect(unknownGame(new SteamError("bad gateway", 502, 502))).toBe(false);
  });

  it("refuses an error that is not Steam's", () => {
    expect(unknownGame(new TypeError("network"))).toBe(false);
    expect(unknownGame(null)).toBe(false);
  });
});
