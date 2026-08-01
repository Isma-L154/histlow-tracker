/**
 * Steam achievement browser.
 *
 * One Worker serves both halves of the site. Requests under `/api/` run this
 * code; everything else is served directly from `public/` by the assets
 * runtime without invoking the Worker at all.
 *
 * The Worker exists for two reasons the browser cannot solve on its own:
 * none of Steam's endpoints send CORS headers, so a page cannot call them
 * directly, and the Steam Web API key must never reach the client.
 *
 * This module exports the default handler and nothing else. The runtime reads
 * every named export here as a handler or binding, so helpers live in
 * sibling modules.
 */

import { VERSION, json, problem } from "./http.ts";
import { SteamError, SteamClient } from "./steam.ts";

const GAME_ROUTE = /^\/api\/game\/(\d{1,10})$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      // Unreachable in production: `run_worker_first` limits Worker execution
      // to /api/*. Kept so `wrangler dev` and tests behave the same way.
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET") {
      return problem(405, "Only GET is supported.");
    }

    try {
      return await route(url, env, ctx);
    } catch (error) {
      if (error instanceof SteamError) {
        return problem(error.status, error.message);
      }
      // Nothing from an unexpected failure is echoed: it could quote a URL,
      // and one of those carries the API key.
      console.error("unhandled failure", error);
      return problem(500, "Something went wrong handling that request.");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (url.pathname === "/api/health") {
    return json({ ok: true, version: VERSION });
  }

  if (url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length < 2) {
      return problem(400, "Search for at least two characters.");
    }
    return cached(key(url, `/api/search?q=${encodeURIComponent(query.toLowerCase())}`), false, env, ctx, async () => {
      const results = await client(env).search(query);
      return json({ results });
    });
  }

  const game = GAME_ROUTE.exec(url.pathname);
  if (game) {
    const appId = Number(game[1]);
    const steamId = resolveSteamId(url, env);
    return cached(key(url, `/api/game/${appId}`), steamId !== null, env, ctx, async () => {
      const payload = await client(env).gameAchievements(appId, steamId);
      return json(payload);
    });
  }

  return problem(404, `No API route matches ${url.pathname}.`);
}

function client(env: Env): SteamClient {
  const key = env.STEAM_WEB_API_KEY;
  if (!key) {
    throw new SteamError(
      "The Steam API key is not configured on this deployment.",
      503,
    );
  }
  return new SteamClient(key);
}

/**
 * A 17-digit id, or nothing.
 *
 * The caller may supply one; otherwise the deployment's own is used if it has
 * been configured. Validating the shape here keeps an arbitrary string from
 * being forwarded into an upstream query.
 */
function resolveSteamId(url: URL, env: Env): string | null {
  const requested = url.searchParams.get("steamid");
  const candidate = requested ?? env.DEFAULT_STEAM_ID ?? "";
  return /^\d{17}$/.test(candidate) ? candidate : null;
}

/**
 * The cache key for a request, built from scratch rather than from its URL.
 *
 * Only the parameters that change the answer belong in the key. Deriving it
 * from the incoming URL instead would let anyone append a junk parameter and
 * miss the cache on every request, which is exactly the traffic the cache is
 * there to keep away from the Steam key's quota.
 */
function key(url: URL, canonical: string): string {
  return new URL(canonical, url.origin).toString();
}

/**
 * Serves from the edge cache when possible, populating it otherwise.
 *
 * Achievement text never changes and unlock percentages move slowly, so a day
 * of caching keeps the page instant and keeps both the Worker's request budget
 * and the Steam key's quota far from their limits. It is also the only thing
 * standing between a public URL and someone burning that quota.
 *
 * Responses carrying personal progress are deliberately not cached: they
 * differ per player and are nobody else's business. `personal` is decided by
 * whether a player was actually resolved, not by whether one was asked for, so
 * an unusable `?steamid=` value still gets a shared, cacheable answer.
 */
async function cached(
  cacheKey: string,
  personal: boolean,
  env: Env,
  ctx: ExecutionContext,
  produce: () => Promise<Response>,
): Promise<Response> {
  if (personal) {
    const fresh = await produce();
    fresh.headers.set("Cache-Control", "private, no-store");
    return fresh;
  }

  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await produce();
  if (response.ok) {
    response.headers.set("Cache-Control", `public, max-age=${env.CACHE_SECONDS}`);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
