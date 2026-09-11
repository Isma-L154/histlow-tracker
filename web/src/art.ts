/**
 * Which picture a shared link carries.
 *
 * Steam's 460x215 header renders as a small thumbnail on Facebook and WhatsApp,
 * which need 600x315 for the large card. Steam also serves a 616x353 capsule.
 */

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
 * A header URL may carry a per-asset content-hash directory, and the capsule does
 * not live under the header's hash, so everything after `/apps/<id>/` is dropped,
 * along with the header's own `?t=` cache-buster.
 */
export function capsuleUrl(headerImage: string): string | null {
  const match = /^(https:\/\/[^/]+\/.*\/apps\/\d+\/)(?:[0-9a-f]{8,}\/)?header\.jpg(?:\?|$)/.exec(headerImage);
  return match ? `${match[1]}capsule_616x353.jpg` : null;
}

/**
 * The largest art the game actually has, with its true dimensions.
 *
 * The capsule is probed with a HEAD - the CDN, not the Web API, so no key or
 * quota - and every failure falls back to the header, so no game loses its card.
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
    // Not logged: the page's own data request already reports an unreachable CDN.
    return header;
  }
}
