/**
 * The game's achievements, in the HTML as it leaves the Worker.
 *
 * Search engines render the page but may not fetch `/api/`, which robots.txt
 * keeps closed, so whatever the client would draw from it has to be there
 * already. Run against the shipped shell for the same reason as the preview
 * tests: a fixture would keep passing after the real markup drifted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import shell from "../public/index.html?raw";
import { serve } from "./serve.ts";
import { APP_ID, GAME_NAME, expectBuilt, stubSteam } from "./steam-stub.ts";
import { prerenderGame } from "../src/game-body.ts";
import type { Achievement, GameAchievements } from "../src/steam.ts";

function achievement(overrides: Partial<Achievement> = {}): Achievement {
  return {
    key: "a",
    name: "Falsehood",
    description: "Defeat the False Knight.",
    icon: "",
    iconLocked: "",
    globalPercent: 62.1,
    unlocked: null,
    unlockedAt: null,
    ...overrides,
  };
}

function game(achievements: Achievement[] = [achievement()]): GameAchievements {
  return { appId: 367520, name: "Hollow Knight", headerImage: null, achievements, total: achievements.length, unlockedCount: null };
}

function rendered(g: GameAchievements = game()): string {
  return prerenderGame(shell, g).html;
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h1\b[^>]*>([^<]*)<\/h1>/g)].map((match) => match[1]!);
}

describe("prerenderGame", () => {
  it("makes the game's name the page's only h1", () => {
    // The hero's logo is the h1 on the home page; left alone, a game page would
    // be headed "HowToAchieve" twice over.
    expect(headings(rendered())).toEqual(["Hollow Knight"]);
  });

  it("lists every achievement's name and description", () => {
    const html = rendered(game([
      achievement({ key: "a", name: "Falsehood", description: "Defeat the False Knight." }),
      achievement({ key: "b", name: "Mantis Lords", description: "Defeat the Mantis Lords.", globalPercent: 3.2 }),
    ]));
    for (const text of ["Falsehood", "Defeat the False Knight.", "Mantis Lords", "Defeat the Mantis Lords."]) {
      expect(html).toContain(text);
    }
  });

  it("starts the banner art downloading with the page", () => {
    // The banner is the largest paint on a game page; left to the client, it
    // waits for every module and for /api/game before it is even requested.
    const html = rendered();
    const art = /<img class="banner-art"[^>]*>/.exec(html)?.[0] ?? "";
    expect(art).toContain('src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/library_hero.jpg"');
    expect(art).toContain('fetchpriority="high"');
    expect(art).toContain('referrerpolicy="no-referrer"');
  });

  it("starts the logo downloading, still hidden until the client knows it exists", () => {
    const logo = /<img class="banner-logo"[^>]*>/.exec(rendered())?.[0] ?? "";
    expect(logo).toContain('src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/367520/logo.png"');
    expect(logo).toMatch(/\shidden\b/);
  });

  it("shows how many players hold each one", () => {
    expect(rendered()).toContain('<span class="held-value">62.1%</span>');
  });

  it("puts the rarest tier first", () => {
    const html = rendered(game([
      achievement({ key: "a", name: "Common one", globalPercent: 80 }),
      achievement({ key: "b", name: "Legendary one", globalPercent: 1 }),
    ]));
    expect(html.indexOf("Legendary one")).toBeLessThan(html.indexOf("Common one"));
    expect(html).toContain('data-i18n="rarity.legendary"');
  });

  it("says a hidden achievement is hidden rather than leaving it blank", () => {
    expect(rendered(game([achievement({ description: "" })]))).toContain('data-i18n="achievement.hidden"');
  });

  it("shows no figure where Steam publishes none", () => {
    expect(rendered(game([achievement({ globalPercent: null })]))).toContain('<span class="held-value">—</span>');
  });

  it("escapes what the game's developers wrote", () => {
    const html = rendered({
      ...game([achievement({ name: "<img src=x onerror=alert(1)>", description: "a & b" })]),
      name: "</h1><script>alert(1)</script>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("a &amp; b");
  });

  it("takes a $ in a name literally", () => {
    // A string replacement would read `$&` as "the match".
    expect(rendered({ ...game([achievement({ name: "Cash $& Prizes" })]), name: "Pay$&Day" }))
      .toContain("Cash $&amp; Prizes");
  });

  it("shows the game and hides the home scene before any script runs", () => {
    const html = rendered();
    expect(html).toMatch(/<section class="hero" id="hero" hidden>/);
    expect(html).toMatch(/<section class="game" id="game" data-prerendered="367520">/);
  });

  it("hides the tabs that need a profile", () => {
    expect(rendered().match(/class="tab needs-profile" hidden>/g)).toHaveLength(2);
  });

  it("fills in the total", () => {
    expect(rendered()).toContain('<dd id="game-total">1</dd>');
  });

  it("reports nothing missed against the shipped shell", () => {
    expect(prerenderGame(shell, game()).missed).toEqual([]);
  });
});

describe("the game page as served", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries the achievements and the game's name without any script", async () => {
    const steam = stubSteam();
    const html = await (await serve(new Request(`https://howtoachieve.cloudils.com/game/${APP_ID}`))).text();
    expectBuilt(steam, "the game page");
    expect(html).toContain(`<h1 class="banner-title" id="game-name">${GAME_NAME}</h1>`);
    expect(html).toContain('<span class="achievement-name">An achievement</span>');
    expect(html).toContain('"@type":"VideoGame"');
  });

  it("links the home page to the games", async () => {
    const html = await (await serve(new Request("https://howtoachieve.cloudils.com/"))).text();
    expect(html).toContain(`href="/game/${APP_ID}"`);
  });
});
