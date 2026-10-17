/**
 * The home page heroes, as data.
 *
 * Hand-drawn rows are easy to get subtly wrong: a row one character short
 * shears every row beneath it, and a letter missing from the palette draws as
 * a hole. Neither shows up until someone looks at the page.
 */

import { describe, expect, it } from "vitest";
import { HEROES, heroRows } from "../public/world/sprites.js";

describe("the heroes", () => {
  it("lists the five heroes in the spec's order", () => {
    expect(HEROES.map((hero) => hero.id)).toEqual(["sunKnight", "blackMage", "swordsman", "warrior", "cowboy"]);
  });

  it.each(HEROES.map((hero) => [hero.id, hero] as const))("draws every row of %s 16 pixels wide", (_id, hero) => {
    for (const frame of [0, 1] as const) {
      for (const row of heroRows(hero, frame)) expect(row).toHaveLength(16);
    }
  });

  it.each(HEROES.map((hero) => [hero.id, hero] as const))("defines every colour %s uses", (_id, hero) => {
    for (const frame of [0, 1] as const) {
      const used = new Set(heroRows(hero, frame).join("").replaceAll(".", ""));
      for (const key of used) expect(hero.palette, `colour "${key}"`).toHaveProperty(key);
    }
  });

  it.each(HEROES.map((hero) => [hero.id, hero] as const))("gives both walking frames of %s the same height", (_id, hero) => {
    expect(heroRows(hero, 0)).toHaveLength(heroRows(hero, 1).length);
  });
});
