/**
 * How hard a game is to complete, from how few people have done its parts.
 *
 * The 1-10 difficulty players recognise from sites like TrueSteamAchievements
 * is a community vote, and it is not obtainable: every such site answers a
 * Worker with a Cloudflare bot challenge. So this is computed instead, from the
 * global unlock percentages the page already downloads - no extra request, no
 * credential, and nothing that can go offline.
 *
 * That makes it a measure of rarity, not an opinion, and the interface has to
 * say so. Rarity and reputation genuinely disagree: Celeste's rarest
 * achievement sits at 6.6% while The Stanley Parable's is at 2.8%, because one
 * of Stanley's asks you to not play for five years. The score reports what the
 * numbers say.
 *
 * Steam has no platinum trophy - that is a PlayStation idea - so what is being
 * scored is completing every achievement.
 *
 * What it produces, read from real distributions on the live API:
 *
 *   game                        rarest   in tail   score
 *   Firewatch                     7.8%       10%     4  Some work
 *   Celeste                       6.6%       13%     4  Some work
 *   Dark Souls III                5.1%       16%     5  Demanding
 *   Hollow Knight                 3.9%       21%     5  Demanding
 *   The Stanley Parable           2.8%       30%     6  Demanding
 *   Binding of Isaac: Rebirth     2.5%       25%     6  Demanding
 *   Stardew Valley                1.3%       39%     7  Very hard
 *   Cuphead                       2.8%       50%     7  Very hard
 *   Terraria                      0.5%       25%     8  Very hard
 *   Super Meat Boy                1.3%       90%     9  Brutal
 *
 * That table is a record, not a target: the constants below were not fitted to
 * it. Cuphead and The Stanley Parable share a rarest achievement and are
 * separated only by the tail, which is what the second term is for.
 */

/**
 * Plain JavaScript, and in `public/`, because the browser imports it directly:
 * the page already holds every percentage this needs, so computing the score
 * here costs nothing and asking the Worker for it would cost a request.
 *
 * @typedef {{ score: number, tier: string }} Difficulty
 */

/** Below this many usable percentages there is nothing worth claiming. */
const MINIMUM_ACHIEVEMENTS = 5;

/** The rarity band whose population says how thick the hard tail is. */
const TAIL_THRESHOLD = 10;

/**
 * Where the logarithmic curve starts, as a percentage.
 *
 * An achievement held by one player in a thousand is the practical floor of
 * what Steam reports, and it anchors the top of the scale.
 */
const FLOOR_PERCENT = 0.1;

/** How many points one factor-of-ten increase in rarity is worth. */
const DECADE_WEIGHT = 3.3;

/** How much a list that is entirely hard tail adds on top. */
const TAIL_WEIGHT = 3;

/**
 * The bands, named rather than worded.
 *
 * A key, not a label: this module knows nothing about languages, and the
 * interface exists in two. The names are deliberately plain - calling a 9
 * "legendary" would borrow authority a rarity reading has not earned.
 */
function tier(score) {
  if (score <= 2) return "straightforward";
  if (score <= 4) return "someWork";
  if (score <= 6) return "demanding";
  if (score <= 8) return "veryHard";
  return "brutal";
}

/**
 * Scores completing every achievement in a game, or returns null.
 *
 * Two signals, because either alone misreads a real game. The rarest
 * achievement is what actually gates completion, so it dominates - on a
 * logarithmic curve, because the distance from 20% to 10% does not mean what
 * the distance from 2% to 1% means. But one freak achievement among fifty easy
 * ones is not a hard game, so the share of the list sitting in the rare tail
 * adjusts it.
 *
 * Null rather than a guess when there is nothing to read: an empty list, one
 * Steam has no percentages for, or one too short to say anything.
 */
export function completionDifficulty(percentages) {
  // Zero is a reading, not a gap. Steam reports 0.0 for an achievement
  // essentially nobody holds - glitched, removed, or brand new - and that is
  // the strongest rarity signal there is. Excluding it used to hand the score
  // to the next-rarest achievement instead, so a game nobody can finish came
  // out as 1/10, and a five-achievement game with one lost the score entirely
  // by falling under the minimum. Negatives and non-numbers are still gaps.
  const usable = percentages.filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  if (usable.length < MINIMUM_ACHIEVEMENTS) return null;

  const rarest = Math.max(Math.min(...usable), FLOOR_PERCENT);
  const tailShare = usable.filter((value) => value < TAIL_THRESHOLD).length / usable.length;

  const fromRarest = 10 - DECADE_WEIGHT * Math.log10(rarest / FLOOR_PERCENT);
  const score = clamp(Math.round(fromRarest + TAIL_WEIGHT * tailShare));

  return { score, tier: tier(score) };
}

function clamp(value) {
  return Math.min(10, Math.max(1, value));
}
