/**
 * How hard a game is to complete, from how few players hold its achievements.
 *
 * The 1-10 rating players know from sites like TrueSteamAchievements is a
 * community vote and is not obtainable: every such site answers a Worker with a
 * bot challenge. So this is computed from the global unlock percentages the page
 * already holds - no extra request, no credential, nothing that can go offline.
 *
 * That makes it a measure of rarity rather than an opinion, and the interface
 * says so. The two genuinely disagree: The Stanley Parable scores above Celeste
 * because one of Stanley's achievements asks you not to play for five years.
 *
 * Steam has no platinum trophy, so what is scored is completing every
 * achievement. `difficulty.test.ts` holds the scores this produces for ten real
 * games, which is the record that these constants were not fitted to.
 *
 * Plain JavaScript, and in `public/`, because the browser imports it directly.
 *
 * @typedef {{ score: number, tier: string }} Difficulty
 */

/** Below this many usable percentages there is nothing worth claiming. */
const MINIMUM_ACHIEVEMENTS = 5;

/** The rarity band whose population says how thick the hard tail is. */
const TAIL_THRESHOLD = 10;

/** One player in a thousand: the practical floor of what Steam reports, and the top of the scale. */
const FLOOR_PERCENT = 0.1;

/** Points per factor-of-ten increase in rarity. */
const DECADE_WEIGHT = 3.3;

/** What a list that is entirely hard tail adds on top. */
const TAIL_WEIGHT = 3;

/**
 * The band, as a key the interface translates. The names are deliberately plain:
 * calling a 9 "legendary" would borrow authority a rarity reading has not earned.
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
 * achievement gates completion, so it dominates, on a logarithmic curve because
 * 20% to 10% does not mean what 2% to 1% means. But one freak achievement among
 * fifty easy ones is not a hard game, so the share of the list sitting in the
 * rare tail adjusts it.
 *
 * Null rather than a guess when there is too little to read.
 */
export function completionDifficulty(percentages) {
  // Zero is a reading, not a gap: Steam reports 0.0 for an achievement almost
  // nobody holds, which is the strongest rarity signal there is. Excluding it
  // once handed the score to the next-rarest, so an unfinishable game came out
  // as 1/10. Negatives and non-numbers are still gaps.
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
