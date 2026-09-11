/**
 * Steam client. No single endpoint answers "what do I still need for 100%?",
 * so several are combined:
 *
 * | Endpoint                              | Key | Gives                       |
 * |---------------------------------------|-----|-----------------------------|
 * | SearchApps                            | no  | game search                 |
 * | appdetails                            | no  | title, header image         |
 * | GetSchemaForGame                      | yes | names, descriptions, icons  |
 * | GetGlobalAchievementPercentagesForApp | no  | how rare each one is        |
 * | GetPlayerAchievements                 | yes | which ones you already have |
 * | ResolveVanityURL, GetPlayerSummaries  | yes | a profile's id and name     |
 */

interface SearchResult {
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
    /** Status Steam gave us, so callers can tell a bad request from an outage. */
    readonly upstreamStatus: number = 0,
    /** A dictionary key for the client, where the status alone is ambiguous. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "SteamError";
  }
}

/**
 * Whether an error means Steam has nothing under that app id - a stable answer
 * worth caching - rather than an outage, which must not be cached.
 * `upstreamStatus` is what separates them.
 */
export function unknownGame(error: unknown): error is SteamError {
  return error instanceof SteamError && error.status === 404 && error.upstreamStatus < 500;
}

/** A client for this deployment's key, or a 503 when none is configured. */
export function steamClient(env: Env): SteamClient {
  if (!env.STEAM_WEB_API_KEY) {
    throw new SteamError("The Steam API key is not configured on this deployment.", 503);
  }
  return new SteamClient(env.STEAM_WEB_API_KEY);
}

const SEARCH_URL = "https://steamcommunity.com/actions/SearchApps/";
const STORE_URL = "https://store.steampowered.com/api/appdetails";
const API_BASE = "https://api.steampowered.com/ISteamUserStats";
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

  /** Everything the page needs for one game; the upstream calls are independent, so they go out together. */
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
      // Rarest first. No figure sorts last, rather than faking its way to the top as 0%.
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
   * The SteamID64 behind a custom profile name, with the profile's display name,
   * so the reader can see at a glance whether the right person was found.
   */
  async resolveVanity(name: string): Promise<{ steamId: string; profileName: string | null }> {
    const url = new URL(`${USER_API_BASE}/ResolveVanityURL/v1/`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("vanityurl", name);

    const body = await this.getJson<unknown>(url, "the profile name");
    const response = asRecord(asRecord(body)?.["response"]);

    // Steam answers an unknown name with 200 and `success: 42`.
    if (response?.["success"] !== 1 || typeof response["steamid"] !== "string") {
      throw new SteamError("Steam does not know that profile name.", 404, 0, "profile.unknown");
    }

    return { steamId: response["steamid"], profileName: await this.profileName(response["steamid"]) };
  }

  /** A profile's display name, or null: a private profile withholds it. */
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
   * One achievement's official name and description, from Steam rather than the
   * caller: the name is searched for and reaches the model's prompt.
   */
  async achievementByKey(
    appId: number,
    key: string,
  ): Promise<{ name: string; description: string } | null> {
    const entry = (await this.schema(appId)).find((item) => item.key === key);
    return entry ? { name: entry.name, description: entry.description } : null;
  }

  private async schema(appId: number): Promise<Omit<Achievement, "globalPercent" | "unlocked" | "unlockedAt">[]> {
    const url = new URL(`${API_BASE}/GetSchemaForGame/v2/`);
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("appid", String(appId));

    let body: unknown;
    try {
      body = await this.getJson<unknown>(url, "achievement list");
    } catch (error) {
      // Steam answers an unknown app id with a 4xx rather than an empty schema;
      // reading that as "no achievements" reports a missing game, not an outage.
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
      // Without rarity the list still renders, just not ordered by difficulty.
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
      // A private profile, or a game the player does not own: no progress shown.
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

  private async getJson<T>(url: URL | string, what: string): Promise<T> {
    const response = await fetch(url, {
      headers: { "User-Agent": "histlow-achievements/0.1", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // The URL is withheld: it can carry the API key, and this message reaches the browser.
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
