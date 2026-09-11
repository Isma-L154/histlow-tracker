/**
 * How one achievement is earned: find the guide passages that discuss it, then
 * have the model rewrite them into steps.
 *
 * The passages travel back with the steps. They are the evidence, and when the
 * model is wrong or its daily allocation is spent, they are still the answer.
 */

import { json, problem } from "./http.ts";
import { steamClient } from "./steam.ts";
import { fetchGuide, fetchGuideIds, fetchGuideIdsFor, findPassages, type Guide } from "./guides.ts";
import { explainAchievement } from "./howto.ts";

export async function explain(
  appId: number,
  achievementKey: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const achievement = await steamClient(env).achievementByKey(appId, achievementKey);
  if (!achievement) {
    return problem(404, "That achievement does not belong to this game.");
  }

  const guides = await corpus(appId, env, ctx);
  let passages = findPassages(guides, achievement.name, achievement.description, 3);
  let searched = guides.length;

  // The shared corpus is often route walkthroughs that never name an
  // achievement, so a search aimed at this one is paid for only on a miss.
  if (passages.length === 0) {
    const targeted = await downloaded(await fetchGuideIdsFor(appId, achievement.name, 2));
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
      // A miss keeps for an hour: it often means nobody has written it up yet.
      headers: { "Cache-Control": `public, max-age=${answered ? 604800 : 3600}` },
    },
  );
}

/**
 * A game's guide corpus, downloaded once and reused for every achievement in it.
 *
 * Versioned by hand rather than by deployment: rebuilding means scraping six
 * guide pages, too slow to pay after every publish. Bump the segment when
 * `fetchGuide` changes what it puts in a `Guide`.
 */
async function corpus(appId: number, env: Env, ctx: ExecutionContext): Promise<Guide[]> {
  const cache = caches.default;
  const cacheKey = `https://corpus.invalid/guides/v2/${appId}`;

  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()) as Guide[];

  const guides = await downloaded(await fetchGuideIds(appId, Number(env.GUIDE_COUNT) || 6));

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

/** Fetches each guide in turn, skipping any that could not be read. */
async function downloaded(ids: string[]): Promise<Guide[]> {
  const guides: Guide[] = [];
  for (const id of ids) {
    const guide = await fetchGuide(id);
    if (guide) guides.push(guide);
  }
  return guides;
}
