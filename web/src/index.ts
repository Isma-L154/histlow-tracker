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

import { VERSION, json, problem, logFailure, storable } from "./http.ts";
import { SteamError, SteamClient, type GameAchievements } from "./steam.ts";
import { fetchGuideIds, fetchGuideIdsFor, fetchGuide, findPassages, type Guide } from "./guides.ts";
import { explainAchievement } from "./howto.ts";
import { describeGame } from "./preview.ts";
import { languageFor, localise, pageCacheKey } from "./language.ts";
import { parseProfile } from "./profile.ts";
import { IgdbClient, accessToken, credentials, usable } from "./igdb.ts";

/** How long a game takes to finish, when IGDB knows. */
const COMPLETION_TIME_ROUTE = /^\/api\/time\/(\d{1,10})$/;

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
 * What to say about an input that is not a profile.
 *
 * One message per way of being wrong. A single "that is not a profile" would
 * cover an empty box, a mistyped id and a link from the wrong site alike, and
 * the reader would have to guess which of the three they had done.
 */
const PROFILE_PROBLEMS: Record<string, string> = {
  empty: "Paste your Steam profile link, or your SteamID64.",
  "too long": "That is longer than any Steam profile link.",
  "wrong length for an id": "A SteamID64 is exactly 17 digits.",
  "unrecognised link": "That link is not a Steam profile. It should start with steamcommunity.com.",
  "not an id": "A /profiles/ link should end in a 17-digit SteamID64.",
  unreadable: "That link could not be read. Try copying it again from your browser.",
  default: "That is not a Steam profile link, a SteamID64, or a custom profile name.",
};

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
      return gamePage(Number(page[1]), url, env, languageFor(request), ctx);
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
        return problem(error.status, error.message, error.reason);
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

  if (url.pathname === "/api/steamid") {
    const parsed = parseProfile(url.searchParams.get("q") ?? "");
    if (parsed.kind === "invalid") {
      // The reason travels, because the panel shows it. "That is not a profile"
      // for an empty box and for a name Steam has never heard of would be two
      // different problems wearing one message.
      const reason = parsed.reason in PROFILE_PROBLEMS ? parsed.reason : "default";
      return problem(400, PROFILE_PROBLEMS[reason]!, `profile.${reason}`);
    }

    // This route spends the Steam key, and a name Steam does not know cannot be
    // answered from cache the first time. Caching alone therefore protects the
    // repeats and not the walk, so the walk is rate limited: setting up a
    // profile is done once, and ten a minute is far above that and far below
    // what enumeration needs.
    if (!(await withinRate(request, env, "PROFILE"))) {
      return problem(429, "Too many profile lookups. Wait a minute and try again.", "profile.tooMany");
    }

    // A name maps to an id essentially forever, so this is worth caching hard.
    // Keyed on what was parsed rather than on what was typed, so the same
    // profile pasted five different ways is one entry.
    return cached(key(url, `/api/steamid/${parsed.kind}/${parsed.value}`), false, env, ctx, async () => {
      try {
        if (parsed.kind === "id") {
          return json({ steamId: parsed.value, profileName: await client(env).profileName(parsed.value) });
        }
        return json(await client(env).resolveVanity(parsed.value));
      } catch (error) {
        // "Steam has never heard of that name" is a stable answer, so it is
        // cached like any other. Without this the same wrong guess spends the
        // API key every time it is retried, and the rate limit above would be
        // carrying weight it does not need to.
        if (error instanceof SteamError && error.reason === "profile.unknown") {
          return problem(404, error.message, error.reason, { "Cache-Control": "public, max-age=3600" });
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
    return cached(key(url, `/api/search?q=${encodeURIComponent(query.toLowerCase())}`), false, env, ctx, async () => {
      const results = await client(env).search(query);
      return json({ results });
    });
  }

  const time = COMPLETION_TIME_ROUTE.exec(url.pathname);
  if (time) {
    // Enumerable, and every unseen id spends the IGDB credential. The same
    // reasoning as the profile route: caching protects the repeats, not the
    // walk, so the walk is limited.
    if (!(await withinRate(request, env, "PROFILE"))) {
      return problem(429, "Too many lookups. Wait a minute and try again.", "profile.tooMany");
    }

    return cached(key(url, `/api/time/${time[1]}`), false, env, ctx, async () => {
      const creds = credentials(env);
      // Not configured is a state, not a failure, and it will not change until
      // someone deploys. Cacheable like any other answer.
      if (!creds) return json({ completionTime: null });

      try {
        const token = await igdbToken(creds, ctx);
        const completionTime = await new IgdbClient(creds.clientId, token).completionTime(Number(time[1]));
        // IGDB having nothing for a game is a stable fact. Re-asking on every
        // visit would spend the budget on an answer that will not change.
        return json({ completionTime });
      } catch (error) {
        // An outage, a rate limit or a revoked credential is the operator's
        // problem: the reader gets the page without the section either way.
        // But it must not be cached as though IGDB had answered - one failure
        // during the first request for a game would otherwise poison that game
        // for a day, long after IGDB recovered. The same distinction the
        // profile route makes, which this got wrong until review.
        logFailure("igdb completion time failed", error);
        return json({ completionTime: null }, { headers: { "Cache-Control": "no-store" } });
      }
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

async function withinRate(request: Request, env: Env, which: "HOWTO" | "PROFILE" = "HOWTO"): Promise<boolean> {
  const limiter = which === "HOWTO" ? env.HOWTO_LIMITER : env.PROFILE_LIMITER;
  if (!limiter) return true;

  // `CF-Connecting-IP` is written by the edge and cannot be set by a client,
  // so it is the one caller identity here that is worth keying on. Without it
  // - only outside Cloudflare - every caller shares one bucket, which is
  // stricter than intended rather than looser.
  const caller = request.headers.get("CF-Connecting-IP") ?? "unidentified";
  // The in-isolate allowance is about the cost of a fresh model answer, which
  // only the how-to route pays.
  if (which === "HOWTO" && spentAllowance(caller, Date.now())) return false;

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
/**
 * An IGDB access token, kept at the edge.
 *
 * Twitch tokens last about sixty days, so asking for one per request would add
 * a round trip to every page and spend a rate limit on work whose answer barely
 * changes. Stored with a lifetime shorter than its own expiry, so the cache
 * gives it up before Twitch does.
 */
async function igdbToken(
  creds: { clientId: string; clientSecret: string },
  ctx: ExecutionContext,
): Promise<string> {
  const cache = caches.default;
  const cacheKey = "https://token.invalid/igdb/v1";

  const hit = await cache.match(cacheKey);
  if (hit) {
    const stored = (await hit.json()) as { value: string; expiresAt: number };
    if (usable(stored, Date.now())) return stored.value;
  }

  const token = await accessToken(creds, Date.now());
  const lifetime = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000));
  ctx.waitUntil(
    cache.put(
      cacheKey,
      // Never `public`: this is a credential, and a cache outside this Worker
      // has no business holding one.
      new Response(JSON.stringify(token), {
        headers: { "Content-Type": "application/json", "Cache-Control": `private, max-age=${lifetime}` },
      }),
    ),
  );
  return token.value;
}

async function translated(response: Response, language: string): Promise<Response> {
  if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;

  const out = new Response(localise(await response.text(), language), response);

  // `Vary: Accept-Language` is the obvious answer and is not a sufficient one:
  // Cloudflare's cache only considers `Vary: Accept-Encoding`, so a shared
  // cache is free to hand one reader's language to the next. It is still sent,
  // because caches that do honour it should - but what actually keeps the two
  // apart is `private`, which forbids a shared cache from holding this at all.
  //
  // Cheap to give up here: rewriting a shell that came from the asset binding
  // costs no upstream request.
  out.headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  out.headers.append("Vary", "Accept-Language");

  // The body was rewritten; the headers were inherited from the untranslated
  // asset, validator included. Left alone, both languages ship the same ETag,
  // and a browser holding the English copy would revalidate, be told 304, and
  // keep showing English on a page it had just asked for in Spanish. The
  // language joins the validator rather than the validator being dropped, so
  // revalidation still works - it just works per language.
  const etag = out.headers.get("ETag");
  if (etag) out.headers.set("ETag", etag.replace(/"$/, `-${language}"`));

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
async function gamePage(
  appId: number,
  url: URL,
  env: Env,
  language: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const page = `${url.origin}/game/${appId}`;

  // Cached here rather than by a header, because the language is part of what
  // makes this response what it is and `Vary` cannot be relied on to say so.
  // A key this Worker owns cannot be misread by anyone else's cache.
  //
  // This also removes a per-request Steam call that the old header-only caching
  // only avoided when a shared cache happened to cooperate.
  const cache = caches.default;
  const hit = await cache.match(pageCacheKey(appId, language));
  if (hit) return hit;

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

  const response = new Response(described, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Same shape for every visitor of the same language, and the underlying
      // data barely moves. `private` because the copy a shared cache would keep
      // is only right for one of the two languages; the Worker's own cache
      // above is what makes this fast, and its key says which language it holds.
      "Cache-Control": `private, max-age=${env.CACHE_SECONDS}`,
      Vary: "Accept-Language",
    },
  });

  ctx.waitUntil(cache.put(pageCacheKey(appId, language), response.clone()));
  return response;
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
  // A producer that set its own lifetime knows something this helper does not,
  // so it wins - in both directions.
  //
  // Upwards: most failures are transient and must not be cached, which is why
  // success is the default; but "Steam has never heard of that name" is a
  // stable answer, and not caching it leaves a route that spends the API key on
  // every repeat of the same wrong guess.
  //
  // Downwards: `no-store` means what it says. Without this the rule above
  // cached the very responses written to avoid being cached - an IGDB outage
  // saying "no data" would have been stored for a day.
  const control = response.headers.get("Cache-Control");
  if (storable(control, response.ok)) {
    if (control === null) {
      response.headers.set("Cache-Control", `public, max-age=${env.CACHE_SECONDS}`);
    }
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
