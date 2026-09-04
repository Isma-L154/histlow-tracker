/**
 * Which picture a shared link should carry.
 *
 * Steam's `header_image` is 460x215. Facebook and WhatsApp render the large
 * card only from 600x315 up and fall back to a small square thumbnail below
 * it, so the game cards - the more interesting half of the preview feature -
 * were rendering *smaller* than the generic site card on the two platforms
 * with the widest reach.
 *
 * Steam also serves a 616x353 capsule. Not for every game, the issue said,
 * with two of six probed returning 404. That turned out to be a wrong URL
 * rather than a missing image, and the reason is the whole difficulty here.
 */

/** What Steam serves, and what each size means for a card. */
export const CAPSULE = { width: 616, height: 353 } as const;
export const HEADER = { width: 460, height: 215 } as const;

export interface Art {
  url: string;
  width: number;
  height: number;
}

/**
 * The capsule URL for the game whose header art is at this address.
 *
 * A modern `header_image` sometimes carries a content-hash directory and
 * sometimes does not:
 *
 *   .../store_item_assets/steam/apps/413150/header.jpg?t=1786554168
 *   .../store_item_assets/steam/apps/367520/3c3489.../header.jpg?t=1776125684
 *
 * The hash is per asset, not per game - the same response gives
 * `capsule_231x87.jpg` under a different one. So replacing `header.jpg` in
 * that URL asks for the capsule inside the *header's* directory, which 404s.
 * That is what the two failures recorded on the issue were; the images exist
 * at the unhashed path, and re-probed properly, so did all thirty games tried
 * across twenty years of the store.
 *
 * Hence matching up to `/apps/<id>/` and dropping whatever follows. Written
 * against the path rather than the host because Steam answers on several, and
 * the prefix differs between the old ones and the new.
 *
 * The `?t=` cache-buster is dropped: it belongs to the header, and a capsule
 * asking for the header's revision is at best meaningless.
 */
export function capsuleUrl(headerImage: string): string | null {
  const match = /^(https:\/\/[^/]+\/.*\/apps\/\d+\/)(?:[0-9a-f]{8,}\/)?header\.jpg(?:\?|$)/.exec(headerImage);
  return match ? `${match[1]}capsule_616x353.jpg` : null;
}

/**
 * The largest art this game actually has, with its true dimensions.
 *
 * Thirty for thirty is not proof for an obscure game, and a card with no image
 * is worse than a small one - so the capsule is asked for rather than assumed.
 * A `HEAD` costs one round trip, and the cost is smaller than it looks: this
 * is the CDN and not the Web API, so no key and no quota, and it runs only
 * while a game page is being built, which is once per game per day behind that
 * page's own cache.
 *
 * Every failure lands on the header, which is what the site shipped before
 * this existed. Nothing here can leave a game without a card.
 */
export async function cardArt(headerImage: string | null | undefined): Promise<Art | null> {
  if (!headerImage) return null;

  const header: Art = { url: headerImage, ...HEADER };
  const capsule = capsuleUrl(headerImage);
  if (!capsule) return header;

  try {
    const response = await fetch(capsule, { method: "HEAD" });
    return response.ok ? { url: capsule, ...CAPSULE } : header;
  } catch {
    // Not logged. An unreachable CDN is already reported by the request for
    // the page's own data, and this one degrades to the picture the site used
    // to send - which is absence of an improvement, not absence of a card.
    return header;
  }
}
