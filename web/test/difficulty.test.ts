/**
 * The completion difficulty score.
 *
 * Pure and I/O-free, which is what makes it worth testing by property rather
 * than by example: the interesting claims are about how it behaves across every
 * input, not about what it returns for one.
 *
 * The generator is a seeded LCG rather than fast-check. This module has no
 * runtime dependencies by design, the properties here need no shrinking to be
 * actionable, and a fixed seed makes a failure reproducible from the output.
 */

import { describe, expect, it } from "vitest";
import { completionDifficulty } from "../public/difficulty.js";

/** Deterministic pseudo-random source, so a failure can be re-run exactly. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * A plausible achievement list: 5 to 200 percentages between 0 and 100.
 *
 * Zero is in range on purpose. Steam really does report 0.0 for an achievement
 * essentially nobody holds, and flooring the generator at 0.1 - as this did -
 * meant five hundred samples per property could never produce the one value
 * that turned out to be handled wrongly.
 */
function percentages(random: () => number): number[] {
  const count = 5 + Math.floor(random() * 195);
  return Array.from({ length: count }, () => Math.round(random() * 1000) / 10);
}

const SAMPLES = 500;

describe("completionDifficulty", () => {
  describe("properties", () => {
    it("always returns a whole number from 1 to 10", () => {
      const random = generator(1);
      for (let i = 0; i < SAMPLES; i++) {
        const list = percentages(random);
        const result = completionDifficulty(list)!;
        expect(Number.isInteger(result.score), `seed 1 sample ${i}`).toBe(true);
        expect(result.score, `seed 1 sample ${i}`).toBeGreaterThanOrEqual(1);
        expect(result.score, `seed 1 sample ${i}`).toBeLessThanOrEqual(10);
      }
    });

    it("never scores a game lower for being rarer", () => {
      // Monotonicity is the property that makes the number mean anything: if
      // every achievement in a game got rarer, the game did not get easier.
      const random = generator(2);
      for (let i = 0; i < SAMPLES; i++) {
        const list = percentages(random);
        const rarer = list.map((value) => Math.max(0.1, value / 2));
        const before = completionDifficulty(list)!.score;
        const after = completionDifficulty(rarer)!.score;
        expect(after, `sample ${i}: ${before} -> ${after}`).toBeGreaterThanOrEqual(before);
      }
    });

    it("does not depend on the order of the list", () => {
      const random = generator(3);
      for (let i = 0; i < SAMPLES; i++) {
        const list = percentages(random);
        const shuffled = [...list].sort(() => random() - 0.5);
        expect(completionDifficulty(shuffled)).toEqual(completionDifficulty(list));
      }
    });

    it("agrees with itself", () => {
      const random = generator(4);
      for (let i = 0; i < SAMPLES; i++) {
        const list = percentages(random);
        expect(completionDifficulty(list)).toEqual(completionDifficulty(list));
      }
    });

    it("never scores a game lower for having more of its list in the rare tail", () => {
      // The second half of the formula. Without this, deleting the tail term
      // entirely leaves every other test in this file green - which it did,
      // until this was written.
      const random = generator(6);
      for (let i = 0; i < SAMPLES; i++) {
        const list = percentages(random);
        // Drag the common half down into the tail, leaving the rarest alone so
        // only the tail share changes.
        const rarest = Math.min(...list);
        const thicker = list.map((value) => (value === rarest ? value : Math.min(value, 9)));
        const before = completionDifficulty(list)!.score;
        const after = completionDifficulty(thicker)!.score;
        expect(after, `sample ${i}: ${before} -> ${after}`).toBeGreaterThanOrEqual(before);
      }
    });

    it("names every band at its edges", () => {
      // The previous version of this asserted that the same score produced the
      // same tier, which `tier()` guarantees by being a pure function of the
      // score - it could not fail. These are the boundaries themselves, which
      // can.
      const bands: ReadonlyArray<[low: number, high: number, tier: string]> = [
        [1, 2, "straightforward"],
        [3, 4, "someWork"],
        [5, 6, "demanding"],
        [7, 8, "veryHard"],
        [9, 10, "brutal"],
      ];
      const seen = new Map<number, string>();
      const random = generator(5);
      for (let i = 0; i < SAMPLES; i++) {
        const { score, tier } = completionDifficulty(percentages(random))!;
        seen.set(score, tier);
      }
      for (const [score, tier] of seen) {
        const band = bands.find(([low, high]) => score >= low && score <= high);
        expect(band?.[2], `score ${score} was called ${tier}`).toBe(tier);
      }
    });
  });

  describe("an achievement literally nobody holds", () => {
    it("is the strongest signal there is, not a missing one", () => {
      // Steam reports 0.0 for an achievement essentially nobody has - glitched,
      // removed, or brand new. Dropping it as unusable used to score such a
      // game 1/10 "straightforward", which is the opposite of the truth.
      const withZero = completionDifficulty([0, 60, 65, 70, 75, 80])!;
      const without = completionDifficulty([60, 65, 70, 75, 80])!;
      expect(withZero.score).toBeGreaterThan(without.score);
      expect(withZero.tier).toBe("brutal");
    });

    it("still counts towards having enough to read", () => {
      // It is an achievement. Filtering it out could push a five-achievement
      // game under the minimum and hide the score entirely.
      expect(completionDifficulty([0, 50, 50, 50, 50])).not.toBeNull();
    });

    it("makes a list of nothing but zeroes the hardest there is", () => {
      // Not a separate assertion about the tail: any single zero already floors
      // the rarest term at its maximum, so the score is at the ceiling and
      // adding more cannot show up. What this pins is that it is the ceiling,
      // and that a list of them is not mistaken for no data at all.
      expect(completionDifficulty([0, 0, 0, 0, 0])).toEqual({ score: 10, tier: "brutal" });
    });
  });

  describe("when there is nothing to read", () => {
    it.each([
      ["an empty list", []],
      ["fewer than five achievements", [1, 2, 3, 4]],
      ["no percentages at all", [null, null, null, null, null, null]],
      ["too few usable percentages", [1, 2, null, null, null, null]],
      ["percentages that are not numbers", [NaN, Infinity, -1, 0, null, undefined as never]],
    ])("returns null for %s", (_name, list) => {
      // Silence is the honest answer. Inventing a score from one data point
      // would be indistinguishable, in the interface, from a real reading.
      expect(completionDifficulty(list as (number | null)[])).toBeNull();
    });
  });

  describe("calibration", () => {
    /**
     * Real distributions, read from the live API, recorded so a later change to
     * the formula can be checked against something concrete.
     *
     * These are not a target the formula was fitted to. Rarity and reputation
     * disagree, and where they do, the number is reporting the rarity: Celeste
     * scores below The Stanley Parable because Stanley hides an achievement for
     * not playing for five years, and almost nobody has it.
     */
    const GAMES: ReadonlyArray<[name: string, rarest: number, tailShare: number, total: number]> = [
      ["Firewatch", 7.8, 1 / 10, 10],
      ["The Stanley Parable", 2.8, 3 / 10, 10],
      ["Dark Souls III", 5.1, 7 / 43, 43],
      ["Celeste", 6.6, 4 / 32, 32],
      ["Hollow Knight", 3.9, 13 / 63, 63],
      ["Stardew Valley", 1.3, 19 / 49, 49],
      ["Cuphead", 2.8, 21 / 42, 42],
      ["Binding of Isaac: Rebirth", 2.5, 161 / 641, 641],
      ["Terraria", 0.5, 34 / 137, 137],
      ["Super Meat Boy", 1.3, 43 / 48, 48],
    ];

    /** Rebuilds a list with the recorded rarest value and tail share. */
    function shaped(rarest: number, tailShare: number, total: number): number[] {
      const inTail = Math.round(tailShare * total);
      return [
        rarest,
        ...Array.from({ length: Math.max(0, inTail - 1) }, () => 9),
        ...Array.from({ length: total - inTail }, () => 50),
      ];
    }

    it.each(GAMES)("scores %s consistently", (_name, rarest, tailShare, total) => {
      const result = completionDifficulty(shaped(rarest, tailShare, total))!;
      expect(result).not.toBeNull();
      expect(result.score).toBeGreaterThanOrEqual(1);
      expect(result.score).toBeLessThanOrEqual(10);
    });

    it("separates two real games that share a rarest achievement", () => {
      // Cuphead and The Stanley Parable both bottom out at 2.8%, so the rarest
      // achievement alone cannot tell them apart. Half of Cuphead's list is in
      // the rare tail against under a third of Stanley's, and that is the whole
      // reason the tail term exists.
      const cuphead = completionDifficulty(shaped(2.8, 21 / 42, 42))!;
      const stanley = completionDifficulty(shaped(2.8, 3 / 10, 10))!;
      expect(cuphead.score).toBeGreaterThan(stanley.score);
    });

    it("puts Super Meat Boy above Firewatch", () => {
      const smb = completionDifficulty(shaped(1.3, 43 / 48, 48))!;
      const firewatch = completionDifficulty(shaped(7.8, 1 / 10, 10))!;
      expect(smb.score).toBeGreaterThan(firewatch.score);
    });

    it("separates the extremes across most of the scale", () => {
      // A formula that maps every real game into two adjacent numbers is not
      // telling anyone anything, however defensible each number is.
      const scores = GAMES.map(([, r, t, n]) => completionDifficulty(shaped(r, t, n))!.score);
      expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThanOrEqual(4);
    });
  });
});
