/**
 * The home page scene: how it scales and when it draws.
 *
 * Pixel art only stays crisp at a whole-number scale, and an animation that
 * keeps running off screen, or for a reader who asked for less motion, costs
 * battery for nothing. Both are decided by small pure pieces, tested here.
 */

import { describe, expect, it } from "vitest";
import { createLoop, pickScale } from "../public/world/engine.js";
import { WORLDS } from "../public/world/scenes.js";

describe("pickScale", () => {
  it.each([
    [375, { scale: 2, width: 188 }],
    [320, { scale: 2, width: 160 }],
    [1200, { scale: 4, width: 300 }],
  ])("scales a %ipx hero to %o", (container, expected) => {
    expect(pickScale(container)).toEqual(expected);
  });

  it("never scales past 4", () => {
    expect(pickScale(3000).scale).toBe(4);
  });

  it("covers the container in whole pixels at every width", () => {
    for (let container = 320; container <= 2560; container++) {
      const { scale, width } = pickScale(container);
      expect(Number.isInteger(scale)).toBe(true);
      expect(scale).toBeGreaterThanOrEqual(2);
      expect(scale).toBeLessThanOrEqual(4);
      expect(width * scale).toBeGreaterThanOrEqual(container);
      expect(width).toBeGreaterThanOrEqual(160);
    }
  });
});

describe("createLoop", () => {
  /** A scheduler that only runs a frame when the test says so. */
  function manual() {
    const queue: ((ms: number) => void)[] = [];
    return {
      schedule: (callback: (ms: number) => void) => queue.push(callback),
      frame: (ms: number) => queue.shift()?.(ms),
      pending: () => queue.length,
    };
  }

  it("draws a single still frame when the reader asked for less motion", () => {
    const clock = manual();
    let draws = 0;
    createLoop({ draw: () => draws++, schedule: clock.schedule, reducedMotion: true }).start();
    expect(draws).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("keeps drawing frame after frame otherwise", () => {
    const clock = manual();
    const seen: number[] = [];
    createLoop({ draw: (seconds) => seen.push(seconds), schedule: clock.schedule, reducedMotion: false }).start();
    clock.frame(1000);
    clock.frame(2500);
    expect(seen).toEqual([1, 2.5]);
  });

  it("stops drawing once stopped", () => {
    const clock = manual();
    let draws = 0;
    const loop = createLoop({ draw: () => draws++, schedule: clock.schedule, reducedMotion: false });
    loop.start();
    clock.frame(16);
    loop.stop();
    clock.frame(32);
    expect(draws).toBe(1);
  });
});

describe("the worlds", () => {
  it("come in the spec's order", () => {
    expect(WORLDS.map((world) => world.id)).toEqual(["cityOfTears", "landsBetween", "hell", "olympus", "frontier"]);
  });
});
