/**
 * Steam client.
 *
 * Four endpoints, deliberately mixed, because no single one answers the
 * question "what do I still need for 100%?":
 *
 * | Endpoint                             | Key | Gives                       |
 * |--------------------------------------|-----|-----------------------------|
 * | SearchApps                           | no  | game search                 |
 * | appdetails                           | no  | title, header image         |
 * | GetSchemaForGame                     | yes | names, descriptions, icons  |
 * | GetGlobalAchievementPercentagesForApp| no  | how rare each one is        |
 * | GetPlayerAchievements                | yes | which ones you already have |
 *
 * The rarity figure is the point of the whole page. Steam shows achievements
 * in the developer's arbitrary order; sorted by global unlock percentage they
 * become a difficulty ranking, which is what a completionist actually plans
 * against.
 */

export interface SearchResult {
  appId: number;
  name: string;
  icon: string | null;
}

export interface Achievement {
  key: string;
  name: string;
  description: string;
  icon: string;
  iconLocked: string;
  /** Share of owners who have it, 0-100. Null when Steam publishes no figure. */
  globalPercent: number | null;
  /** Null when no player was requested, otherwise whether they have it. */
  unlocked: boolean | null;
  unlockedAt: string | null;
}

export interface GameAchievements {
  appId: number;
  name: string;
  headerImage: string | null;
  achievements: Achievement[];
  total: number;
  unlockedCount: number | null;
}

export class SteamError extends Error {
  constructor(
    message: string,
    /** Status this API should answer with. */
    readonly status: number,
    /** Status Steam gave us, kept so callers can tell a bad request from an outage. */
    readonly upstreamStatus: number = 0,
    /**
     * A code for the client, where the status alone is ambiguous.
     *
     * A 404 from the game route means "no achievements"; a 404 from the profile
     * route means "no such profile". The client shows these in two languages
     * and so cannot use the prose.
     */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "SteamError";
  }
}

const SEARCH_URL = "https://steamcommunity.com/actions/SearchApps/";
const STORE_URL = "https://store.steampowered.com/api/appdetails";
const API_BASE = "https://api.steampowered.com/ISteamUserStats";

/** Resolving a custom URL and reading a profile name live under a different service. */
const USER_API_BASE = "https://api.steampowered.com/ISteamUser";

/** Steam is slow often enough that an unbounded wait would burn the request. */
const TIMEOUT_MS = 8000;

export class SteamClient {
  constructor(private readonly apiKey: string) {}

  async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const body = await this.getJson<unknown>(
      `${SEARCH_URL}${encodeURIComponent(trimmed)}`,
      "game search",
    );
    if (!Array.isArray(body)) return [];

    return body.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record) return [];
      const appId = Number(record["appid"]);
      const name = record["name"];
      if (!Number.isInteger(appId) || typeof name !== "string") return [];
      const icon = record["icon"];
      return [{ appId, name, icon: typeof icon === "string" ? icon : null }];
    });
  }

  /**
   * Everything the page needs for one game, in a single response.
   *
   * The three upstream calls are issued together rather than in sequence: they
   * do not depend on each other, and Steam's latency dominates the request.
   */
  async gameAchievements(appId: number, steamId: string | null): Promise<GameAchievements> {
    const [schema, globals, store, player] = await Promise.all([
      this.schema(appId),
      this.globalPercentages(appId),
      this.storeDetails(appId),
      steamId ? this.playerAchievements(appId, steamId) : Promise.resolve(null),
    ]);

    if (schema.length === 0) {
      throw new SteamError(
        "No achievements found for this game. It may not exist, or it simply has none.",
        404,
      );
    }

    const achievements = schema
      .map((entry) => ({
        ...entry,
        globalPercent: globals.get(entry.key) ?? null,
        unlocked: player ? (player.get(entry.key)?.unlocked ?? false) : null,
        unlockedAt: player ? (player.get(entry.key)?.at ?? null) : null,
      }))
      // Rarest first. Anything Steam has no figure for sorts last rather than
      // being treated as 0%, which would fake it to the top of the list.
      .sort((a, b) => (a.globalPercent ?? 101) - (b.globalPercent ?? 101));

    return {
      appId,
      name: store.name ?? `App ${appId}`,
      headerImage: store.headerImage,
      achievements,
      total: achievements.length,
      unlockedCount: player ? achievements.filter((a) => a.unlocked).length : null,
    };
  }

  /**
   * The SteamID64 behind a custom profile name, and who it belongs to.
   *
   * The name is fetched alongside deliberately. Handing someone back a
   * seventeen-digit number tells them nothing they can check; handing back
   * "that is Some Player" lets them see at a glance whether it found the right
   * person, which is the whole reason this exists.
   *
   * Uses the same Steam key the rest of the client holds - no new credential.
   */
  async resolveVanity(name: string): Promise<{ steamId: string; profileName: string | null }> {
    const url = new URL(`${USER_API_BASE}/ResolveVanityURL/v1/`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("vanityurl", name);

    const body = await this.getJson<unknown>(url, "the profile name");
    const response = asRecord(asRecord(body)?.["response"]);

    // Steam answers 200 with `success: 42` for a name it does not know, so the
    // status alone says nothing.
    if (response?.["success"] !== 1 || typeof response["steamid"] !== "string") {
      throw new SteamError("Steam does not know that profile name.", 404, 0, "profile.unknown");
    }

    return { steamId: response["steamid"], profileName: await this.profileName(response["steamid"]) };
  }

  /**
   * The display name on a profile, or null.
   *
   * Best-effort: a private profile withholds it, and that is not a reason to
   * refuse an id Steam has already confirmed.
   */
  async profileName(steamId: string): Promise<string | null> {
    const url = new URL(`${USER_API_BASE}/GetPlayerSummaries/v2/`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("steamids", steamId);

    try {
      const body = await this.getJson<unknown>(url, "the profile name");
      const players = asRecord(asRecord(body)?.["response"])?.["players"];
      const first = Array.isArray(players) ? asRecord(players[0]) : null;
      return typeof first?.["personaname"] === "string" ? first["personaname"] : null;
    } catch {
      return null;
    }
  }

  /**
   * One achievement's official name and description.
   *
   * Resolved from Steam rather than accepted from the caller: the name is what
   * the guide corpus is searched for and what reaches the model's prompt, so it
   * has to come from an authoritative source, not from a query parameter.
   */
  async achievementByKey(
    appId: number,
    key: string,
  ): Promise<{ name: string; description: string } | null> {
    const entry = (await this.schema(appId)).find((item) => item.key === key);
    return entry ? { name: entry.name, description: entry.description } : null;
  }

  // -- individual sources -------------------------------------------------

  private async schema(appId: number): Promise<Omit<Achievement, "globalPercent" | "unlocked" | "unlockedAt">[]> {
    const url = new URL(`${API_BASE}/GetSchemaForGame/v2/`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("appid", String(appId));

    let body: unknown;
    try {
      body = await this.getJson<unknown>(url, "achievement list");
    } catch (error) {
      // Steam answers an unknown app id with a 4xx rather than an empty
      // schema. Treating that as "no achievements" lets the caller report a
      // missing game instead of an upstream outage, which is what it is.
      if (error instanceof SteamError && error.upstreamStatus < 500) return [];
      throw error;
    }

    const list = asRecord(asRecord(asRecord(body)?.["game"])?.["availableGameStats"])?.["achievements"];
    if (!Array.isArray(list)) return [];

    return list.flatMap((entry) => {
      const record = asRecord(entry);
      const key = record?.["name"];
      if (!record || typeof key !== "string") return [];
      return [
        {
          key,
          // `displayName` is the human title; `name` is the internal id.
          name: str(record["displayName"]) || key,
          description: str(record["description"]),
          icon: str(record["icon"]),
          iconLocked: str(record["icongray"]),
        },
      ];
    });
  }

  private async globalPercentages(appId: number): Promise<Map<string, number>> {
    const url = new URL(`${API_BASE}/GetGlobalAchievementPercentagesForApp/v2/`);
    url.searchParams.set("gameid", String(appId));

    const percentages = new Map<string, number>();
    try {
      const body = await this.getJson<unknown>(url, "global rarity");
      const list = asRecord(asRecord(body)?.["achievementpercentages"])?.["achievements"];
      if (!Array.isArray(list)) return percentages;

      for (const entry of list) {
        const record = asRecord(entry);
        if (!record) continue;
        const key = record["name"];
        const percent = Number(record["percent"]);
        if (typeof key === "string" && Number.isFinite(percent)) {
          percentages.set(key, percent);
        }
      }
    } catch {
      // Rarity is the most valuable column but not a reason to fail the page:
      // without it the list still renders, just unsorted by difficulty.
    }
    return percentages;
  }

  private async playerAchievements(
    appId: number,
    steamId: string,
  ): Promise<Map<string, { unlocked: boolean; at: string | null }> | null> {
    const url = new URL(`${API_BASE}/GetPlayerAchievements/v1/`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("appid", String(appId));
    url.searchParams.set("steamid", steamId);

    try {
      const body = await this.getJson<unknown>(url, "your progress");
      const list = asRecord(asRecord(body)?.["playerstats"])?.["achievements"];
      if (!Array.isArray(list)) return null;

      const progress = new Map<string, { unlocked: boolean; at: string | null }>();
      for (const entry of list) {
        const record = asRecord(entry);
        const key = record?.["apiname"];
        if (!record || typeof key !== "string") continue;
        const unlockTime = Number(record["unlocktime"]);
        progress.set(key, {
          unlocked: Number(record["achieved"]) === 1,
          at: unlockTime > 0 ? new Date(unlockTime * 1000).toISOString() : null,
        });
      }
      return progress;
    } catch {
      // A private profile, or a game the player does not own. Both are normal;
      // the page simply shows no personal progress.
      return null;
    }
  }

  private async storeDetails(appId: number): Promise<{ name: string | null; headerImage: string | null }> {
    const url = new URL(STORE_URL);
    url.searchParams.set("appids", String(appId));
    url.searchParams.set("filters", "basic");

    try {
      const body = await this.getJson<unknown>(url, "game details");
      const data = asRecord(asRecord(asRecord(body)?.[String(appId)])?.["data"]);
      return {
        name: typeof data?.["name"] === "string" ? data["name"] : null,
        headerImage: typeof data?.["header_image"] === "string" ? data["header_image"] : null,
      };
    } catch {
      return { name: null, headerImage: null };
    }
  }

  // -- transport ----------------------------------------------------------

  private async getJson<T>(url: URL | string, what: string): Promise<T> {
    const response = await fetch(url, {
      headers: { "User-Agent": "histlow-achievements/0.1", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // The URL is withheld deliberately: GetSchemaForGame carries the API key
      // as a query parameter, and this message reaches the browser.
      throw new SteamError(
        response.status === 403
          ? `Steam rejected the request for ${what}. The configured API key may be invalid.`
          : `Steam returned ${response.status} for ${what}.`,
        502,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new SteamError(`Steam returned an unreadable response for ${what}.`, 502);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
