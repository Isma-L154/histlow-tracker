/**
 * The home page scene: how it scales and when it draws.
 *
 * Pixel art only stays crisp at a whole-number scale, and an animation that
 * keeps running off screen, or for a reader who asked for less motion, costs
 * battery for nothing. Both are decided by small pure pieces, tested here.
 */

import { describe, expect, it } from "vitest";
import { createLoop, pickScale } from "../public/world/engine.js";
import { SCENE_HEIGHT, WORLDS, shades } from "../public/world/scenes.js";

describe("pickScale", () => {
  it.each([
    [375, 700, { scale: 2, width: 188, height: 350 }],
    [320, 500, { scale: 2, width: 160, height: 250 }],
    [1200, 801, { scale: 4, width: 300, height: 201 }],
  ])("scales a %ipx by %ipx stage to %o", (containerWidth, containerHeight, expected) => {
    expect(pickScale(containerWidth, containerHeight)).toEqual(expected);
  });

  it("never scales past 4", () => {
    expect(pickScale(3000, 900).scale).toBe(4);
  });

  it("never draws a stage shorter than the scenes", () => {
    expect(pickScale(1200, 200).height).toBe(SCENE_HEIGHT);
  });

  it("covers the container in whole pixels at every size", () => {
    for (let containerWidth = 320; containerWidth <= 2560; containerWidth += 7) {
      for (const containerHeight of [300, 641, 900, 1440]) {
        const { scale, width, height } = pickScale(containerWidth, containerHeight);
        expect(Number.isInteger(scale)).toBe(true);
        expect(scale).toBeGreaterThanOrEqual(2);
        expect(scale).toBeLessThanOrEqual(4);
        expect(width * scale).toBeGreaterThanOrEqual(containerWidth);
        expect(height * scale).toBeGreaterThanOrEqual(containerHeight);
        expect(width).toBeGreaterThanOrEqual(160);
        expect(height).toBeGreaterThanOrEqual(SCENE_HEIGHT);
      }
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

describe("shades", () => {
  it("keeps a sky drawn at its own height exactly as drawn", () => {
    expect(shades(["#000000", "#ffffff"], 2)).toEqual(["#000000", "#ffffff"]);
  });

  it("shades a taller sky evenly from the first colour to the last", () => {
    expect(shades(["#000000", "#ffffff"], 5)).toEqual([
      "rgb(0, 0, 0)",
      "rgb(64, 64, 64)",
      "rgb(128, 128, 128)",
      "rgb(191, 191, 191)",
      "rgb(255, 255, 255)",
    ]);
  });

  it("passes through every given colour on the way", () => {
    expect(shades(["#ff0000", "#00ff00", "#0000ff"], 5)).toEqual([
      "rgb(255, 0, 0)",
      "rgb(128, 128, 0)",
      "rgb(0, 255, 0)",
      "rgb(0, 128, 128)",
      "rgb(0, 0, 255)",
    ]);
  });
});
