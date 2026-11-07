/**
 * A game's achievements drawn into the shell's body, with the markup `app.js`
 * draws, so a reader who never runs the client still sees them. Search engines
 * are such readers: they render the page, but robots.txt keeps them out of
 * `/api/`, where the client gets its data.
 *
 * Text is written in English with its `data-i18n` key; `localise()` translates
 * it afterwards, as it does the rest of the shell. The client redraws the
 * section with the reader's progress once its data arrives.
 */

import { groupByTier, heldCells, lootTier } from "../public/tiers.js";
import { t } from "../public/i18n.js";
import { bannerSources } from "../public/art.js";
import { escapeAttribute, escapeText, put, type Rewrite } from "./html.ts";
import type { Achievement, GameAchievements } from "./steam.ts";

function marked(tag: string, className: string, key: string): string {
  return `<${tag} class="${className}" data-i18n="${key}">${escapeText(t("en", key))}</${tag}>`;
}

function renderAchievement(achievement: Achievement): string {
  const tier = `rarity-${lootTier(achievement.globalPercent)}`;
  const description = achievement.description
    ? `<span class="achievement-description">${escapeText(achievement.description)}</span>`
    : marked("span", "achievement-description is-hidden", "achievement.hidden");
  const held = achievement.globalPercent === null ? "—" : `${achievement.globalPercent.toFixed(1)}%`;
  const filled = heldCells(achievement.globalPercent);
  const cells = Array.from({ length: 20 }, (_, i) => (i < filled ? '<i class="is-on"></i>' : "<i></i>")).join("");

  return (
    `<li class="achievement" data-unlocked="null"><div class="achievement-summary">` +
    `<span class="cursor" aria-hidden="true"></span><span class="slot ${tier}"></span>` +
    `<span class="achievement-text"><span class="achievement-name">${escapeText(achievement.name)}</span>${description}</span>` +
    `<span class="held ${tier}"><span class="held-label pixel-label">` +
    `<span data-i18n="rarity.heldBy">${escapeText(t("en", "rarity.heldBy"))}</span>` +
    `<span class="held-value">${held}</span></span>` +
    `<span class="cells" aria-hidden="true">${cells}</span></span>` +
    `</div></li>`
  );
}

function renderTiers(achievements: readonly Achievement[]): string {
  return groupByTier(achievements)
    .map(({ tier, items }) =>
      `<section class="tier rarity-${tier}" data-tier="${tier}">` +
      `<h3 class="tier-head"><span class="tier-gem" aria-hidden="true"></span>` +
      marked("span", "tier-name", `rarity.${tier}`) +
      marked("span", "tier-range", `rarity.range.${tier}`) +
      `<span class="tier-count">${items.length}</span></h3>` +
      `<ol class="achievements">${items.map(renderAchievement).join("")}</ol>` +
      `</section>`)
    .join("");
}

export function prerenderGame(html: string, game: GameAchievements): Rewrite {
  const out: Rewrite = { html, missed: [] };

  // The game section is shown and the home scene hidden, as the client would.
  // `data-prerendered` tells the client not to blank the section while it loads.
  put(out, "hero", /<section class="hero" id="hero">/, `<section class="hero" id="hero" hidden>`);
  put(out, "game", /<section class="game" id="game" hidden>/,
    `<section class="game" id="game" data-prerendered="${game.appId}">`);

  // The banner is the largest paint, so it downloads with the page rather than
  // after the client's modules and data. The client sets the same addresses and
  // its fallbacks still run: reassigning a finished image fires load or error again.
  const { hero, logo } = bannerSources(game.appId, null);
  put(out, "banner art", /<img class="banner-art" id="banner-art"/,
    `<img class="banner-art" id="banner-art" src="${escapeAttribute(hero[0]!)}" fetchpriority="high"`);
  put(out, "banner logo", /<img class="banner-logo" id="banner-logo"/,
    `<img class="banner-logo" id="banner-logo" src="${escapeAttribute(logo)}"`);

  // One h1 per page, and here it is the game. The logo keeps its class, so it looks the same.
  put(out, "logo", /<h1 class="logo">HowToAchieve<\/h1>/, `<p class="logo">HowToAchieve</p>`);
  put(out, "game name", /<h2 class="banner-title" id="game-name"><\/h2>/,
    `<h1 class="banner-title" id="game-name">${escapeText(game.name)}</h1>`);

  // Missing and unlocked only mean something once the reader's progress is known.
  put(out, "profile tabs", /class="tab needs-profile"/g, 'class="tab needs-profile" hidden');
  put(out, "total", /<dd id="game-total"><\/dd>/, `<dd id="game-total">${game.total}</dd>`);
  put(out, "achievements", /<div class="tiers" id="achievements"><\/div>/,
    `<div class="tiers" id="achievements">${renderTiers(game.achievements)}</div>`);

  return out;
}
