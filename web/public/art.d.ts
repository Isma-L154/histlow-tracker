/** Types for `art.js`, which is plain JavaScript because the browser loads it directly. */

export declare function bannerSources(appId: number, headerImage: string | null): { hero: string[]; logo: string };

export declare function rarestHeld<T extends { unlocked: boolean | null; globalPercent: number | null }>(
  achievements: readonly T[],
): T | null;
