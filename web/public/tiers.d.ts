/** Types for `tiers.js`, which is plain JavaScript because the browser loads it directly. */

export type Tier = "legendary" | "epic" | "rare" | "uncommon" | "common" | "unknown";

export declare const TIERS: readonly Tier[];

export declare function lootTier(percent: number | null): Tier;

export declare function groupByTier<T extends { globalPercent: number | null }>(
  items: readonly T[],
): { tier: Tier; items: T[] }[];

export declare function heldCells(percent: number | null): number;

export declare const VISIBLE_PER_TIER: 5;

export declare function lockedIcon(achievement: { icon: string; iconLocked: string }): { src: string; greyed: boolean };
