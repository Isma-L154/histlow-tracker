/**
 * The IGDB client, against a stubbed transport.
 *
 * There are no credentials in CI and there must never be: a test that reaches
 * the real IGDB would spend a shared rate limit, fail whenever someone else's
 * network did, and prove nothing about this code. `fetch` is replaced instead,
 * which also makes the failure cases - a 401, a 500, a body that is not what
 * the docs promise - reachable at all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { IgdbClient, accessToken, credentials, usable } from "../src/igdb.ts";

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
  vi.restoreAllMocks();
});

/** Replaces fetch, recording what was asked for. */
function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("credentials", () => {
  it.each([
    ["both absent", {}],
    ["only the id", { TWITCH_CLIENT_ID: "abc" }],
    ["only the secret", { TWITCH_CLIENT_SECRET: "xyz" }],
    ["blank strings", { TWITCH_CLIENT_ID: "  ", TWITCH_CLIENT_SECRET: "  " }],
  ])("reports the feature off when %s", (_name, env) => {
    // Not an error. Until the Twitch application exists the site works exactly
    // as it does today, and that must be a quiet state rather than one that
    // logs on every request.
    expect(credentials(env)).toBeNull();
  });

  it("reads both when they are set", () => {
    expect(credentials({ TWITCH_CLIENT_ID: "abc", TWITCH_CLIENT_SECRET: "xyz" })).toEqual({
      clientId: "abc",
      clientSecret: "xyz",
    });
  });
});

describe("accessToken", () => {
  it("returns the token and when to stop trusting it", async () => {
    stub(() => json({ access_token: "tok", expires_in: 5_000_000 }));
    const token = await accessToken({ clientId: "a", clientSecret: "b" }, 1000);
    expect(token.value).toBe("tok");
    // Expiry is pulled back by the safety margin, so the token is never sent
    // in the window where our clock and Twitch's might disagree.
    expect(token.expiresAt).toBe(1000 + (5_000_000 - 300) * 1000);
  });

  it("does not quote the response body on failure", async () => {
    // The request carries the client secret in its query string and Twitch
    // quotes the request back on error, so the body must never reach a log.
    stub(() => json({ message: "invalid client secret: super-secret-value" }, 403));
    await expect(accessToken({ clientId: "a", clientSecret: "super-secret-value" }, 0)).rejects.toThrow(
      /^Twitch returned 403/,
    );
    await expect(accessToken({ clientId: "a", clientSecret: "super-secret-value" }, 0)).rejects.not.toThrow(
      /super-secret-value/,
    );
  });

  it.each([
    ["no token", { expires_in: 1000 }],
    ["no lifetime", { access_token: "tok" }],
    ["a lifetime of zero", { access_token: "tok", expires_in: 0 }],
    ["a token that is not a string", { access_token: 42, expires_in: 1000 }],
  ])("refuses a response with %s", async (_name, body) => {
    stub(() => json(body));
    await expect(accessToken({ clientId: "a", clientSecret: "b" }, 0)).rejects.toThrow(/no usable/);
  });
});

describe("usable", () => {
  it.each([
    ["a live token", { value: "t", expiresAt: 2000 }, 1000, true],
    ["an expired token", { value: "t", expiresAt: 500 }, 1000, false],
    ["a token expiring exactly now", { value: "t", expiresAt: 1000 }, 1000, false],
    ["an empty token", { value: "", expiresAt: 9999 }, 1000, false],
  ])("says %s", (_name, token, now, expected) => {
    expect(usable(token, now)).toBe(expected);
  });
});

describe("completionTime", () => {
  it("says where it stopped when there is no time", async () => {
    // Three different things produce no time. Until they were told apart, a
    // query that had silently stopped matching looked exactly like a game
    // nobody had timed - which is how this shipped broken.
    const cases: Array<[name: string, external: unknown[], times: unknown[], stoppedAt: string]> = [
      ["IGDB does not know the game", [], [], "no game for that Steam id"],
      ["there are no times", [{ game: 1 }], [], "no times for that game"],
      ["the times row is empty", [{ game: 1 }], [{ normally: 0 }], "times present but empty"],
    ];
    for (const [name, external, times, stoppedAt] of cases) {
      stub((url) =>
        url.endsWith("/external_game_sources")
          ? json([{ id: 1 }])
          : url.endsWith("/external_games")
            ? json(external)
            : json(times),
      );
      const lookup = await new IgdbClient("id", "tok").completionTime(1);
      expect(lookup.time, name).toBeNull();
      expect(lookup.stoppedAt, name).toBe(stoppedAt);
    }
  });

  it("resolves Steam's source by name rather than assuming a number", async () => {
    // `external_games.category` is deprecated and its replacement's value for
    // Steam is documented nowhere. Assuming it kept the old number would risk
    // matching a different store silently.
    const calls = stub((url) =>
      url.endsWith("/external_game_sources")
        ? json([{ id: 55 }])
        : url.endsWith("/external_games")
          ? json([{ game: 1234 }])
          : json([{ completely: 216000 }]),
    );
    await new IgdbClient("id", "tok").completionTime(367520);
    expect(String(calls[0]!.init!.body)).toContain('name = "Steam"');
    expect(String(calls[1]!.init!.body)).toContain("external_game_source = 55");
  });

  it("falls back to the deprecated filter if the source cannot be resolved", async () => {
    const calls = stub((url) =>
      url.endsWith("/external_game_sources")
        ? new Response("nope", { status: 404 })
        : url.endsWith("/external_games")
          ? json([{ game: 1 }])
          : json([{ completely: 1 }]),
    );
    await new IgdbClient("id", "tok").completionTime(1);
    expect(String(calls[1]!.init!.body)).toContain("category = 1");
  });

  it("matches the game by Steam app id, not by name", async () => {
    // A wrong completion time looks exactly like a right one, so the match has
    // to be on an identifier rather than on a title that every franchise
    // reuses for remasters and demos.
    const calls = stub((url) =>
      url.endsWith("/external_game_sources")
        ? json([{ id: 1 }])
        : url.endsWith("/external_games")
          ? json([{ game: 1234 }])
          : json([{ normally: 97200, completely: 216000 }]),
    );
    const { time } = await new IgdbClient("id", "tok").completionTime(367520);

    expect(time).toEqual({ normally: 97200, completely: 216000 });
    expect(String(calls[1]!.init!.body)).toContain('uid = "367520"');
    expect(String(calls[2]!.init!.body)).toContain("game_id = 1234");
  });

  it("sends the credentials in headers, never in the query", async () => {
    const calls = stub(() => json([]));
    await new IgdbClient("my-client-id", "my-token").completionTime(1);
    const { url, init } = calls[0]!;
    expect(url).not.toContain("my-client-id");
    expect(url).not.toContain("my-token");
    expect(new Headers(init!.headers).get("Client-ID")).toBe("my-client-id");
    expect(new Headers(init!.headers).get("Authorization")).toBe("Bearer my-token");
  });

  it.each([
    ["IGDB does not know the game", [] as unknown[], null],
    ["there is no time row", [{ game: 1 }], []],
  ])("returns null when %s", async (_name, first, second) => {
    stub((url) => (url.endsWith("/external_game_sources") ? json([{ id: 1 }]) : url.endsWith("/external_games") ? json(first) : json(second ?? [])));
    expect((await new IgdbClient("id", "tok").completionTime(1)).time).toBeNull();
  });

  it("returns null rather than a row of nothing", async () => {
    stub((url) => (url.endsWith("/external_game_sources") ? json([{ id: 1 }]) : url.endsWith("/external_games") ? json([{ game: 1 }]) : json([{ normally: 0 }])));
    expect((await new IgdbClient("id", "tok").completionTime(1)).time).toBeNull();
  });

  it("keeps a partial answer", async () => {
    stub((url) => (url.endsWith("/external_game_sources") ? json([{ id: 1 }]) : url.endsWith("/external_games") ? json([{ game: 1 }]) : json([{ completely: 216000 }])));
    expect((await new IgdbClient("id", "tok").completionTime(1)).time).toEqual({
      normally: null,
      completely: 216000,
    });
  });

  it.each([401, 429, 500])("throws on HTTP %i so the caller can tell it apart from no data", async (status) => {
    // Hiding the section is right either way, but an outage or a revoked
    // credential is the operator's problem and has to be distinguishable.
    stub(() => json({}, status));
    await expect(new IgdbClient("id", "tok").completionTime(1)).rejects.toThrow(String(status));
  });

  it("does not treat an unexpected body as data", async () => {
    stub(() => json({ error: "nope" }));
    expect((await new IgdbClient("id", "tok").completionTime(1)).time).toBeNull();
  });
});

describe("upcoming", () => {
  const NOW = 1_800_000_000_000;
  const EXACT = 3;

  /** IGDB's answers, with the date-format lookup already resolved. */
  function stubReleases(rows: unknown[]) {
    return stub((url) =>
      url.endsWith("/date_formats") ? json([{ id: EXACT }]) : json(rows),
    );
  }

  it("asks only for PC dates still ahead, with an anticipation figure", async () => {
    const calls = stubReleases([]);
    await new IgdbClient("id", "tok").upcoming(6, NOW);
    const body = String(calls[1]!.init!.body);

    expect(body).toContain(`date > ${Math.floor(NOW / 1000)}`);
    expect(body).toContain("platform = 6");
    expect(body).toContain("game.hypes != null");
  });

  it("does not ask IGDB to sort by a nested field", async () => {
    // `hypes` belongs to the game, not to the release date, and sorting by a
    // nested field is not documented. The ordering happens here instead.
    const calls = stubReleases([]);
    await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(String(calls[1]!.init!.body)).not.toContain("sort game.hypes");
  });

  it("orders by anticipation, not by date", async () => {
    stubReleases([
      { date: 100, date_format: EXACT, game: { name: "Soon but ignored", hypes: 5 } },
      { date: 900, date_format: EXACT, game: { name: "Later but wanted", hypes: 900 } },
    ]);
    const releases = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(releases.map((r) => r.name)).toEqual(["Later but wanted", "Soon but ignored"]);
  });

  it("drops a date IGDB did not mark as exact", async () => {
    // IGDB pins "Q4 2026" to the start of the quarter, so the date looks real.
    // Counting down to it would invent a precision nobody has.
    stubReleases([
      { date: 100, date_format: EXACT, game: { name: "Real date", hypes: 1 } },
      { date: 200, date_format: 7, game: { name: "Some quarter", hypes: 999 } },
    ]);
    const releases = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(releases.map((r) => r.name)).toEqual(["Real date"]);
  });

  it("shows nothing at all if the exact format cannot be resolved", async () => {
    // Nothing rather than everything: without the format, every placeholder
    // would be presented as a real date.
    stub((url) => (url.endsWith("/date_formats") ? json([]) : json([{ date: 1, game: { name: "x", hypes: 1 } }])));
    expect(await new IgdbClient("id", "tok").upcoming(6, NOW)).toEqual([]);
  });

  it("keeps one entry per game", async () => {
    // A game can carry several dates on one platform. The rows arrive in date
    // order, so the earliest is the one kept.
    stubReleases([
      { date: 100, date_format: EXACT, game: { name: "Twice", hypes: 5 } },
      { date: 500, date_format: EXACT, game: { name: "Twice", hypes: 5 } },
    ]);
    const releases = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.releasedAt).toBe(100);
  });

  it("builds a cover url only when there is a cover", async () => {
    stubReleases([
      { date: 1, date_format: EXACT, game: { name: "With art", hypes: 2, cover: { image_id: "abc" } } },
      { date: 2, date_format: EXACT, game: { name: "Without art", hypes: 1 } },
    ]);
    const releases = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(releases[0]!.coverUrl).toBe("https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg");
    expect(releases[1]!.coverUrl).toBeNull();
  });

  it.each([
    ["a row with no name", { date: 1, date_format: 3, game: {} }],
    ["a row with no date", { date_format: 3, game: { name: "Someday", hypes: 1 } }],
    ["a row that is not an object", null],
  ])("drops %s rather than rendering a blank card", async (_name, row) => {
    stubReleases([row]);
    expect(await new IgdbClient("id", "tok").upcoming(6, NOW)).toEqual([]);
  });

  it("honours the limit", async () => {
    stubReleases(
      Array.from({ length: 30 }, (_, i) => ({ date: i + 1, date_format: EXACT, game: { name: `G${i}`, hypes: i } })),
    );
    expect(await new IgdbClient("id", "tok").upcoming(4, NOW)).toHaveLength(4);
  });
});
