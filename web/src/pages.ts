/**
 * The documents the Worker writes itself: a shell translated before its first
 * paint, and a game page described so a shared link previews as the game.
 */

import { known, logFailure } from "./http.ts";
import { steamClient, unknownGame, type GameAchievements } from "./steam.ts";
import { describeGame } from "./preview.ts";
import { cardArt } from "./art.ts";
import { localise, pageCacheKey } from "./language.ts";

/** Translates an asset response if it is HTML, and passes anything else through. */
export async function translated(response: Response, language: string): Promise<Response> {
  if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;

  const out = new Response(localise(await response.text(), language), response);

  // Cloudflare's cache honours only `Vary: Accept-Encoding`, so `private` is
  // what keeps one reader's language from the next. `Vary` is still sent for
  // caches that do honour it.
  out.headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  out.headers.append("Vary", "Accept-Language");

  // The body changed but the validator was inherited. Left alone, a browser
  // holding the English copy would revalidate, get a 304, and keep English.
  const etag = out.headers.get("ETag");
  if (etag) out.headers.set("ETag", etag.replace(/"$/, `-${language}"`));

  return out;
}

/**
 * One game's page, with the title and art in the HTML for preview bots, which
 * do not run JavaScript. An unknown game still gets the shell; the client
 * reports the problem in the reader's own language.
 *
 * Cached under a key this Worker owns, because the language is part of the
 * answer and `Vary` cannot carry it. Not rate limited: every answer here is
 * cacheable, an unknown id included, so walking ids costs once per colo per day.
 */
export async function gamePage(
  appId: number,
  url: URL,
  env: Env,
  language: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const page = `${url.origin}/game/${appId}`;

  const cache = caches.default;
  const hit = await cache.match(pageCacheKey(appId, language));
  if (hit) return hit;

  let game: GameAchievements | null = null;
  try {
    game = await steamClient(env).gameAchievements(appId, null);
  } catch (error) {
    // An unknown id is a normal answer. Anything else is the operator's to know,
    // and nobody else would ever report it.
    if (!unknownGame(error)) logFailure("game page lookup failed", error);
  }

  let described: string;
  try {
    // Independent, so probing for the larger art costs no extra wall time.
    const [shell, art] = await Promise.all([
      env.ASSETS.fetch(new URL("/index.html", url.origin)),
      cardArt(game?.headerImage),
    ]);
    const rewrite = describeGame(localise(await shell.text(), language), game, page, art);

    // A pattern that matches nothing changes nothing and says nothing.
    if (rewrite.missed.length > 0) {
      logFailure("preview rewrite found no match", `tags: ${rewrite.missed.join(", ")}`);
    }
    described = rewrite.html;
  } catch (error) {
    logFailure("game page shell unavailable", error);
    return known(500, "error.500");
  }

  const response = new Response(described, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // `private`: a shared cache's copy would be right for one language only.
      "Cache-Control": `private, max-age=${env.CACHE_SECONDS}`,
      Vary: "Accept-Language",
    },
  });

  ctx.waitUntil(cache.put(pageCacheKey(appId, language), response.clone()));
  return response;
}
