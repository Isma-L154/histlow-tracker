/**
 * What the game page header shows: Steam's art for the banner and the
 * achievement a player can boast about. Pure, so the fallbacks are tested.
 */

const STORE_ASSETS = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps";

/** The banner images to try in order, and the transparent logo laid over them. */
export function bannerSources(appId, headerImage) {
  const base = `${STORE_ASSETS}/${appId}`;
  return {
    hero: [`${base}/library_hero.jpg`, headerImage].filter(Boolean),
    logo: `${base}/logo.png`,
  };
}

/** The unlocked achievement the fewest players hold, or null when there is none to name. */
export function rarestHeld(achievements) {
  let best = null;
  for (const achievement of achievements) {
    if (achievement.unlocked !== true || achievement.globalPercent === null) continue;
    if (best === null || achievement.globalPercent < best.globalPercent) best = achievement;
  }
  return best;
}
