/** Types for `difficulty.js`, which is plain JavaScript because the browser loads it directly. */

export interface Difficulty {
  /** 1 (anyone finishes it) to 10 (almost nobody does). */
  score: number;
  /** The band, as a key the interface translates. */
  tier: "straightforward" | "someWork" | "demanding" | "veryHard" | "brutal";
}

/** Scores completing every achievement, or null when there is too little to read. */
export declare function completionDifficulty(
  percentages: readonly (number | null)[],
): Difficulty | null;
