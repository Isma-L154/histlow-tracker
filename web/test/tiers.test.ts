/**
 * Loot tiers: how the game page groups achievements by how many players hold them.
 *
 * The boundaries are the whole feature. An achievement held by exactly 5% is
 * epic, not legendary; get one comparison wrong and a section header lies.
 */

import { describe, expect, it } from "vitest";
import { VISIBLE_PER_TIER, groupByTier, heldCells, lockedIcon, lootTier } from "../public/tiers.js";

describe("lootTier", () => {
  it.each([
    [0, "legendary"],
    [4.99, "legendary"],
    [5, "epic"],
    [9.99, "epic"],
    [10, "rare"],
    [24.99, "rare"],
    [25, "uncommon"],
    [49.99, "uncommon"],
    [50, "common"],
    [100, "common"],
    [null, "unknown"],
  ] as const)("puts %s%% in %s", (percent, tier) => {
    expect(lootTier(percent)).toBe(tier);
  });
});

describe("groupByTier", () => {
  /** Deterministic pseudo-random source, so a failure can be re-run exactly. */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const random = generator(7);
  const items = Array.from({ length: 1000 }, (_, id) => ({
    id,
    globalPercent: random() < 0.05 ? null : Math.round(random() * 1000) / 10,
  }));
  const groups = groupByTier(items);

  it("keeps every achievement exactly once", () => {
    expect(groups.flatMap((group) => group.items.map((item) => item.id)).sort((a, b) => a - b)).toEqual(
      items.map((item) => item.id),
    );
  });

  it("orders the tiers from rarest to commonest, with no data last", () => {
    const order = ["legendary", "epic", "rare", "uncommon", "common", "unknown"];
    expect(groups.map((group) => group.tier)).toEqual(order.filter((tier) => groups.some((g) => g.tier === tier)));
  });

  it("keeps the input order inside each tier", () => {
    for (const group of groups) {
      const ids = group.items.map((item) => item.id);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    }
  });

  it("puts each achievement in its own tier", () => {
    for (const group of groups) for (const item of group.items) expect(lootTier(item.globalPercent)).toBe(group.tier);
  });

  it("leaves out a tier with nothing in it", () => {
    expect(groupByTier([{ globalPercent: 80 }]).map((group) => group.tier)).toEqual(["common"]);
  });
});

describe("heldCells", () => {
  it.each([
    [0.1, 1],
    [76.7, 15],
    [100, 20],
    [null, 0],
  ] as const)("fills %s%% as %i of 20 cells", (percent, cells) => {
    expect(heldCells(percent)).toBe(cells);
  });
});

describe("lockedIcon", () => {
  it("uses Steam's locked art when there is some", () => {
    expect(lockedIcon({ icon: "a", iconLocked: "b" })).toEqual({ src: "b", greyed: false });
  });

  it("greys the normal art when Steam sends no locked art", () => {
    expect(lockedIcon({ icon: "a", iconLocked: "" })).toEqual({ src: "a", greyed: true });
  });
});

describe("VISIBLE_PER_TIER", () => {
  it("shows the first five of each tier before the rest folds away", () => {
    expect(VISIBLE_PER_TIER).toBe(5);
  });
});
