/**
 * What a shared game link previews as.
 *
 * Run against the real shell rather than a fixture: `describeGame` rewrites
 * tags by matching their exact text, so a fixture that drifted from the
 * shipped file would keep passing while production quietly stopped being
 * rewritten at all.
 */

import { describe, expect, it } from "vitest";
import shell from "../public/index.html?raw";
import { describeGame } from "../src/preview.ts";
import type { GameAchievements } from "../src/steam.ts";

const ORIGIN = "https://cazalogros.cloudils.com";

function game(overrides: Partial<GameAchievements> = {}): GameAchievements {
  return {
    appId: 367520,
    name: "Hollow Knight",
    headerImage: "https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/367520/header.jpg",
    achievements: [],
    total: 63,
    unlockedCount: null,
    ...overrides,
  };
}

/** Every value of a repeated meta tag, in document order. */
function metas(html: string, property: string): string[] {
  const pattern = new RegExp(`<meta property="${property}" content="([^"]*)"`, "g");
  return [...html.matchAll(pattern)].map((match) => match[1]!);
}

describe("describeGame", () => {
  it("leaves exactly one og:image", () => {
    // The shell now ships a default card. Adding the game's cover alongside it
    // rather than in its place leaves the choice of which one wins to whichever
    // scraper is reading, and they do not agree.
    expect(metas(describeGame(shell, game(), ORIGIN), "og:image")).toHaveLength(1);
  });

  it("uses the game's cover art", () => {
    const [image] = metas(describeGame(shell, game(), ORIGIN), "og:image");
    expect(image).toBe(game().headerImage);
  });

  it("corrects the image dimensions to the cover's", () => {
    // The default card is 1200x630; Steam's header art is 460x215. Leaving the
    // site's numbers behind describes an image that is not there.
    const out = describeGame(shell, game(), ORIGIN);
    expect(metas(out, "og:image:width")).toEqual(["460"]);
    expect(metas(out, "og:image:height")).toEqual(["215"]);
  });

  it("names the game in the image alt text", () => {
    const [alt] = metas(describeGame(shell, game(), ORIGIN), "og:image:alt");
    expect(alt).toContain("Hollow Knight");
  });

  it("keeps the site's own card when the game has no cover art", () => {
    const out = describeGame(shell, game({ headerImage: null }), ORIGIN);
    expect(metas(out, "og:image")).toEqual([`${ORIGIN}/og.png`]);
    expect(metas(out, "og:image:width")).toEqual(["1200"]);
    expect(metas(out, "og:image:height")).toEqual(["630"]);
  });

  it("asks for a wide card either way", () => {
    for (const cover of [game(), game({ headerImage: null })]) {
      expect(describeGame(shell, cover, ORIGIN)).toContain('name="twitter:card" content="summary_large_image"');
    }
  });

  it("rewrites the title, the url and the canonical link", () => {
    const out = describeGame(shell, game(), ORIGIN);
    expect(metas(out, "og:title")).toEqual(["Hollow Knight — logros y cómo conseguirlos"]);
    expect(metas(out, "og:url")).toEqual([`${ORIGIN}/game/367520`]);
    expect(out).toContain(`<link rel="canonical" href="${ORIGIN}/game/367520" />`);
  });

  it("escapes a hostile game name", () => {
    // Titles come from developers by way of Steam, so they are untrusted, and
    // this is the only place in the project that builds HTML by hand.
    const out = describeGame(shell, game({ name: '"><script>alert(1)</script>' }), ORIGIN);
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  it("leaves the page body alone", () => {
    // Only <head> is being rewritten. A pattern loose enough to reach the body
    // would take the brand link with it, and `app.js` looks that up by class.
    expect(describeGame(shell, game(), ORIGIN)).toContain('<a class="brand" href="/">');
  });
});
