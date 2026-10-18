/**
 * Loot tiers: achievements grouped the way an RPG grades its drops, by the
 * share of players who hold them. Pure, so the boundaries are tested exactly.
 */

/** Rarest first; `unknown` holds what Steam reports no percentage for. */
export const TIERS = ["legendary", "epic", "rare", "uncommon", "common", "unknown"];

export function lootTier(percent) {
  if (percent === null) return "unknown";
  if (percent < 5) return "legendary";
  if (percent < 10) return "epic";
  if (percent < 25) return "rare";
  if (percent < 50) return "uncommon";
  return "common";
}

/** The achievements by tier, in tier order, keeping their order within each; empty tiers left out. */
export function groupByTier(items) {
  const byTier = new Map(TIERS.map((tier) => [tier, []]));
  for (const item of items) byTier.get(lootTier(item.globalPercent)).push(item);
  return TIERS.filter((tier) => byTier.get(tier).length > 0).map((tier) => ({ tier, items: byTier.get(tier) }));
}

/** Each tier shows this many achievements; the rest wait behind a "more" button. */
export const VISIBLE_PER_TIER = 5;

/** The art for an achievement the player lacks: Steam's locked version, or the normal one greyed. */
export function lockedIcon(achievement) {
  return achievement.iconLocked
    ? { src: achievement.iconLocked, greyed: false }
    : { src: achievement.icon, greyed: true };
}

/** How many of a 20-cell "held by" bar to fill: at least one for any known share. */
export function heldCells(percent) {
  if (percent === null) return 0;
  return Math.min(20, Math.max(1, Math.round(percent / 5)));
}
