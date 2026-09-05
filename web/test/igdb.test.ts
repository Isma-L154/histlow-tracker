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
  const EXACT = 0;

  /**
   * Deliberately not the real ids. Nothing may hardcode 6, 167 or 169: the
   * ids are resolved by name, and a test that used the real numbers would pass
   * just as well against code that had them baked in.
   */
  const PC = 901;
  const PS5 = 902;
  const XBOX = 903;

  const PLATFORM_ROWS = [
    { id: PC, name: "PC (Microsoft Windows)" },
    { id: PS5, name: "PlayStation 5" },
    { id: XBOX, name: "Xbox Series X|S" },
    { id: 904, name: "Nintendo Switch 2" },
  ];

  /** IGDB's four answers: platforms, the format id, the ranked games, their dates. */
  function stubUpcoming(
    games: unknown[],
    dates: unknown[],
    formatId: unknown = EXACT,
    platformRows: unknown[] = PLATFORM_ROWS,
  ) {
    // A game with no `platforms` of its own reaches a console, so the tests
    // about ranking and dates stay about ranking and dates. One that says
    // which platforms it has keeps them, which is what the filter tests need.
    const withPlatforms = games.map((game) =>
      game !== null && typeof game === "object" && !("platforms" in game)
        ? { ...game, platforms: [PS5] }
        : game,
    );
    return stub((url) =>
      url.endsWith("/platforms")
        ? json(platformRows)
        : url.endsWith("/platforms")
          ? json([{ id: 902, name: "PlayStation 5" }])
          : url.endsWith("/date_formats")
          ? json(formatId === null ? [] : [{ id: formatId, format: "YYYYMMMMDD" }])
          : url.endsWith("/games")
            ? json(withPlatforms)
            : json(dates),
    );
  }

  /** The request body sent to one endpoint, so a test does not count calls. */
  function bodyFor(calls: Array<{ url: string }>, endpoint: string): string {
    const call = calls.find((c) => c.url.endsWith(endpoint)) as
      | { init?: RequestInit }
      | undefined;
    return String(call?.init?.body ?? "");
  }

  it("ranks across all of IGDB, not within a window of dates", async () => {
    // The bug this replaces: fetching release dates nearest-first and ranking
    // what came back meant anything dated beyond the window was never
    // considered, however wanted. A wave of small titles next month buried the
    // one game everybody waits for. `games` now ranks natively by `hypes`.
    const calls = stubUpcoming([{ id: 1, name: "Wanted" }], [{ game: 1, date: 999, date_format: EXACT }]);
    await new IgdbClient("id", "tok").upcoming(6, NOW);

    const games = bodyFor(calls, "/games");
    expect(games).toContain("sort hypes desc");
    expect(games).toContain(`first_release_date > ${Math.floor(NOW / 1000)}`);
  });

  it("keeps the order IGDB ranked them in", async () => {
    stubUpcoming(
      [
        { id: 1, name: "Most wanted" },
        { id: 2, name: "Less wanted" },
      ],
      [
        // Deliberately the other way round by date, to prove date does not win.
        { game: 2, date: 100, date_format: EXACT },
        { game: 1, date: 900, date_format: EXACT },
      ],
    );
    const { releases } = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(releases.map((r) => r.name)).toEqual(["Most wanted", "Less wanted"]);
  });

  it("accepts a date-format id of zero", async () => {
    // IGDB's reference tables number from zero, and `positive()` - right for
    // every other field here, where zero means absent - rejected it. The whole
    // feature returned an empty list for ever, in silence. The same mistake as
    // the difficulty score treating a 0% achievement as no data.
    stubUpcoming([{ id: 1, name: "Real" }], [{ game: 1, date: 100, date_format: 0 }], 0);
    expect((await new IgdbClient("id", "tok").upcoming(6, NOW)).releases.map((r) => r.name)).toEqual(["Real"]);
  });

  it("asks IGDB for exact dates only", async () => {
    // IGDB pins "Q4 2026" to the start of the quarter, so a placeholder looks
    // like a real date. The filter is in the query rather than applied after.
    const calls = stubUpcoming([{ id: 1, name: "x" }], []);
    await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(bodyFor(calls, "/release_dates")).toContain(`date_format = ${EXACT}`);
  });

  it("shows nothing at all if the exact format cannot be resolved", async () => {
    // Nothing rather than everything: without the format, every placeholder
    // would be presented as a real date.
    stubUpcoming([{ id: 1, name: "x" }], [{ game: 1, date: 1, date_format: 0 }], null);
    expect((await new IgdbClient("id", "tok").upcoming(6, NOW)).releases).toEqual([]);
  });

  it("drops a wanted game that has no exact date yet", async () => {
    // Ordinary, and the reason the candidate list is over-fetched.
    stubUpcoming(
      [
        { id: 1, name: "No date yet" },
        { id: 2, name: "Dated" },
      ],
      [{ game: 2, date: 100, date_format: EXACT }],
    );
    expect((await new IgdbClient("id", "tok").upcoming(6, NOW)).releases.map((r) => r.name)).toEqual(["Dated"]);
  });

  it("keeps a game's earliest date when it has several", async () => {
    stubUpcoming(
      [{ id: 1, name: "Twice" }],
      [
        { game: 1, date: 100, date_format: EXACT },
        { game: 1, date: 500, date_format: EXACT },
      ],
    );
    const { releases } = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(releases).toHaveLength(1);
    expect(releases[0]!.releasedAt).toBe(100);
  });

  it("tells apart two games that share a title", async () => {
    // Keyed by id, not by name: a demo and its game can carry the same title,
    // and collapsing them loses the wrong one.
    stubUpcoming(
      [
        { id: 1, name: "Same Title" },
        { id: 2, name: "Same Title" },
      ],
      [
        { game: 1, date: 100, date_format: EXACT },
        { game: 2, date: 200, date_format: EXACT },
      ],
    );
    expect((await new IgdbClient("id", "tok").upcoming(6, NOW)).releases).toHaveLength(2);
  });

  it("builds a cover url only when there is a cover", async () => {
    stubUpcoming(
      [
        { id: 1, name: "With art", cover: { image_id: "abc" } },
        { id: 2, name: "Without art" },
      ],
      [
        { game: 1, date: 1, date_format: EXACT },
        { game: 2, date: 2, date_format: EXACT },
      ],
    );
    const { releases } = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(releases[0]!.coverUrl).toBe("https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg");
    expect(releases[1]!.coverUrl).toBeNull();
  });

  it.each([
    ["a game with no name", { id: 1 }],
    ["a game with no id", { name: "Nameless" }],
    ["a row that is not an object", null],
  ])("drops %s rather than rendering a blank card", async (_name, row) => {
    stubUpcoming([row], [{ game: 1, date: 1, date_format: EXACT }]);
    expect((await new IgdbClient("id", "tok").upcoming(6, NOW)).releases).toEqual([]);
  });

  it("honours the limit", async () => {
    const games = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `G${i}` }));
    const dates = games.map((g) => ({ game: g.id, date: 100 + g.id, date_format: EXACT }));
    stubUpcoming(games, dates);
    expect((await new IgdbClient("id", "tok").upcoming(4, NOW)).releases).toHaveLength(4);
  });

  it("does not ask IGDB for dates when no game qualified", async () => {
    const calls = stubUpcoming([], []);
    expect((await new IgdbClient("id", "tok").upcoming(6, NOW)).releases).toEqual([]);
    // Named rather than counted. This asserted a total of two calls, which
    // said "no dates were asked for" only as long as nothing else was ever
    // looked up - and resolving the platform ids by name made it three.
    expect(
      calls.filter((call) => call.url.endsWith("/release_dates")),
      "asked for dates for nothing",
    ).toEqual([]);
  });
});

describe("upcoming reaches consoles, and drops PC-only games", () => {
  const NOW = 1_800_000_000_000;
  const EXACT = 0;
  const PC = 901;
  const PS5 = 902;
  const XBOX = 903;

  const PLATFORM_ROWS = [
    { id: PC, name: "PC (Microsoft Windows)" },
    { id: PS5, name: "PlayStation 5" },
    { id: XBOX, name: "Xbox Series X|S" },
  ];

  function stubWith(games: unknown[], platformRows: unknown[] = PLATFORM_ROWS) {
    const dates = (games as Array<{ id: number }>).map((game) => ({
      game: game.id,
      date: 100,
      date_format: EXACT,
    }));
    return stub((url) =>
      url.endsWith("/platforms")
        ? json(platformRows)
        : url.endsWith("/platforms")
          ? json([{ id: 902, name: "PlayStation 5" }])
          : url.endsWith("/date_formats")
          ? json([{ id: EXACT, format: "YYYYMMMMDD" }])
          : url.endsWith("/games")
            ? json(games)
            : json(dates),
    );
  }

  async function names(): Promise<string[]> {
    const lookup = await new IgdbClient("id", "tok").upcoming(6, NOW);
    return lookup.releases.map((release) => release.name);
  }

  it("drops a game that only reaches PC", async () => {
    // The complaint this fixes: five of the six shown were PC-first indies,
    // because both queries asked for PC and nothing else.
    stubWith([{ id: 1, name: "PC-only indie", platforms: [PC] }]);
    expect(await names()).toEqual([]);
  });

  it("keeps a PlayStation exclusive", async () => {
    // Why the rule is "reaches a console" and not "reaches two platforms":
    // a first-party exclusive is as anticipated as anything and ships on one.
    stubWith([{ id: 1, name: "Sony exclusive", platforms: [PS5] }]);
    expect(await names()).toEqual(["Sony exclusive"]);
  });

  it("keeps an Xbox exclusive", async () => {
    stubWith([{ id: 1, name: "Xbox exclusive", platforms: [XBOX] }]);
    expect(await names()).toEqual(["Xbox exclusive"]);
  });

  it("keeps a game that reaches PC and a console", async () => {
    stubWith([{ id: 1, name: "Multiplatform AAA", platforms: [PC, PS5, XBOX] }]);
    expect(await names()).toEqual(["Multiplatform AAA"]);
  });

  it("drops a game that names no platform at all", async () => {
    // Absence is not proof it reaches a console, and offering it would put the
    // guess back in by another door.
    stubWith([{ id: 1, name: "Unknown platforms", platforms: [] }]);
    expect(await names()).toEqual([]);
  });

  it("keeps the ranked order across the ones that survive", async () => {
    stubWith([
      { id: 1, name: "Most wanted", platforms: [PS5] },
      { id: 2, name: "PC only", platforms: [PC] },
      { id: 3, name: "Less wanted", platforms: [XBOX] },
    ]);
    expect(await names()).toEqual(["Most wanted", "Less wanted"]);
  });

  it("asks IGDB for the consoles as well as PC", async () => {
    const calls = stubWith([{ id: 1, name: "x", platforms: [PS5] }]);
    await new IgdbClient("id", "tok").upcoming(6, NOW);
    for (const endpoint of ["/games", "/release_dates"]) {
      const body = String(
        (calls.find((c) => c.url.endsWith(endpoint)) as { init?: RequestInit })?.init?.body ?? "",
      );
      expect(body).toContain(String(PS5));
      expect(body).toContain(String(XBOX));
    }
  });

  it("resolves the platform ids by name rather than hardcoding them", async () => {
    // The ids here are invented. If anything in the client carries IGDB's real
    // 6, 167 or 169, this fails - which is the only way to prove a constant is
    // not hiding somewhere, the same reason the Steam source id is looked up.
    const calls = stubWith([{ id: 1, name: "x", platforms: [PS5] }]);
    await new IgdbClient("id", "tok").upcoming(6, NOW);
    const games = String(
      (calls.find((c) => c.url.endsWith("/games")) as { init?: RequestInit })?.init?.body ?? "",
    );
    // Guarded, because the assertion below passes against an empty string and
    // this test did exactly that until the client was actually called.
    expect(games).not.toEqual("");
    expect(games).not.toMatch(/\b(6|167|169)\b/);
  });

  it("offers nothing, and says so, when no console platform resolves", async () => {
    // A rename upstream must hide the section rather than quietly serve a list
    // ranked by the wrong thing.
    stubWith([{ id: 1, name: "x", platforms: [PS5] }], [{ id: PC, name: "PC (Microsoft Windows)" }]);
    const lookup = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(lookup.releases).toEqual([]);
    expect(lookup.stoppedAt).toMatch(/console/i);
  });
});

describe("upcoming says where it stopped", () => {
  const NOW = 1_800_000_000_000;

  it.each([
    ["no date format", [], [], null, /no full-date format/],
    ["no candidate games", [], [], 0, /no candidate games/],
    ["candidates but no exact dates ahead", [{ id: 1, name: "x", platforms: [902] }], [], 0, /none exact and ahead/],
  ])("reports %s", async (_name, games, dates, formatId, pattern) => {
    // Three stages come up empty and used to report the same nothing. That is
    // what made the completion time undiagnosable in #69, and this shipped
    // beside it with the same gap.
    stub((url) =>
      url.endsWith("/platforms")
        ? json([{ id: 902, name: "PlayStation 5" }])
        : url.endsWith("/date_formats")
        ? json(formatId === null ? [] : [{ id: formatId, format: "YYYYMMMMDD" }])
        : url.endsWith("/games")
          ? json(games)
          : json(dates),
    );
    const lookup = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(lookup.releases).toEqual([]);
    expect(lookup.stoppedAt).toMatch(pattern);
  });

  it("says nothing when it found something", () => {
    return stub((url) =>
      url.endsWith("/platforms")
        ? json([{ id: 902, name: "PlayStation 5" }])
        : url.endsWith("/date_formats")
        ? json([{ id: 0, format: "YYYYMMMMDD" }])
        : url.endsWith("/games")
          ? json([{ id: 1, name: "Real", platforms: [902] }])
          : json([{ game: 1, date: 100, date_format: 0 }]),
    ) && new IgdbClient("id", "tok").upcoming(6, NOW).then((lookup) => {
      expect(lookup.stoppedAt).toBeNull();
      expect(lookup.releases).toHaveLength(1);
    });
  });
});

describe("resolving the exact date format", () => {
  const NOW = 1_800_000_000_000;

  it("picks the format that ends in a day, whatever it is called", async () => {
    // The query filter `where format = "YYYYMMMMDD"` matched nothing in
    // production and could not say whether the string, the field name or the
    // comparison was wrong. Reading the table and matching in memory cannot be
    // wrong about a string.
    stub((url) =>
      url.endsWith("/platforms")
        ? json([{ id: 902, name: "PlayStation 5" }])
        : url.endsWith("/date_formats")
        ? json([
            { id: 2, format: "YYYY" },
            { id: 5, format: "YYYYQ4" },
            { id: 9, format: "YYYYMMMMDD" },
            { id: 7, format: "TBD" },
          ])
        : url.endsWith("/games")
          ? json([{ id: 1, name: "Real", platforms: [902] }])
          : json([{ game: 1, date: 100, date_format: 9 }]),
    );
    const lookup = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(lookup.releases.map((r) => r.name)).toEqual(["Real"]);
  });

  it("reports the formats it was offered when none is a full date", async () => {
    // So the next attempt reads the answer rather than guessing at a string.
    stub((url) =>
      url.endsWith("/platforms")
        ? json([{ id: 902, name: "PlayStation 5" }])
        : url.endsWith("/date_formats")
        ? json([{ id: 2, format: "YYYY" }, { id: 5, format: "YYYYQ4" }])
        : json([]),
    );
    const lookup = await new IgdbClient("id", "tok").upcoming(6, NOW);
    expect(lookup.stoppedAt).toContain("YYYY");
    expect(lookup.stoppedAt).toContain("YYYYQ4");
  });

  it("does not mistake a quarter for a full date", async () => {
    stub((url) =>
      url.endsWith("/platforms")
        ? json([{ id: 902, name: "PlayStation 5" }])
        : url.endsWith("/date_formats")
          ? json([{ id: 5, format: "YYYYQ4" }])
          : json([]),
    );
    expect((await new IgdbClient("id", "tok").upcoming(6, NOW)).releases).toEqual([]);
  });
});
