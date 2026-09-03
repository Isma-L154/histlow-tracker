/**
 * IGDB, for the things Steam does not publish.
 *
 * Steam knows nothing about how long a game takes to finish, and nothing about
 * what is coming out next. HowLongToBeat is the reference players know and is
 * not usable: its `robots.txt` disallows `/api`, the exact endpoint that would
 * be called, and the terms it links prohibit automated retrieval by name.
 *
 * IGDB is official, free, documented, and rate-limited in the open. It
 * authenticates through Twitch, so it costs two secrets - and everything here
 * is written so that not having them is an ordinary state rather than a
 * failure: the caller gets null and the page renders without the section.
 */

/** IGDB allows four requests a second; nothing here comes close. */
const TIMEOUT_MS = 5000;

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.igdb.com/v4";

/**
 * How early to stop trusting a token.
 *
 * Twitch tokens last about sixty days, so this is not about churn. It is about
 * never handing IGDB a token that expires between our clock and theirs.
 */
const EXPIRY_MARGIN_SECONDS = 300;

/**
 * How IGDB marks a Steam listing on `external_games`.
 *
 * Documented as Steam (1), alongside GOG (5) and Epic (26). The field itself is
 * deprecated in favour of `external_game_source`, and it is used anyway,
 * deliberately: the replacement is a reference id whose value for Steam is not
 * documented anywhere. Guessing that it kept the old number would risk silently
 * matching a different store, and a wrong completion time is the one failure
 * this module is built to avoid, because nothing about it looks wrong.
 *
 * If IGDB removes the field, the query fails, `completionTime` throws, the
 * section hides and the failure is logged. That is a safe and visible way to
 * find out - at which point the fix is to resolve the id by name from
 * `external_game_sources` rather than to guess a new constant.
 */
const EXTERNAL_CATEGORY_STEAM = 1;

/** IGDB's platform id for PC (Microsoft Windows). */
const PC_PLATFORM = 6;

/** Where IGDB serves cover art. Also needs an entry in the page's CSP. */
const IMAGE_BASE = "https://images.igdb.com/igdb/image/upload";

/**
 * What a lookup produced, and where it stopped if it produced nothing.
 *
 * The reason travels because the three ways of finding no time are three
 * different operational facts, and the logs could not tell them apart - which
 * is how a query that had stopped matching went unnoticed until someone
 * checked production by hand.
 */
export interface Lookup {
  time: CompletionTime | null;
  stoppedAt: string | null;
}

export interface CompletionTime {
  /** Seconds to finish the story, as IGDB reports it. */
  normally: number | null;
  /** Seconds to finish everything, which is what this site is about. */
  completely: number | null;
}

export interface UpcomingRelease {
  name: string;
  /** Unix seconds. Only ever a date IGDB marked as exact. */
  releasedAt: number;
  coverUrl: string | null;
}

/** Everything the client needs, so the caller owns the lifetime of the token. */
export interface IgdbCredentials {
  clientId: string;
  clientSecret: string;
}

interface Token {
  value: string;
  expiresAt: number;
}

/**
 * Reads the credentials, or reports that the feature is simply off.
 *
 * Absent secrets are not an error. Until the maintainer creates the Twitch
 * application the site works exactly as it does today, and that has to be a
 * quiet state rather than one that logs on every request.
 */
export function credentials(env: {
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
}): IgdbCredentials | null {
  const clientId = env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = env.TWITCH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * A client for one request cycle.
 *
 * The token is handed in rather than fetched here, because it belongs in the
 * edge cache and this class should not know about caches. `accessToken` below
 * is the piece the caller caches.
 */
export class IgdbClient {
  constructor(
    private readonly clientId: string,
    private readonly token: string,
  ) {}

  /**
   * How long a Steam game takes to finish, or null.
   *
   * Matched by Steam app id through IGDB's external-game table rather than by
   * title. Title matching produces confident wrong answers - every franchise
   * has a remaster and a demo - and a wrong completion time is worse than none,
   * because nothing about it looks wrong.
   */
  async completionTime(steamAppId: number): Promise<Lookup> {
    const gameId = await this.gameIdForSteamApp(steamAppId);
    // Reported rather than swallowed. Three different things produce no time,
    // and until the caller can tell them apart, a query that has silently
    // stopped matching looks exactly like a game nobody has timed.
    if (gameId === null) return { time: null, stoppedAt: "no game for that Steam id" };

    const rows = await this.query<{ normally?: number; completely?: number }>(
      "game_time_to_beats",
      `fields normally, completely; where game_id = ${gameId}; limit 1;`,
    );

    const row = rows[0];
    if (!row) return { time: null, stoppedAt: "no times for that game" };

    const time = {
      normally: positive(row.normally),
      completely: positive(row.completely),
    };
    if (time.normally === null && time.completely === null) {
      return { time: null, stoppedAt: "times present but empty" };
    }
    return { time, stoppedAt: null };
  }

  /**
   * The most anticipated games with a real release date ahead of them.
   *
   * Two queries, in this order, because the order is the whole point.
   *
   * The obvious shape - fetch release dates nearest first, rank what comes back
   * by anticipation - is wrong, and quietly. Anything dated beyond the fetch
   * window is never considered however wanted it is, so a wave of small titles
   * releasing next month can bury the one game everybody is waiting for. The
   * ranking has to happen across all of IGDB, not across a slice of it.
   *
   * So `games` ranks first, natively, by `hypes` - which lives on the game and
   * is what `sort` can actually order by. Then the exact dates for those games
   * are fetched separately, because `games` carries only
   * `first_release_date`, which IGDB sets even for a placeholder: a "Q4 2026"
   * title is pinned to the start of its quarter, and counting down to that
   * invents a precision nobody has.
   *
   * Precision comes from `date_format`, whose id is resolved by name rather
   * than assumed. Over-fetches candidates because some of the most anticipated
   * games have no exact date yet, and those drop out.
   */
  async upcoming(limit: number, now: number): Promise<UpcomingRelease[]> {
    const exact = await this.exactDateFormatId();
    // Without it, nothing rather than everything: a countdown to a guessed
    // date is worse than no countdown.
    if (exact === null) return [];

    const seconds = Math.floor(now / 1000);
    const candidates = await this.query<{
      id?: number;
      name?: string;
      cover?: { image_id?: string };
    }>(
      "games",
      `fields id, name, cover.image_id;` +
        ` where first_release_date > ${seconds} & platforms = ${PC_PLATFORM} & hypes != null;` +
        ` sort hypes desc; limit ${Math.min(100, limit * 5)};`,
    );

    // Keyed by id rather than by name: two IGDB entries can share a title - a
    // demo and its game, a remaster - and collapsing those loses the wrong one.
    const games = new Map<number, { name: string; coverUrl: string | null }>();
    for (const row of candidates) {
      if (row === null || typeof row !== "object") continue;
      const id = identifier(row.id);
      if (id === null || !row.name) continue;
      const imageId = row.cover?.image_id;
      games.set(id, {
        name: row.name,
        coverUrl: imageId ? `${IMAGE_BASE}/t_cover_big/${imageId}.jpg` : null,
      });
    }
    if (games.size === 0) return [];

    const dates = await this.query<{ game?: number; date?: number; date_format?: number }>(
      "release_dates",
      `fields game, date, date_format;` +
        ` where game = (${[...games.keys()].join(",")}) & platform = ${PC_PLATFORM}` +
        ` & date > ${seconds} & date_format = ${exact};` +
        ` sort date asc; limit 200;`,
    );

    // `candidates` came back ranked, so walking it preserves that order and the
    // dates only have to be looked up. A game with several PC dates keeps its
    // earliest, which is what arriving in date order gives.
    const earliest = new Map<number, number>();
    for (const row of dates) {
      if (row === null || typeof row !== "object") continue;
      const game = identifier(row.game);
      const date = positive(row.date);
      if (game === null || date === null || earliest.has(game)) continue;
      earliest.set(game, date);
    }

    const releases: UpcomingRelease[] = [];
    for (const [id, game] of games) {
      const releasedAt = earliest.get(id);
      // No exact date yet. Ordinary for an anticipated game, and the reason
      // this over-fetches candidates.
      if (releasedAt === undefined) continue;
      releases.push({ ...game, releasedAt });
      if (releases.length === limit) break;
    }
    return releases;
  }

  /** The `date_formats` row meaning a full day-month-year date. */
  private async exactDateFormatId(): Promise<number | null> {
    try {
      const rows = await this.query<{ id?: number }>(
        "date_formats",
        `fields id; where format = "YYYYMMMMDD"; limit 1;`,
      );
      return identifier(rows[0]?.id);
    } catch {
      return null;
    }
  }

  /**
   * IGDB's own id for a game, found through its Steam listing.
   *
   * Filtered on `external_game_source` resolved by name, with the deprecated
   * `category` as a fallback. The replacement field is a reference id whose
   * value for Steam is documented nowhere, so it is looked up rather than
   * guessed - guessing risks matching a different store silently, which is the
   * one failure this module exists to avoid.
   */
  private async gameIdForSteamApp(steamAppId: number): Promise<number | null> {
    const source = await this.steamSourceId();
    const filter =
      source === null
        ? `category = ${EXTERNAL_CATEGORY_STEAM}`
        : `external_game_source = ${source}`;

    const rows = await this.query<{ game?: number }>(
      "external_games",
      `fields game; where uid = "${steamAppId}" & ${filter}; limit 1;`,
    );
    return positive(rows[0]?.game);
  }

  /** Steam's row in `external_game_sources`, found by its name. */
  private async steamSourceId(): Promise<number | null> {
    try {
      const rows = await this.query<{ id?: number }>(
        "external_game_sources",
        `fields id; where name = "Steam"; limit 1;`,
      );
      return identifier(rows[0]?.id);
    } catch {
      // The endpoint is newer than the field it replaces. Falling back to the
      // deprecated filter is better than failing outright.
      return null;
    }
  }

  /**
   * One IGDB query.
   *
   * Throws on anything unexpected. Every caller in this project treats a throw
   * as "no data" and hides its section, so a failure costs a missing panel and
   * never a broken page - but it is still a throw, so the caller can tell the
   * difference between IGDB having nothing and IGDB being unreachable.
   */
  private async query<T>(endpoint: string, body: string): Promise<T[]> {
    const response = await fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": this.clientId,
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // The body can quote the query but never the token, which travels in a
      // header. Status alone is what a caller can act on.
      throw new Error(`IGDB returned ${response.status} for ${endpoint}`);
    }

    const parsed = await response.json();
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
}

/**
 * Exchanges the credentials for an access token.
 *
 * Kept out of the client so the caller can cache the result. Asking Twitch for
 * a token on every page view would add a round trip to every request and spend
 * a rate limit on work whose answer is valid for two months.
 */
export async function accessToken(creds: IgdbCredentials, now: number): Promise<Token> {
  const url = new URL(TOKEN_URL);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("client_secret", creds.clientSecret);
  url.searchParams.set("grant_type", "client_credentials");

  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    // Deliberately not echoing the body: the request carried the secret in its
    // query string, and Twitch is known to quote the request back on error.
    throw new Error(`Twitch returned ${response.status} for the IGDB token`);
  }

  const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  const value = typeof body.access_token === "string" ? body.access_token : "";
  const lifetime = positive(body.expires_in);
  if (!value || lifetime === null) throw new Error("Twitch returned no usable IGDB token");

  return {
    value,
    expiresAt: now + Math.max(0, lifetime - EXPIRY_MARGIN_SECONDS) * 1000,
  };
}

/** Whether a cached token is still worth sending. */
export function usable(token: Token, now: number): boolean {
  return token.value.length > 0 && token.expiresAt > now;
}

/** A finite number above zero, or null. IGDB uses both 0 and absence for "no". */
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * An identifier, or null. Zero is a value here.
 *
 * `positive` is right for a time or a hype count, where IGDB uses zero and
 * absence interchangeably for "none". It is wrong for an id: reference tables
 * can number from zero, and rejecting that made the whole upcoming-releases
 * list return empty for ever, in silence.
 */
function identifier(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
