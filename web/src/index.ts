/**
 * HowToAchieve's Worker: routes every document and API request.
 *
 * It exists because Steam sends no CORS headers and its Web API key must never
 * reach the browser. Stylesheets, scripts and images are served by the asset
 * runtime without invoking it.
 *
 * Exports the default handler and nothing else: the runtime reads every named
 * export of the entry module as a handler, so helpers live in sibling modules.
 */

import { VERSION, json, known, problem, logFailure } from "./http.ts";
import { SteamError, steamClient, unknownGame } from "./steam.ts";
import { languageFor } from "./language.ts";
import { DEFAULT_LANGUAGE, DICTIONARY } from "../public/i18n.js";
import { parseProfile, resolveSteamId } from "./profile.ts";
import { IgdbClient, announceUnconfigured, cachedToken, credentials } from "./igdb.ts";
import { secured } from "./headers.ts";
import { cached, key } from "./edge-cache.ts";
import { withinRate } from "./rate-limit.ts";
import { gamePage, translated } from "./pages.ts";
import { explain } from "./explain.ts";

/** Release cards on the home page: one desktop row, keeping the search box on top. */
const UPCOMING_COUNT = 6;

const COMPLETION_TIME_ROUTE = /^\/api\/time\/(\d{1,10})$/;
const GAME_ROUTE = /^\/api\/game\/(\d{1,10})$/;
const GAME_PAGE_ROUTE = /^\/game\/(\d{1,10})$/;
// Achievement keys are developer-chosen, so the class is broad - but bounded, and
// never interpolated into an upstream URL without encoding.
const HOWTO_ROUTE = /^\/api\/howto\/(\d{1,10})\/([\w.%-]{1,120})$/;

/** Longest search accepted; an unbounded query is free amplification against Steam's quota. */
const MAX_QUERY_LENGTH = 100;

/** Bumped when retrieval or prompting changes, since answers are cached for a week. */
const HOWTO_LOGIC_VERSION = 4;

/** The address before the rename, still routed here so old links can be redirected. */
const FORMER_HOST = "cazalogros.cloudils.com";
const CANONICAL_HOST = "howtoachieve.cloudils.com";

/** GET and HEAD route alike. A HEAD that once fell through to the assets described another page. */
const READS = new Set(["GET", "HEAD"]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // One funnel, so every response carries the site's policy and every throw is
    // logged, rather than left to the runtime as an unlogged 1101.
    let response: Response;
    try {
      response = await answer(request, url, env, ctx);
    } catch (error) {
      logFailure("unhandled failure", error);
      response = known(500, "error.500");
    }

    // Dropped here rather than by the runtime: Cloudflare strips a HEAD body and
    // the test pool does not. Measuring the body can fail, so it is guarded.
    if (request.method === "HEAD") {
      try {
        response = await headed(response);
      } catch (error) {
        logFailure("could not measure the body of a HEAD", error);
        response = new Response(null, response);
      }
    }

    return secured(response, env, url.origin);
  },
} satisfies ExportedHandler<Env>;

/** The response without its body, still reporting the size a GET would send. */
async function headed(response: Response): Promise<Response> {
  // A 204, 205 or 304 has no body, and a length of 0 would misdescribe it.
  if (!response.body) return new Response(null, response);

  const body = await response.arrayBuffer();
  const out = new Response(null, response);
  out.headers.set("Content-Length", String(body.byteLength));
  return out;
}

async function answer(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Before route matching, so an old link lands on the page it meant. Permanent,
  // so the old address drops out of search indexes.
  if (url.hostname === FORMER_HOST) {
    url.hostname = CANONICAL_HOST;
    return Response.redirect(url.toString(), 301);
  }

  // Above every route: the asset request below is rebuilt as a GET, which would
  // otherwise turn `POST /privacy` into a 200.
  if (!READS.has(request.method)) {
    return known(405, "error.405");
  }

  const page = GAME_PAGE_ROUTE.exec(url.pathname);
  if (page) {
    return gamePage(Number(page[1]), url, env, languageFor(request), ctx);
  }

  if (!url.pathname.startsWith("/api/")) {
    // A static file, or the SPA fallback. Rebuilt as a GET because the asset
    // runtime answers a HEAD with no body to translate or measure, and with
    // `redirect: "manual"` because following its 307s to canonical paths would
    // serve one page under three URLs.
    const asset = await env.ASSETS.fetch(
      new Request(request.url, { headers: request.headers, method: "GET", redirect: "manual" }),
    );
    return translated(asset, languageFor(request));
  }

  try {
    return await route(request, url, env, ctx);
  } catch (error) {
    if (error instanceof SteamError) {
      return error.reason ? known(error.status, error.reason) : problem(error.status, error.message);
    }
    // Never echoed: an upstream error can quote a URL carrying the API key.
    logFailure("unhandled failure", error);
    return known(500, "error.500");
  }
}

async function route(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (url.pathname === "/api/health") {
    // Tells an operator why the IGDB sections are missing: two booleans named for
    // what a reader would miss, and nothing about the credentials themselves.
    const igdb = credentials(env) !== null;
    return json({ ok: true, version: VERSION, features: { completionTime: igdb, upcoming: igdb } });
  }

  if (url.pathname === "/api/steamid") {
    const parsed = parseProfile(url.searchParams.get("q") ?? "");
    if (parsed.kind === "invalid") {
      const reason = `profile.${parsed.reason}`;
      return known(400, reason in DICTIONARY[DEFAULT_LANGUAGE] ? reason : "profile.default");
    }

    // Spends the Steam key, and an unknown name cannot be answered from cache the
    // first time, so walking names is limited. A profile is set up once.
    if (!(await withinRate(request, env, "PROFILE"))) {
      return known(429, "profile.tooMany");
    }

    // Keyed on what was parsed, so one profile pasted five ways is one entry.
    return cached(key(url, `/api/steamid/${parsed.kind}/${parsed.value}`, env), false, env, ctx, async () => {
      try {
        if (parsed.kind === "id") {
          return json({ steamId: parsed.value, profileName: await steamClient(env).profileName(parsed.value) });
        }
        return json(await steamClient(env).resolveVanity(parsed.value));
      } catch (error) {
        // A name Steam does not know is a stable answer, so it is cached too.
        if (error instanceof SteamError && error.reason === "profile.unknown") {
          return known(404, error.reason, { "Cache-Control": "public, max-age=3600" });
        }
        throw error;
      }
    });
  }

  if (url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length < 2) {
      return problem(400, "Search for at least two characters.");
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return problem(400, `Search for at most ${MAX_QUERY_LENGTH} characters.`);
    }
    return cached(key(url, `/api/search?q=${encodeURIComponent(query.toLowerCase())}`, env), false, env, ctx, async () => {
      const results = await steamClient(env).search(query);
      return json({ results });
    });
  }

  if (url.pathname === "/api/upcoming") {
    // One list for everybody, so the cache alone protects it.
    return cached(key(url, "/api/upcoming", env), false, env, ctx, async () => {
      const creds = credentials(env);
      if (!creds) {
        announceUnconfigured();
        return json({ releases: [] });
      }

      try {
        const token = await cachedToken(creds, ctx);
        const lookup = await new IgdbClient(creds.clientId, token).upcoming(UPCOMING_COUNT, Date.now());
        // Which stage came up empty: the difference between a diagnosis and an afternoon.
        if (lookup.stoppedAt) console.log("igdb upcoming", lookup.stoppedAt);
        return json({ releases: lookup.releases }, { headers: { "Cache-Control": "public, max-age=21600" } });
      } catch (error) {
        // An outage must not be cached as though IGDB had answered.
        logFailure("igdb upcoming failed", error);
        return json({ releases: [] }, { headers: { "Cache-Control": "no-store" } });
      }
    });
  }

  const time = COMPLETION_TIME_ROUTE.exec(url.pathname);
  if (time) {
    // Enumerable, and every unseen id spends the IGDB credential.
    if (!(await withinRate(request, env, "PROFILE"))) {
      return known(429, "time.tooMany");
    }

    return cached(key(url, `/api/time/${time[1]}`, env), false, env, ctx, async () => {
      const creds = credentials(env);
      // Inside the producer, so a cache hit skips it. Keys are scoped to the
      // deployment, so each deploy starts cold and the line is written again.
      if (!creds) {
        announceUnconfigured();
        return json({ completionTime: null });
      }

      try {
        const token = await cachedToken(creds, ctx);
        const lookup = await new IgdbClient(creds.clientId, token).completionTime(Number(time[1]));
        // Three different things produce no time; the stage says which.
        if (lookup.stoppedAt) console.log("igdb completion time", time[1], lookup.stoppedAt);
        return json({ completionTime: lookup.time });
      } catch (error) {
        // Not cached, or one failure would hide the game's time for a day.
        logFailure("igdb completion time failed", error);
        return json({ completionTime: null }, { headers: { "Cache-Control": "no-store" } });
      }
    });
  }

  const game = GAME_ROUTE.exec(url.pathname);
  if (game) {
    const appId = Number(game[1]);
    const steamId = resolveSteamId(url.searchParams.get("steamid"), env.DEFAULT_STEAM_ID);

    // A personal answer bypasses the cache, so `?steamid=` would otherwise turn
    // the cache off for four Steam calls a time. Limited on that path only, and
    // before Steam is reached. A throttle is about the caller, so it is never cached.
    if (steamId !== null && !(await withinRate(request, env, "PROFILE"))) {
      return known(429, "profile.tooMany", {
        "Retry-After": "60",
        "Cache-Control": "no-store",
      });
    }

    return cached(key(url, `/api/game/${appId}`, env), steamId !== null, env, ctx, async () => {
      try {
        return json(await steamClient(env).gameAchievements(appId, steamId));
      } catch (error) {
        // "Nothing under that id" is stable, so it is cached like an answer.
        if (unknownGame(error)) {
          return problem(404, error.message, {
            "Cache-Control": `public, max-age=${env.CACHE_SECONDS}`,
          });
        }
        throw error;
      }
    });
  }

  const howto = HOWTO_ROUTE.exec(url.pathname);
  if (howto) {
    // Before validation, so a flooder costs as little as possible.
    if (!(await withinRate(request, env))) {
      return known(429, "howto.tooMany", {
        "Retry-After": "60",
        "Cache-Control": "no-store",
      });
    }

    const appId = Number(howto[1]);
    // The pattern admits `%`, so the key can hold an escape that is not valid UTF-8.
    let achievementKey: string;
    try {
      achievementKey = decodeURIComponent(howto[2] ?? "");
    } catch {
      return problem(400, "That achievement identifier is not valid.");
    }
    return cached(
      key(url, `/api/howto/v${HOWTO_LOGIC_VERSION}/${appId}/${encodeURIComponent(achievementKey)}`, env),
      false,
      env,
      ctx,
      () => explain(appId, achievementKey, env, ctx),
    );
  }

  // Not `error.404`, which tells the reader their game has no achievements.
  return known(404, "error.noRoute");
}
