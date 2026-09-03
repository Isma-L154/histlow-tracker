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

export interface CompletionTime {
  /** Seconds to finish the story, as IGDB reports it. */
  normally: number | null;
  /** Seconds to finish everything, which is what this site is about. */
  completely: number | null;
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
  async completionTime(steamAppId: number): Promise<CompletionTime | null> {
    const gameId = await this.gameIdForSteamApp(steamAppId);
    if (gameId === null) return null;

    const rows = await this.query<{ normally?: number; completely?: number }>(
      "game_time_to_beats",
      `fields normally, completely; where game_id = ${gameId}; limit 1;`,
    );

    const row = rows[0];
    if (!row) return null;

    const time = {
      normally: positive(row.normally),
      completely: positive(row.completely),
    };
    // A row of nulls is the same as no row, and saying so here keeps the
    // caller from having to know that.
    return time.normally === null && time.completely === null ? null : time;
  }

  /** IGDB's own id for a game, found through its Steam listing. */
  private async gameIdForSteamApp(steamAppId: number): Promise<number | null> {
    const rows = await this.query<{ game?: number }>(
      "external_games",
      `fields game; where uid = "${steamAppId}" & category = ${EXTERNAL_CATEGORY_STEAM}; limit 1;`,
    );
    return positive(rows[0]?.game);
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
