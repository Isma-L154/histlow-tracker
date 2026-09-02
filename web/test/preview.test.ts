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
const PAGE = `${ORIGIN}/game/367520`;

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

/** The shipped shell, described as one game, as a plain string. */
function described(g: GameAchievements, html: string = shell): string {
  return describeGame(html, g, PAGE).html;
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
    expect(metas(described(game()), "og:image")).toHaveLength(1);
  });

  it("uses the game's cover art", () => {
    const [image] = metas(described(game()), "og:image");
    expect(image).toBe(game().headerImage);
  });

  it("corrects the image dimensions to the cover's", () => {
    // The default card is 1200x630; Steam's header art is 460x215. Leaving the
    // site's numbers behind describes an image that is not there.
    const out = described(game());
    expect(metas(out, "og:image:width")).toEqual(["460"]);
    expect(metas(out, "og:image:height")).toEqual(["215"]);
  });

  it("names the game in the image alt text", () => {
    const [alt] = metas(described(game()), "og:image:alt");
    expect(alt).toContain("Hollow Knight");
  });

  it("keeps the site's own card when the game has no cover art", () => {
    const out = described(game({ headerImage: null }));
    expect(metas(out, "og:image")).toEqual([`${ORIGIN}/og.png`]);
    expect(metas(out, "og:image:width")).toEqual(["1200"]);
    expect(metas(out, "og:image:height")).toEqual(["630"]);
  });

  it("asks for a wide card either way", () => {
    for (const cover of [game(), game({ headerImage: null })]) {
      expect(described(cover)).toContain('name="twitter:card" content="summary_large_image"');
    }
  });

  it("rewrites the title, the url and the canonical link", () => {
    const out = described(game());
    expect(metas(out, "og:title")).toEqual(["Hollow Knight — achievements and how to earn them"]);
    expect(metas(out, "og:url")).toEqual([`${ORIGIN}/game/367520`]);
    expect(out).toContain(`<link rel="canonical" href="${ORIGIN}/game/367520" />`);
  });

  it("escapes a hostile game name", () => {
    // Titles come from developers by way of Steam, so they are untrusted, and
    // this is the only place in the project that builds HTML by hand.
    const out = described(game({ name: '"><script>alert(1)</script>' }));
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  it.each(["$&", "$'", "$`", "$$"])("treats %s in a game name as text, not a replacement pattern", (hostile) => {
    // `String.replace` reads `$&`, `$'` and ``$` `` in the *replacement* as
    // instructions, and `attribute()` cannot help: it escapes the name before
    // the replacement is built, and its own `&amp;` supplies the ampersand
    // that turns a bare `$` into `$&`. A game called `$&` used to splice the
    // matched tag - angle brackets, quotes and all - inside an attribute
    // value, which is the exact escape `attribute()` exists to prevent.
    const out = described(game({ name: `Half-Life ${hostile}` }));

    for (const property of ["og:title", "og:image:alt"]) {
      const [value] = metas(out, property);
      expect(value, `${property} was corrupted`).not.toContain("<meta");
      expect(value).not.toContain("<");
    }
    // The name has to survive intact, not merely survive safely.
    expect(metas(out, "og:title")[0]).toContain("Half-Life");
  });

  it("rewrites the page title", () => {
    expect(/<title>([^<]*)<\/title>/.exec(described(game()))![1]).toContain("Hollow Knight");
  });

  it.each(['<meta name="description" content="([^"]*)"', '<meta property="og:description" content="([^"]*)"'])(
    "rewrites %s",
    (pattern) => {
      // Neither of these was asserted, and both are the drift-prone kind: the
      // shell's own og:description is already wrapped across four lines, so
      // one formatter run over the single-line one and every game page would
      // quietly describe the site instead of the game.
      const value = new RegExp(pattern).exec(described(game()))?.[1];
      expect(value).toContain("Hollow Knight");
    },
  );

  it("reports a tag it could not find instead of dropping it", () => {
    // A rewrite that matches nothing returns the input unchanged, with no
    // error. Wrapping a meta tag across lines is exactly the edit that does
    // it, and it is invisible in production.
    const wrapped = shell.replace(
      /<meta name="description" content="([^"]*)" \/>/,
      (_full, value) => `<meta
      name="description"
      content="${value}"
    />`,
    );
    const result = describeGame(wrapped, game(), PAGE);
    expect(result.missed).toContain('meta name="description"');
  });

  it("reports nothing missed against the shipped shell", () => {
    expect(describeGame(shell, game(), PAGE).missed).toEqual([]);
  });

  describe("when Steam could not describe the game", () => {
    it("still points the page at its own url", () => {
      // Serving the shell untouched left `canonical` and `og:url` claiming to
      // be the home page - on a crawlable path, cached for a day. That tells
      // a search engine every game page is a duplicate of the front page.
      const out = describeGame(shell, null, PAGE).html;
      expect(metas(out, "og:url")).toEqual([PAGE]);
      expect(out).toContain(`<link rel="canonical" href="${PAGE}" />`);
    });

    it("keeps the site's own card and wording", () => {
      const out = describeGame(shell, null, PAGE).html;
      expect(metas(out, "og:image")).toEqual([`${ORIGIN}/og.png`]);
      expect(metas(out, "og:title")[0]).toBe("Cazalogros — every Steam achievement, explained");
    });
  });

  it("leaves the page body alone", () => {
    // Only <head> is being rewritten. A pattern loose enough to reach the body
    // would take the brand link with it, and `app.js` looks that up by class.
    expect(described(game())).toContain('<a class="brand" href="/">');
  });
});
