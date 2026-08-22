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

import { VERSION, json, problem, logFailure } from "./http.ts";
import { SteamError, SteamClient } from "./steam.ts";
import { fetchGuideIds, fetchGuideIdsFor, fetchGuide, findPassages, type Guide } from "./guides.ts";
import { explainAchievement } from "./howto.ts";
import { describeGame } from "./preview.ts";

const GAME_ROUTE = /^\/api\/game\/(\d{1,10})$/;
// The page a person shares, as opposed to the endpoint behind it.
const GAME_PAGE_ROUTE = /^\/game\/(\d{1,10})$/;
// Achievement keys are developer-chosen identifiers, so the character class is
// deliberately broad - but bounded, and never interpolated into an upstream URL
// without encoding.
const HOWTO_ROUTE = /^\/api\/howto\/(\d{1,10})\/([\w.%-]{1,120})$/;

/**
 * Bumped whenever retrieval or prompting changes.
 *
 * Answers are cached for a week, so without this a deploy that improves how
 * passages are found would keep serving the answers the old logic produced -
 * and the improvement would be invisible exactly where it mattered.
 */
const HOWTO_LOGIC_VERSION = 3;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const page = GAME_PAGE_ROUTE.exec(url.pathname);
    if (page && request.method === "GET") {
      return gamePage(Number(page[1]), url, env);
    }

    if (!url.pathname.startsWith("/api/")) {
      // Everything else is a static file, or the SPA fallback for a path that
      // does not match one.
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
      logFailure("unhandled failure", error);
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

  const howto = HOWTO_ROUTE.exec(url.pathname);
  if (howto) {
    const appId = Number(howto[1]);
    // The route pattern admits `%`, so the path can still carry percent
    // encoding that does not decode - `%FF%FE` is not valid UTF-8. Left to
    // throw, that surfaced as a 500 and wrote a log line, which made bad input
    // indistinguishable from a broken deployment and let anyone fill the log.
    let achievementKey: string;
    try {
      achievementKey = decodeURIComponent(howto[2] ?? "");
    } catch {
      return problem(400, "That achievement identifier is not valid.");
    }
    return cached(
      key(url, `/api/howto/v${HOWTO_LOGIC_VERSION}/${appId}/${encodeURIComponent(achievementKey)}`),
      false,
      env,
      ctx,
      () => explain(appId, achievementKey, env, ctx),
    );
  }

  return problem(404, `No API route matches ${url.pathname}.`);
}

/**
 * The HTML for one game's page, described so a shared link previews properly.
 *
 * Preview bots do not run JavaScript, so the title and image a person sees in
 * a chat app have to be in the document as it leaves the Worker. Failing to
 * find the game is not an error here: the shell still renders, and the client
 * will report the problem in the reader's own language.
 */
async function gamePage(appId: number, url: URL, env: Env): Promise<Response> {
  const shell = await env.ASSETS.fetch(new URL("/index.html", url.origin));
  const html = await shell.text();

  let described = html;
  try {
    const game = await client(env).gameAchievements(appId, null);
    described = describeGame(html, game, url.origin);
  } catch (error) {
    // An unknown id, or Steam being down. The page still works; only the
    // preview card falls back to the site's generic one.
    if (!(error instanceof SteamError)) logFailure("game page render failed", error);
  }

  return new Response(described, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Same shape for every visitor, and the underlying data barely moves.
      "Cache-Control": `public, max-age=${env.CACHE_SECONDS}`,
    },
  });
}

/**
 * How one achievement is earned, according to the game's community guides.
 *
 * The passages travel back alongside the written steps rather than being
 * swallowed by them. They are the evidence: if the model is wrong, or the daily
 * allocation is spent and there are no steps at all, the reader still gets the
 * real text and the link to whoever wrote it.
 */
async function explain(
  appId: number,
  achievementKey: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const achievement = await client(env).achievementByKey(appId, achievementKey);
  if (!achievement) {
    return problem(404, "That achievement does not belong to this game.");
  }

  const guides = await corpus(appId, env, ctx);
  let passages = findPassages(guides, achievement.name, achievement.description, 3);
  let searched = guides.length;

  // The shared corpus is a game's best-rated achievement guides, which for many
  // games are route walkthroughs that never name a single achievement. Only
  // when it comes up empty is it worth paying for a search aimed at this one.
  if (passages.length === 0) {
    const targeted = await targetedGuides(appId, achievement.name);
    searched += targeted.length;
    passages = findPassages(targeted, achievement.name, achievement.description, 3, {
      guideTitleQualifies: true,
    });
  }

  const written = passages.length > 0
    ? await explainAchievement(env.AI, env.HOWTO_MODEL, achievement, passages)
    : null;

  const answered = written?.answered ?? false;
  return json(
    {
      appId,
      key: achievementKey,
      name: achievement.name,
      steps: written?.steps ?? null,
      answered,
      guidesSearched: searched,
      passages: passages.map(({ score: _score, ...passage }) => passage),
    },
    {
      // A found answer keeps for a week. A miss keeps for an hour, because a
      // miss is as likely to mean "nobody has written it yet" as "it cannot be
      // found", and the first of those fixes itself.
      headers: { "Cache-Control": `public, max-age=${answered ? 604800 : 3600}` },
    },
  );
}

/** The two best-rated guides Steam returns when searching for this achievement. */
async function targetedGuides(appId: number, name: string): Promise<Guide[]> {
  const ids = await fetchGuideIdsFor(appId, name, 2);
  const guides: Guide[] = [];
  for (const id of ids) {
    const guide = await fetchGuide(id);
    if (guide) guides.push(guide);
  }
  return guides;
}

/**
 * The game's guide corpus, downloaded once and reused.
 *
 * Reading six guides costs several seconds of wall time, so doing it per
 * achievement would make every row in a fifty-achievement game pay for it. The
 * parsed corpus is cached separately from the answers built out of it.
 */
async function corpus(appId: number, env: Env, ctx: ExecutionContext): Promise<Guide[]> {
  const cache = caches.default;
  const cacheKey = `https://corpus.invalid/guides/${appId}`;

  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()) as Guide[];

  const ids = await fetchGuideIds(appId, Number(env.GUIDE_COUNT) || 6);
  const guides: Guide[] = [];
  for (const id of ids) {
    const guide = await fetchGuide(id);
    if (guide) guides.push(guide);
  }

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(guides), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${env.GUIDE_CACHE_SECONDS}`,
        },
      }),
    ),
  );
  return guides;
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
    // A producer that set its own lifetime knows something this helper does
    // not, so it wins.
    if (!response.headers.has("Cache-Control")) {
      response.headers.set("Cache-Control", `public, max-age=${env.CACHE_SECONDS}`);
    }
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
