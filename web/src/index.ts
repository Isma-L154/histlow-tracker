/**
 * Steam achievement browser.
 *
 * One Worker serves both halves of the site. Every request for a document
 * runs this code - the rename made that necessary, since the redirect from the
 * former address has to see the request. Stylesheets, scripts and images are
 * still served straight from `public/` by the assets runtime without invoking
 * the Worker at all.
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
import { SteamError, SteamClient, type GameAchievements } from "./steam.ts";
import { fetchGuideIds, fetchGuideIdsFor, fetchGuide, findPassages, type Guide } from "./guides.ts";
import { explainAchievement } from "./howto.ts";
import { describeGame } from "./preview.ts";
import { languageFor, localise } from "./language.ts";

const GAME_ROUTE = /^\/api\/game\/(\d{1,10})$/;
// The page a person shares, as opposed to the endpoint behind it.
const GAME_PAGE_ROUTE = /^\/game\/(\d{1,10})$/;
// Achievement keys are developer-chosen identifiers, so the character class is
// deliberately broad - but bounded, and never interpolated into an upstream URL
// without encoding.
const HOWTO_ROUTE = /^\/api\/howto\/(\d{1,10})\/([\w.%-]{1,120})$/;

/**
 * Longest search accepted.
 *
 * There was a floor of two characters and no ceiling, so an 8,000-character
 * query was forwarded to Steam whole - free amplification against a quota this
 * project cannot afford to lose. No real title comes close to a hundred.
 */
const MAX_QUERY_LENGTH = 100;

/**
 * Bumped whenever retrieval or prompting changes.
 *
 * Answers are cached for a week, so without this a deploy that improves how
 * passages are found would keep serving the answers the old logic produced -
 * and the improvement would be invisible exactly where it mattered.
 */
const HOWTO_LOGIC_VERSION = 4;

/**
 * The address the site answered on before the rename.
 *
 * Still routed to this Worker on purpose. Those links were shared, bookmarked
 * and indexed, and `sitemap.xml` listed four of them, so they are answered
 * rather than dropped.
 */
const FORMER_HOST = "cazalogros.cloudils.com";

/** Where they go now. */
const CANONICAL_HOST = "howtoachieve.cloudils.com";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Before anything else, including route matching: a reader arriving on an
    // old link should land on the page they wanted, not on this Worker's
    // opinion of whether their path is valid. 301 rather than 302 because the
    // move is permanent, and a temporary redirect leaves the old address
    // indexed indefinitely.
    if (url.hostname === FORMER_HOST) {
      url.hostname = CANONICAL_HOST;
      return Response.redirect(url.toString(), 301);
    }

    const page = GAME_PAGE_ROUTE.exec(url.pathname);
    if (page && request.method === "GET") {
      return gamePage(Number(page[1]), url, env, languageFor(request));
    }

    if (!url.pathname.startsWith("/api/")) {
      // Everything else is a static file, or the SPA fallback for a path that
      // does not match one. Documents are translated before they leave, so the
      // first paint is already in the reader's language; anything that is not
      // HTML passes straight through.
      const asset = await env.ASSETS.fetch(request);
      return translated(asset, languageFor(request));
    }

    if (request.method !== "GET") {
      return problem(405, "Only GET is supported.");
    }

    try {
      return await route(request, url, env, ctx);
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

async function route(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (url.pathname === "/api/health") {
    return json({ ok: true, version: VERSION });
  }

  if (url.pathname === "/api/search") {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length < 2) {
      return problem(400, "Search for at least two characters.");
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return problem(400, `Search for at most ${MAX_QUERY_LENGTH} characters.`);
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
    // Checked before anything else on this route, including validation: the
    // point is to cost a flooder as little of our time as possible.
    const allowed = await withinRate(request, env);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Demasiadas consultas seguidas. Espera un momento." }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            // The window is a minute, so a minute is the honest answer.
            "Retry-After": "60",
            "Cache-Control": "no-store",
          },
        },
      );
    }

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
 * Whether this caller may ask the model again right now.
 *
 * Keyed on the caller rather than the route, so one script cannot silence the
 * page for everyone - which is exactly what an unmetered route allowed, since
 * the daily neuron allocation is shared by every visitor.
 *
 * A missing binding means the limiter is not configured, and the request is
 * allowed. Failing open is deliberate: this protects a budget, and breaking
 * the feature to defend it would hand over the outage for free.
 *
 * KNOWN GAP, measured rather than assumed. On this account the binding is
 * present and `limit()` resolves, but never returns `success: false`: thirty
 * concurrent calls on one key against a limit of twenty were all allowed, with
 * the outcome logged from production. Miniflare does enforce it, so the tests
 * below pass and would keep passing if the platform started counting. Until it
 * does, `spentAllowance` is what actually holds the line.
 */
/**
 * A second limit that does not depend on the platform counting for us.
 *
 * The edge cache absorbs repeated questions, so anything reaching this point
 * is a first-time answer - the expensive kind.
 *
 * The ceiling is per isolate, and that is the honest description of it. A
 * measured burst of twenty-five parallel requests from one address was spread
 * across eight isolates, the busiest of which saw eight; a per-isolate ceiling
 * of twenty would never have been reached. Eight is chosen so that a spread
 * burst still trips it, while a person opening achievements one at a time
 * never will.
 *
 * This is a damage cap, not a precise quota. It cannot be precise without
 * shared state, and a Durable Object for this would cost more than the budget
 * it defends.
 */
const recentByCaller = new Map<string, number[]>();
const FRESH_ANSWER_WINDOW_MS = 60_000;
const MAX_FRESH_ANSWERS = 8;

function spentAllowance(caller: string, now: number): boolean {
  const seen = (recentByCaller.get(caller) ?? []).filter((at) => now - at < FRESH_ANSWER_WINDOW_MS);
  seen.push(now);
  recentByCaller.set(caller, seen);

  // An isolate is recycled often enough that this cannot grow without bound in
  // practice, but a burst of distinct addresses should not be able to make it
  // the reason the Worker runs out of memory.
  if (recentByCaller.size > 5_000) recentByCaller.clear();

  return seen.length > MAX_FRESH_ANSWERS;
}

async function withinRate(request: Request, env: Env): Promise<boolean> {
  const limiter = env.HOWTO_LIMITER;
  if (!limiter) return true;

  // `CF-Connecting-IP` is written by the edge and cannot be set by a client,
  // so it is the one caller identity here that is worth keying on. Without it
  // - only outside Cloudflare - every caller shares one bucket, which is
  // stricter than intended rather than looser.
  const caller = request.headers.get("CF-Connecting-IP") ?? "unidentified";
  if (spentAllowance(caller, Date.now())) return false;

  try {
    const { success } = await limiter.limit({ key: caller });
    return success;
  } catch (error) {
    logFailure("rate limiter unavailable", error);
    return true;
  }
}

/**
 * Translates an asset response if it is a document, and passes it through if
 * it is not.
 *
 * Reading the body of every stylesheet and image to look for markers would
 * undo the point of keeping them off Worker code in the first place, so the
 * content type decides.
 */
async function translated(response: Response, language: string): Promise<Response> {
  if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;

  const out = new Response(localise(await response.text(), language), response);
  // Two versions of every page now exist, so the cache has to be told what
  // distinguishes them.
  out.headers.append("Vary", "Accept-Language");
  return out;
}

/**
 * The HTML for one game's page, described so a shared link previews properly.
 *
 * Preview bots do not run JavaScript, so the title and image a person sees in
 * a chat app have to be in the document as it leaves the Worker. Failing to
 * find the game is not an error here: the shell still renders, and the client
 * will report the problem in the reader's own language.
 */
async function gamePage(appId: number, url: URL, env: Env, language: string): Promise<Response> {
  const page = `${url.origin}/game/${appId}`;

  let game: GameAchievements | null = null;
  try {
    game = await client(env).gameAchievements(appId, null);
  } catch (error) {
    // An id Steam does not know, or a game with no achievements, is a normal
    // answer and not worth a line. An outage, a block page, or a rejected API
    // key is the operator's problem, and this is the only place that would
    // ever say so: the reader gets an error in their own language from the
    // client, and a preview scraper reports nothing to anybody.
    const unknownGame = error instanceof SteamError && error.upstreamStatus < 500 && error.status === 404;
    if (!unknownGame) logFailure("game page lookup failed", error);
  }

  let described: string;
  try {
    const shell = await env.ASSETS.fetch(new URL("/index.html", url.origin));
    const rewrite = describeGame(localise(await shell.text(), language), game, page);

    // A pattern that matches nothing returns the shell untouched and says
    // nothing. Since the fallback is now a polished card rather than a visibly
    // bare one, nobody would notice by looking - so it is said out loud.
    if (rewrite.missed.length > 0) {
      logFailure("preview rewrite found no match", `tags: ${rewrite.missed.join(", ")}`);
    }
    described = rewrite.html;
  } catch (error) {
    // The shell itself is missing or unreadable. Nothing here can recover, and
    // this runs before the handler's own catch, so it would otherwise leave
    // the runtime to answer with an unlogged 1101.
    logFailure("game page shell unavailable", error);
    return problem(500, "Something went wrong handling that request.");
  }

  return new Response(described, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Same shape for every visitor, and the underlying data barely moves.
      "Cache-Control": `public, max-age=${env.CACHE_SECONDS}`,
      // Two versions of this page now exist. Without this, whichever language
      // was requested first would be served to everyone until it expired.
      Vary: "Accept-Language",
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
  // Versioned because the cached payload holds display strings - the guide
  // title and author fallbacks - so a week-old entry would keep serving the
  // Spanish ones after this deploy. Bump alongside any change to what
  // `fetchGuide` puts in a `Guide`.
  const cacheKey = `https://corpus.invalid/guides/v2/${appId}`;

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
