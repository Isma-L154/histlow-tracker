/**
 * IGDB, for what Steam does not publish: how long a game takes, and what is
 * coming out next.
 *
 * HowLongToBeat disallows automated retrieval; IGDB is official and free. It
 * authenticates through Twitch, and having no credentials is an ordinary state:
 * the caller gets nothing and the page renders without the section.
 */

const TIMEOUT_MS = 5000;

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.igdb.com/v4";

/** Stop trusting a token this early, so it never expires between our clock and theirs. */
const EXPIRY_MARGIN_SECONDS = 300;

/**
 * Steam in the deprecated `external_games.category`, used only when the
 * replacement source id cannot be looked up by name. A guessed id could
 * silently match another store, and a wrong completion time looks right.
 */
const EXTERNAL_CATEGORY_STEAM = 1;

/**
 * Platforms matched by name rather than by id, since an id that silently starts
 * meaning another platform is the failure this module avoids. Patterns, so a
 * console revision with a suffixed name still matches.
 */
const PLATFORM_IS_PC = /microsoft windows/i;
const PLATFORM_IS_CONSOLE = /^(playstation 5|xbox series)/i;

/** Where IGDB serves cover art. It also needs an entry in the page's CSP. */
const IMAGE_BASE = "https://images.igdb.com/igdb/image/upload";

/** A lookup's result, and where it stopped if it found nothing, so the logs can tell why. */
interface Lookup {
  time: CompletionTime | null;
  stoppedAt: string | null;
}

interface CompletionTime {
  /** Seconds to finish the story. */
  normally: number | null;
  /** Seconds to finish everything, which is what this site is about. */
  completely: number | null;
}

interface UpcomingLookup {
  releases: UpcomingRelease[];
  stoppedAt: string | null;
}

interface UpcomingRelease {
  name: string;
  /** Unix seconds. Only ever a date IGDB marked as exact. */
  releasedAt: number;
  coverUrl: string | null;
}

interface IgdbCredentials {
  clientId: string;
  clientSecret: string;
}

interface Token {
  value: string;
  expiresAt: number;
}

/** The credentials, or null when the feature is simply not configured. */
export function credentials(env: {
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
}): IgdbCredentials | null {
  const clientId = env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = env.TWITCH_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

let announced = false;

/**
 * Says once per isolate that there are no credentials. Once, or a deployment
 * without them would log for every visitor; at all, because it is the one
 * missing-data case that is somebody's to fix.
 */
export function announceUnconfigured(): void {
  if (announced) return;
  announced = true;
  console.log("igdb not configured: no Twitch credentials, so completion times and upcoming releases are absent");
}

/** A client for one request cycle. The token is handed in so the caller can cache it. */
export class IgdbClient {
  constructor(
    private readonly clientId: string,
    private readonly token: string,
  ) {}

  /**
   * How long a Steam game takes to finish. Matched by Steam app id rather than by
   * title, which produces confident wrong answers across remasters and demos.
   */
  async completionTime(steamAppId: number): Promise<Lookup> {
    const gameId = await this.gameIdForSteamApp(steamAppId);
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
   * The most anticipated games with an exact release date ahead.
   *
   * Ranked across all of IGDB first, by `hypes` on `games`, and dated only
   * afterwards: ranking the nearest release dates instead would let a wave of
   * small titles bury the one game everybody is waiting for. `first_release_date`
   * is set even for a placeholder quarter, so exact dates come from
   * `release_dates`. Candidates are over-fetched because many have no exact date
   * yet, and some turn out to reach only PC.
   */
  async upcoming(limit: number, now: number): Promise<UpcomingLookup> {
    const format = await this.exactDateFormat();
    const exact = format.id;
    // Nothing rather than a countdown to a guessed date. The formats offered
    // travel with the reason, so the next attempt reads rather than guesses.
    if (exact === null) {
      return {
        releases: [],
        stoppedAt: `no full-date format among [${format.saw.join(", ") || "nothing returned"}]`,
      };
    }

    const platforms = await this.majorPlatforms();
    // Without console ids a PC-only indie cannot be told from an anticipated game.
    if (platforms.consoles.length === 0) {
      return {
        releases: [],
        stoppedAt:
          `no console platform among ${platforms.total}` +
          ` (matched [${platforms.saw.join(", ") || "nothing"}])`,
      };
    }
    const wanted = platforms.all.join(",");

    const seconds = Math.floor(now / 1000);
    const candidates = await this.query<{
      id?: number;
      name?: string;
      cover?: { image_id?: string };
      platforms?: unknown;
    }>(
      "games",
      `fields id, name, cover.image_id, platforms;` +
        ` where first_release_date > ${seconds} & platforms = (${wanted}) & hypes != null;` +
        ` sort hypes desc; limit ${Math.min(500, Math.max(50, limit * 25))};`,
    );

    // By id rather than name: a demo and its game can share a title.
    const games = new Map<number, { name: string; coverUrl: string | null }>();
    const consoles = new Set(platforms.consoles);
    for (const row of candidates) {
      if (row === null || typeof row !== "object") continue;
      const id = identifier(row.id);
      if (id === null || !row.name) continue;
      // Here rather than in the query: Apicalypse cannot ask whether a game
      // touches a console while PC stays in the set its release is dated by.
      if (!reachesConsole(row.platforms, consoles)) continue;
      const imageId = row.cover?.image_id;
      games.set(id, {
        name: row.name,
        coverUrl: imageId ? `${IMAGE_BASE}/t_cover_big/${imageId}.jpg` : null,
      });
    }
    if (games.size === 0) {
      return { releases: [], stoppedAt: `no candidate games (${candidates.length} rows from games)` };
    }

    const dates = await this.query<{ game?: number; date?: number; date_format?: number }>(
      "release_dates",
      `fields game, date, date_format;` +
        ` where game = (${[...games.keys()].join(",")}) & platform = (${wanted})` +
        ` & date > ${seconds} & date_format = ${exact};` +
        ` sort date asc; limit 200;`,
    );

    // Dates arrive earliest first, so the first one seen per game is the one kept.
    const earliest = new Map<number, number>();
    for (const row of dates) {
      if (row === null || typeof row !== "object") continue;
      const game = identifier(row.game);
      const date = positive(row.date);
      if (game === null || date === null || earliest.has(game)) continue;
      earliest.set(game, date);
    }

    // `games` kept the ranked order of `candidates`.
    const releases: UpcomingRelease[] = [];
    for (const [id, game] of games) {
      const releasedAt = earliest.get(id);
      if (releasedAt === undefined) continue;
      releases.push({ ...game, releasedAt });
      if (releases.length === limit) break;
    }

    return {
      releases,
      stoppedAt:
        releases.length > 0
          ? null
          : `${games.size} candidates, ${dates.length} date rows, none exact and ahead`,
    };
  }

  /**
   * The platform ids behind the names. The whole table is read and matched in
   * memory, because a string filter in the query has already been wrong here once.
   */
  private async majorPlatforms(): Promise<{
    all: number[];
    consoles: number[];
    saw: string[];
    total: number;
  }> {
    try {
      const rows = await this.query<{ id?: number; name?: string }>(
        "platforms",
        `fields id, name; limit 500;`,
      );

      const saw: string[] = [];
      const consoles: number[] = [];
      let pc: number | null = null;
      for (const row of rows) {
        if (row === null || typeof row !== "object" || typeof row.name !== "string") continue;
        const id = identifier(row.id);
        if (id === null) continue;
        const name = row.name.trim();
        if (pc === null && PLATFORM_IS_PC.test(name)) {
          pc = id;
          saw.push(name);
        } else if (PLATFORM_IS_CONSOLE.test(name)) {
          consoles.push(id);
          saw.push(name);
        }
      }

      // PC stays in the queries, so a multiplatform game is found and dated there
      // too; only `consoles` decides whether a game qualifies.
      return {
        all: pc === null ? consoles : [pc, ...consoles],
        consoles,
        saw,
        total: rows.length,
      };
    } catch {
      return { all: [], consoles: [], saw: [], total: 0 };
    }
  }

  /**
   * The `date_formats` row for a full day-month-year date: the one whose format
   * ends in a day. Filtering on the string in the query returned nothing in
   * production, and the table has about seven rows.
   */
  private async exactDateFormat(): Promise<{ id: number | null; saw: string[] }> {
    try {
      const rows = await this.query<{ id?: number; format?: string }>(
        "date_formats",
        `fields id, format; limit 50;`,
      );

      const saw: string[] = [];
      let id: number | null = null;
      for (const row of rows) {
        if (row === null || typeof row !== "object" || typeof row.format !== "string") continue;
        saw.push(row.format);
        if (id === null && /dd$/i.test(row.format.replace(/[^A-Za-z]/g, ""))) {
          id = identifier(row.id);
        }
      }
      return { id, saw };
    } catch {
      return { id: null, saw: [] };
    }
  }

  /**
   * IGDB's id for a game, through its Steam listing: `external_game_source`
   * resolved by name, with the deprecated `category` as the fallback.
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
      // The endpoint is newer than the field it replaces.
      return null;
    }
  }

  /**
   * One query. Throws on anything unexpected, so a caller can tell IGDB having
   * nothing from IGDB being unreachable; every caller hides its section either way.
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
      // The token travels in a header, so the status is all worth reporting.
      throw new Error(`IGDB returned ${response.status} for ${endpoint}`);
    }

    const parsed = await response.json();
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
}

/** Exchanges the credentials for an access token. */
export async function accessToken(creds: IgdbCredentials, now: number): Promise<Token> {
  const url = new URL(TOKEN_URL);
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("client_secret", creds.clientSecret);
  url.searchParams.set("grant_type", "client_credentials");

  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    // The body is not echoed: the secret was in the query string, and Twitch quotes requests back.
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

/**
 * An access token, kept in the edge cache for less than its own lifetime.
 *
 * Tokens last about sixty days, so fetching one per request would add a round
 * trip to every page. `private` is only a signal: what keeps the entry out of
 * reach is that `token.invalid` is not a routable path. Revisit if this zone
 * ever gains a second Worker, which would share `caches.default`.
 */
export async function cachedToken(creds: IgdbCredentials, ctx: ExecutionContext): Promise<string> {
  const cache = caches.default;
  const cacheKey = "https://token.invalid/igdb/v1";

  const hit = await cache.match(cacheKey);
  if (hit) {
    const stored = (await hit.json()) as Token;
    if (usable(stored, Date.now())) return stored.value;
  }

  const token = await accessToken(creds, Date.now());
  const lifetime = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000));
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(token), {
        headers: { "Content-Type": "application/json", "Cache-Control": `private, max-age=${lifetime}` },
      }),
    ),
  );
  return token.value;
}

/**
 * Whether a platform list reaches a console. A console, not two platforms: a
 * first-party exclusive ships on one and is as anticipated as anything. IGDB
 * expands `platforms` to ids or to objects depending on the query, so both are read.
 */
function reachesConsole(platforms: unknown, consoles: Set<number>): boolean {
  if (!Array.isArray(platforms)) return false;
  return platforms.some((entry) => {
    const raw = entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : entry;
    const id = identifier(raw);
    return id !== null && consoles.has(id);
  });
}

/** A finite number above zero, or null. IGDB uses both 0 and absence for "none". */
function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * An identifier, or null. Zero is valid here: reference tables can number from
 * it, and rejecting it once emptied the upcoming list silently.
 */
function identifier(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
