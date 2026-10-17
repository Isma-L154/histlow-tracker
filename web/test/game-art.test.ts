/**
 * The game page header: which art it tries, and which achievement it boasts about.
 *
 * Not every game has the large library art or a transparent logo on Steam's
 * CDN, so the banner needs a fallback that is always there.
 */

import { describe, expect, it } from "vitest";
import { bannerSources, rarestHeld } from "../public/art.js";

const BASE = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520";

describe("bannerSources", () => {
  it("tries the library art first, then the store header", () => {
    expect(bannerSources(367520, "https://example.com/header.jpg").hero).toEqual([
      `${BASE}/library_hero.jpg`,
      "https://example.com/header.jpg",
    ]);
  });

  it("tries only the library art when there is no header", () => {
    expect(bannerSources(367520, null).hero).toEqual([`${BASE}/library_hero.jpg`]);
  });

  it("points the logo at the game's transparent logo", () => {
    expect(bannerSources(367520, null).logo).toBe(`${BASE}/logo.png`);
  });
});

describe("rarestHeld", () => {
  const a = (name: string, globalPercent: number | null, unlocked: boolean | null) => ({ name, globalPercent, unlocked });

  it("picks the unlocked achievement the fewest players hold", () => {
    expect(rarestHeld([a("common", 70, true), a("rare", 6.6, true), a("missing", 3.9, false)])?.name).toBe("rare");
  });

  it("ignores one with no known share", () => {
    expect(rarestHeld([a("unknown", null, true), a("known", 40, true)])?.name).toBe("known");
  });

  it("has nothing to say when nothing is unlocked", () => {
    expect(rarestHeld([a("x", 10, false)])).toBeNull();
  });

  it("has nothing to say without a profile", () => {
    expect(rarestHeld([a("x", 10, null)])).toBeNull();
  });
});
