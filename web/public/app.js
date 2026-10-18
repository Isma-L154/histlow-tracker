/**
 * HowToAchieve's client. No framework and no build step.
 *
 * Nothing from the API is ever inserted as HTML: achievement names and
 * descriptions are written by game developers, so they only reach the page as text.
 */

import { handledInPage } from "./nav.js";
import { DICTIONARY, pickLanguage, t, translate } from "./i18n.js";
import { completionDifficulty } from "./difficulty.js";
import { mountWorld } from "./world/engine.js";
import { VISIBLE_PER_TIER, groupByTier, heldCells, lockedIcon, lootTier } from "./tiers.js";
import { HEROES, drawSprite } from "./world/sprites.js";
import { bannerSources, rarestHeld } from "./art.js";

const SITE_TITLE = "HowToAchieve";
const STORAGE_KEY = "histlow.steamid";
const NAME_KEY = "histlow.profileName";
/** Steam caps a display name at 32 characters; anything longer did not come from Steam. */
const NAME_MAX = 64;
const LANGUAGE_KEY = "histlow.language";
const SEARCH_DEBOUNCE_MS = 250;
const MAX_RESULTS = 12;

const GUIDES_BASE = "https://steamcommunity.com/app";

const el = {
  brand: document.querySelector(".brand"),
  language: document.querySelector(".language"),
  form: document.getElementById("search-form"),
  search: document.getElementById("search-input"),
  results: document.getElementById("results"),
  profile: document.getElementById("profile"),
  profileAnon: document.getElementById("profile-anon"),
  profilePlayer: document.getElementById("profile-player"),
  profileName: document.getElementById("profile-name"),
  steamId: document.getElementById("steamid-input"),
  steamIdSave: document.getElementById("steamid-save"),
  steamIdClear: document.getElementById("steamid-clear"),
  profileStatus: document.getElementById("profile-status"),
  hero: document.getElementById("hero"),
  heroSearch: document.getElementById("hero-search"),
  world: document.getElementById("world"),
  worldDots: document.getElementById("world-dots"),
  status: document.getElementById("status"),
  game: document.getElementById("game"),
  banner: document.getElementById("banner"),
  bannerArt: document.getElementById("banner-art"),
  bannerLogo: document.getElementById("banner-logo"),
  name: document.getElementById("game-name"),
  total: document.getElementById("game-total"),
  progressKnown: document.getElementById("progress-known"),
  progressText: document.getElementById("progress-text"),
  progressPercent: document.getElementById("progress-percent"),
  progressCells: document.getElementById("progress-cells"),
  progressRarest: document.getElementById("progress-rarest"),
  progressNotice: document.getElementById("progress-notice"),
  progressInvite: document.getElementById("progress-invite"),
  difficulty: document.getElementById("difficulty"),
  difficultySkulls: document.getElementById("difficulty-skulls"),
  completionTime: document.getElementById("completion-time"),
  completionHours: document.getElementById("completion-hours"),
  difficultyScore: document.getElementById("difficulty-score"),
  difficultyTier: document.getElementById("difficulty-tier"),
  links: document.getElementById("game-links"),
  filters: document.getElementById("filters"),
  countAll: document.getElementById("count-all"),
  countMissing: document.getElementById("count-missing"),
  countUnlocked: document.getElementById("count-unlocked"),
  visibleCount: document.getElementById("visible-count"),
  list: document.getElementById("achievements"),
};

const state = {
  // The Worker already decided this and wrote it into `lang`.
  language: pickLanguage("", document.documentElement.lang),
  steamId: readStoredSteamId(),
  profileName: readStoredName(),
  game: null,
  filter: "all",
};

/** In-flight requests, aborted when a newer one supersedes them. */
let searchRequest = null;
let gameRequest = null;
let searchTimer = null;

// -- api --------------------------------------------------------------------

/** Wording by status, for an error that carries no translatable `reason`. */
const ERROR_KEYS = { 400: "error.400", 404: "error.404", 502: "error.502", 503: "error.503" };

async function api(path, signal) {
  let response;
  try {
    response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(say("error.offline"));
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Falls through to the generic message below.
  }
  if (!response.ok) {
    // A `reason` is specific, so it wins; the status table is written about games.
    const key = body?.reason && DICTIONARY.en[body.reason] ? body.reason : ERROR_KEYS[response.status];
    throw new Error(key ? say(key) : (body?.error ?? say("error.api", { status: response.status })));
  }
  return body;
}

// -- search -----------------------------------------------------------------

el.search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const query = el.search.value.trim();
  if (query.length < 2) {
    hideResults();
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
});

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  const query = el.search.value.trim();
  if (query.length >= 2) runSearch(query);
});

async function runSearch(query) {
  searchRequest?.abort();
  searchRequest = new AbortController();
  try {
    const body = await api(`/api/search?q=${encodeURIComponent(query)}`, searchRequest.signal);
    renderResults(body.results ?? []);
  } catch (error) {
    if (error.name === "AbortError") return;
    hideResults();
    showError(error.message);
  }
}

function renderResults(results) {
  el.results.replaceChildren();
  if (results.length === 0) {
    hideResults();
    setStatus(say("status.noMatch"));
    return;
  }

  for (const result of results.slice(0, MAX_RESULTS)) {
    const button = document.createElement("button");
    button.type = "button";

    const thumbnail = artwork(result.icon);
    if (thumbnail) {
      const icon = document.createElement("img");
      icon.src = thumbnail;
      icon.alt = "";
      icon.loading = "lazy";
      icon.referrerPolicy = "no-referrer";
      button.append(icon);
    }

    const label = document.createElement("span");
    label.textContent = result.name;
    button.append(label);

    button.addEventListener("click", () => {
      hideResults();
      el.search.value = result.name;
      goToGame(result.appId);
    });

    const item = document.createElement("li");
    item.append(button);
    el.results.append(item);
  }
  el.results.hidden = false;
}

function hideResults() {
  el.results.hidden = true;
  el.results.replaceChildren();
}

document.addEventListener("click", (event) => {
  if (!el.form.contains(event.target)) hideResults();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideResults();
});

// -- game -------------------------------------------------------------------

async function loadGame(appId) {
  gameRequest?.abort();
  gameRequest = new AbortController();

  setStatus(say("status.loading"));
  el.game.hidden = true;
  showHero(false);

  const query = state.steamId ? `?steamid=${encodeURIComponent(state.steamId)}` : "";
  try {
    const game = await api(`/api/game/${appId}${query}`, gameRequest.signal);
    state.game = game;
    state.filter = "all";
    renderGame(game);
    setStatus("");
  } catch (error) {
    if (error.name === "AbortError") return;
    state.game = null;
    showError(error.message);
  }
}

function renderGame(game) {
  el.name.textContent = game.name;
  document.title = `${game.name} · ${SITE_TITLE}`;
  el.total.textContent = String(game.total);

  renderBanner(game);
  renderProgress(game);
  renderDifficulty(game);
  renderLinks(game);
  renderCompletionTime(game.appId);

  // Missing and unlocked only mean something once we know what the player already has.
  for (const tab of el.filters.querySelectorAll(".needs-profile")) tab.hidden = game.unlockedCount === null;
  setActiveChip("all");

  el.countAll.textContent = String(game.total);
  el.countMissing.textContent = String(game.achievements.filter((a) => a.unlocked === false).length);
  el.countUnlocked.textContent = String(game.achievements.filter((a) => a.unlocked === true).length);

  el.list.replaceChildren(...groupByTier(game.achievements).map((group) => renderTier(game.appId, group)));
  applyFilter();

  el.game.hidden = false;
}

/**
 * Steam's large art behind the game's own transparent logo. Not every game has
 * either: the art falls back to the store header, and without a logo the
 * heading shows the name instead.
 */
function renderBanner(game) {
  const { hero, logo } = bannerSources(game.appId, artwork(game.headerImage));
  const queue = [...hero];

  el.bannerArt.hidden = false;
  el.bannerArt.onerror = () => {
    const next = queue.shift();
    if (next) el.bannerArt.src = next;
    else el.bannerArt.hidden = true;
  };
  el.bannerArt.src = queue.shift();

  el.banner.classList.remove("has-logo");
  el.bannerLogo.hidden = true;
  el.bannerLogo.onload = () => {
    el.bannerLogo.hidden = false;
    el.banner.classList.add("has-logo");
  };
  el.bannerLogo.onerror = () => el.bannerLogo.removeAttribute("src");
  el.bannerLogo.src = logo;
}

/** The player's progress, a notice when it could not be read, or an invitation to save a profile. */
function renderProgress(game) {
  const known = game.unlockedCount !== null;
  el.progressKnown.hidden = !known;

  // Asked for progress and got none: say so, or an unowned game looks like a broken SteamID.
  const unexplained = state.steamId !== null && !known;
  el.progressNotice.hidden = !unexplained;
  el.progressNotice.textContent = unexplained ? say("game.noProgress") : "";
  el.progressInvite.hidden = known || unexplained;

  if (!known) {
    el.visibleCount.textContent = say("game.count", { total: game.total });
    return;
  }

  const percent = game.total > 0 ? Math.round((game.unlockedCount / game.total) * 100) : 0;
  el.progressText.textContent = `${game.unlockedCount} / ${game.total}`;
  el.progressPercent.textContent = say("progress.percent", { percent });

  // One cell per achievement, up to a hundred, so a bar stays readable on a long list.
  const cells = Math.min(Math.max(game.total, 1), 100);
  const filled = game.total > 0 ? Math.round((game.unlockedCount / game.total) * cells) : 0;
  el.progressCells.style.setProperty("--cells", String(cells));
  el.progressCells.replaceChildren(
    ...Array.from({ length: cells }, (_, i) => {
      const cell = document.createElement("i");
      if (i < filled) cell.className = "is-on";
      return cell;
    }),
  );

  const best = rarestHeld(game.achievements);
  el.progressRarest.hidden = best === null;
  if (best) {
    el.progressRarest.textContent = say("progress.rarest", { name: best.name, percent: best.globalPercent.toFixed(1) });
  }
}

/** A pixel skull, inline because the CSP allows no image file the page did not ship. */
function skull(lit) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 7 7");
  svg.setAttribute("shape-rendering", "crispEdges");
  if (!lit) svg.classList.add("is-off");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  // Crown, cheeks and jaw, with the eyes and teeth left as holes.
  path.setAttribute("d", "M1 0h5v1H1zM0 1h7v1H0zM0 2h1v1H0zM3 2h1v1H3zM6 2h1v1H6zM0 3h7v1H0zM1 4h5v1H1zM1 5h1v1H1zM3 5h1v1H3zM5 5h1v1H5z");
  svg.append(path);
  return svg;
}

/** How hard the game is to finish, or nothing when there is too little to read. */
function renderDifficulty(game) {
  const difficulty = completionDifficulty(game.achievements.map((a) => a.globalPercent));
  el.difficulty.hidden = difficulty === null;
  if (!difficulty) return;

  el.difficulty.dataset.tier = difficulty.tier;
  el.difficultySkulls.replaceChildren(...Array.from({ length: 10 }, (_, i) => skull(i < difficulty.score)));
  el.difficultyScore.textContent = say("difficulty.score", { score: difficulty.score });
  el.difficultyTier.textContent = say(`difficulty.${difficulty.tier}`);
  // A rarity reading, not a community verdict, and the tooltip says so.
  el.difficulty.title = say("difficulty.basis");
}

/**
 * Roughly how long the game takes, when IGDB knows. Fetched apart, so a slow
 * IGDB never holds up the list; a failure is logged by the Worker, not shown.
 */
async function renderCompletionTime(appId) {
  el.completionTime.hidden = true;
  const requested = appId;

  let data;
  try {
    data = await api(`/api/time/${appId}`);
  } catch {
    return;
  }

  // The reader may have moved on to another game while this was in flight.
  if (state.game?.appId !== requested) return;

  const seconds = data?.completionTime?.completely ?? data?.completionTime?.normally;
  if (!seconds) return;

  // "About 0 hours" would read as a bug rather than as a short game.
  const hours = Math.round(seconds / 3600);
  el.completionHours.textContent = hours < 1 ? say("time.underAnHour") : say("time.hours", { hours });
  el.completionTime.title = say("time.source");
  el.completionTime.hidden = false;
}

function renderLinks(game) {
  el.links.replaceChildren();
  const targets = [
    [say("game.guides"), `${GUIDES_BASE}/${game.appId}/guides/?browsefilter=toprated&requiredtags%5B%5D=Achievements&l=english`],
    [say("game.store"), `https://store.steampowered.com/app/${game.appId}/`],
  ];
  for (const [label, href] of targets) {
    const anchor = link(label, href);
    anchor.className = "steam-link";
    el.links.append(anchor);
  }
}

/** One loot tier: its header, its achievements, and a button for the ones folded away. */
function renderTier(appId, group) {
  const section = document.createElement("section");
  section.className = `tier rarity-${group.tier}`;
  section.dataset.tier = group.tier;

  const head = document.createElement("h3");
  head.className = "tier-head";
  const gem = document.createElement("span");
  gem.className = "tier-gem";
  gem.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "tier-name";
  name.textContent = say(`rarity.${group.tier}`);
  const range = document.createElement("span");
  range.className = "tier-range";
  range.textContent = say(`rarity.range.${group.tier}`);
  const count = document.createElement("span");
  count.className = "tier-count";
  head.append(gem, name, range, count);

  const list = document.createElement("ol");
  list.className = "achievements";
  list.append(...group.items.map((achievement) => renderAchievement(appId, achievement)));

  const more = document.createElement("button");
  more.type = "button";
  more.className = "tier-more";
  more.addEventListener("click", () => {
    section.dataset.expanded = "true";
    applyFilter();
  });

  section.append(head, list, more);
  return section;
}

function renderAchievement(appId, achievement) {
  const item = document.createElement("li");
  item.className = "achievement";
  // `unlocked` is null when no player was resolved, so the row claims nothing.
  if (achievement.unlocked === true) item.classList.add("is-unlocked");
  if (achievement.unlocked === false) item.classList.add("is-locked");
  item.dataset.unlocked = String(achievement.unlocked);

  const tier = rarityTier(achievement.globalPercent);

  // The whole row is the control, which keeps a long game to a few screens.
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "achievement-summary";
  summary.setAttribute("aria-expanded", "false");

  const cursor = document.createElement("span");
  cursor.className = "cursor";
  cursor.setAttribute("aria-hidden", "true");

  const slot = document.createElement("span");
  slot.className = `slot ${tier.className}`;
  const art = achievement.unlocked === false ? lockedIcon(achievement) : { src: achievement.icon, greyed: false };
  if (art.greyed) slot.classList.add("is-greyed");
  const icon = document.createElement("img");
  icon.className = "achievement-icon";
  const source = artwork(art.src);
  if (source) icon.src = source;
  icon.alt = "";
  icon.loading = "lazy";
  icon.referrerPolicy = "no-referrer";
  // Some art is no longer served, and an empty slot beats a broken-image box.
  icon.addEventListener("error", () => icon.removeAttribute("src"), { once: true });
  slot.append(icon);

  const text = document.createElement("span");
  text.className = "achievement-text";
  const name = document.createElement("span");
  name.className = "achievement-name";
  name.textContent = achievement.name;
  const description = document.createElement("span");
  description.className = "achievement-description";
  // Hidden achievements come back with an empty description from Steam.
  description.textContent = achievement.description || say("achievement.hidden");
  if (!achievement.description) description.classList.add("is-hidden");
  text.append(name, description);

  summary.append(cursor, slot, text);

  if (achievement.unlocked !== null) {
    const status = document.createElement("span");
    status.className = "achievement-state";
    status.textContent = say(achievement.unlocked ? "achievement.state.unlocked" : "achievement.state.locked");
    if (achievement.unlocked && achievement.unlockedAt) {
      const when = document.createElement("small");
      when.textContent = formatDate(achievement.unlockedAt);
      status.append(when);
    }
    summary.append(status);
  }

  summary.append(heldMeter(achievement.globalPercent, tier));

  const detail = document.createElement("div");
  detail.className = "achievement-detail";
  detail.hidden = true;

  // An RPG dialogue: the black mage from the home page narrates the steps.
  const panel = document.createElement("div");
  panel.className = "howto window";
  panel.hidden = true;
  const speech = document.createElement("div");
  speech.className = "howto-speech";
  const speaker = document.createElement("p");
  speaker.className = "howto-speaker pixel-label";
  speaker.textContent = say("howto.narrator");
  const body = document.createElement("div");
  body.className = "howto-body";
  speech.append(speaker, body);
  panel.append(narratorPortrait(), speech);

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "howto-button";
  reveal.textContent = say("achievement.reveal");
  reveal.setAttribute("aria-expanded", "false");
  reveal.addEventListener("click", () => toggleHowTo(reveal, panel, body, appId, achievement));

  // A model call, so it stays a deliberate second action.
  detail.append(reveal, panel);

  summary.addEventListener("click", () => {
    const open = summary.getAttribute("aria-expanded") === "true";
    summary.setAttribute("aria-expanded", String(!open));
    detail.hidden = open;
  });

  item.append(summary, detail);
  return item;
}

/**
 * How many players hold it, as a figure and a 20-cell bar. The bar is
 * decorative: the percentage carries the same value, so colour is never the only signal.
 */
function heldMeter(percent, tier) {
  const wrap = document.createElement("span");
  wrap.className = `held ${tier.className}`;

  const label = document.createElement("span");
  label.className = "held-label pixel-label";
  const caption = document.createElement("span");
  caption.textContent = say("rarity.heldBy");
  const value = document.createElement("span");
  value.className = "held-value";
  value.textContent = percent === null ? "—" : `${percent.toFixed(1)}%`;
  value.title = `${tier.label}${percent === null ? "" : ` · ${say("rarity.players", { percent: percent.toFixed(1) })}`}`;
  label.append(caption, value);

  const cells = document.createElement("span");
  cells.className = "cells";
  cells.setAttribute("aria-hidden", "true");
  const filled = heldCells(percent);
  cells.append(
    ...Array.from({ length: 20 }, (_, i) => {
      const cell = document.createElement("i");
      if (i < filled) cell.className = "is-on";
      return cell;
    }),
  );

  wrap.append(label, cells);
  return wrap;
}

/** The black mage's head and shoulders, drawn at its own 16 pixels and scaled up by CSS. */
function narratorPortrait() {
  const canvas = document.createElement("canvas");
  canvas.className = "narrator";
  canvas.width = 16;
  canvas.height = 16;
  canvas.setAttribute("aria-hidden", "true");
  const mage = HEROES[1];
  drawSprite(canvas.getContext("2d"), mage.body, mage.palette, 0, 0);
  return canvas;
}

// -- how an achievement is earned -------------------------------------------

async function toggleHowTo(button, panel, body, appId, achievement) {
  const open = button.getAttribute("aria-expanded") === "true";
  if (open) {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    return;
  }

  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  if (panel.dataset.loaded === "true") return;

  body.replaceChildren(note(say("howto.searching")));

  try {
    const data = await api(`/api/howto/${appId}/${encodeURIComponent(achievement.key)}`);
    panel.dataset.loaded = "true";
    renderHowTo(body, data, appId, achievement);
  } catch (error) {
    if (error.name === "AbortError") return;
    // Not marked as loaded, so reopening retries what was usually a transient failure.
    body.replaceChildren(note(error.message));
  }
}

function renderHowTo(body, data, appId, achievement) {
  body.replaceChildren();

  if (!data.answered) {
    body.append(
      note(
        data.passages.length > 0
          ? say("howto.notExplained")
          : say("howto.noneExplain", { count: data.guidesSearched }),
      ),
      searchLink(appId, achievement.name),
    );
    return;
  }

  body.append(renderSteps(data.steps));

  if (data.passages.length > 0) {
    const sources = document.createElement("p");
    sources.className = "howto-sources";
    sources.append(document.createTextNode(say("howto.sources")));
    // Several passages can come from one guide; each guide is credited once.
    const seen = new Set();
    for (const passage of data.passages) {
      if (seen.has(passage.guideId)) continue;
      seen.add(passage.guideId);
      if (seen.size > 1) sources.append(document.createTextNode(" · "));
      sources.append(link(`${passage.guideTitle} — ${passage.author}`, passage.guideUrl));
    }
    body.append(sources);
  }

  const disclaimer = document.createElement("p");
  disclaimer.className = "howto-disclaimer";
  disclaimer.textContent =
    say("howto.disclaimer");
  body.append(disclaimer);
}

/** The model's lead sentence and dashed steps; anything else becomes a paragraph. */
function renderSteps(text) {
  const fragment = document.createDocumentFragment();
  let list = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = document.createElement("ol");
        list.className = "howto-steps";
        fragment.append(list);
      }
      const item = document.createElement("li");
      item.textContent = bullet[1];
      list.append(item);
      continue;
    }

    list = null;
    const paragraph = document.createElement("p");
    paragraph.className = "howto-lead";
    paragraph.textContent = line;
    fragment.append(paragraph);
  }

  return fragment;
}

/** The escape hatch when we have no answer: search Steam for it by hand. */
function searchLink(appId, achievementName) {
  const anchor = link(
    say("howto.searchSteam"),
    `${GUIDES_BASE}/${appId}/guides/?searchText=${encodeURIComponent(achievementName)}` +
      "&browsefilter=toprated&l=english",
  );
  anchor.className = "steam-link";
  return anchor;
}

function note(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "howto-note";
  paragraph.textContent = message;
  return paragraph;
}

/** The loot tier of a share of players, named in the reader's language. */
function rarityTier(percent) {
  const tier = lootTier(percent);
  return { tier, label: say(`rarity.${tier}`), className: `rarity-${tier}` };
}

/** Publishes the top bar's height, which wraps on narrow screens, so the toolbar can stick beneath it. */
function trackTopbarHeight() {
  const bar = document.querySelector(".topbar");
  if (!bar) return;
  const publish = () => {
    document.documentElement.style.setProperty("--topbar-height", `${bar.offsetHeight}px`);
  };
  publish();
  if ("ResizeObserver" in window) new ResizeObserver(publish).observe(bar);
  else window.addEventListener("resize", publish);
}

trackTopbarHeight();

// -- filtering --------------------------------------------------------------

el.filters.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]");
  if (!chip) return;
  state.filter = chip.dataset.filter;
  setActiveChip(state.filter);
  applyFilter();
});

function matchesFilter(unlocked) {
  return (
    state.filter === "all" ||
    (state.filter === "unlocked" && unlocked === "true") ||
    (state.filter === "missing" && unlocked === "false")
  );
}

function setActiveChip(filter) {
  for (const chip of el.filters.querySelectorAll("[data-filter]")) {
    chip.classList.toggle("is-active", chip.dataset.filter === filter);
  }
}

function applyFilter() {
  let visible = 0;
  for (const section of el.list.children) {
    const items = [...section.querySelectorAll(".achievement")];
    const matching = items.filter((item) => matchesFilter(item.dataset.unlocked));
    const expanded = section.dataset.expanded === "true";
    for (const item of items) item.hidden = true;
    matching.forEach((item, i) => {
      item.hidden = !expanded && i >= VISIBLE_PER_TIER;
    });

    const folded = expanded ? 0 : Math.max(0, matching.length - VISIBLE_PER_TIER);
    section.hidden = matching.length === 0;
    section.querySelector(".tier-count").textContent = String(matching.length);
    const more = section.querySelector(".tier-more");
    more.hidden = folded === 0;
    more.textContent = say("tier.more", { count: folded });
    visible += matching.length;
  }

  const total = state.game?.total ?? 0;
  el.visibleCount.textContent =
    visible === total
      ? say("game.count", { total })
      : say("game.countFiltered", { visible, total });
}

// -- profile ----------------------------------------------------------------

el.steamIdSave.addEventListener("click", async () => {
  const typed = el.steamId.value.trim();
  if (typed === "") return;

  setProfileStatus(say("profile.looking"));
  el.steamIdSave.disabled = true;

  let resolved;
  try {
    // The Worker resolves it with the Steam key, so the id is known to exist.
    resolved = await api(`/api/steamid?q=${encodeURIComponent(typed)}`);
  } catch (error) {
    // The Worker's message says which way the input was wrong.
    setProfileStatus(error.message, true);
    return;
  } finally {
    el.steamIdSave.disabled = false;
  }

  // An unexpected 200 body would otherwise leave the status stuck on "Looking up…".
  if (!resolved?.steamId) {
    setProfileStatus(say("profile.default"), true);
    return;
  }

  state.steamId = resolved.steamId;
  store(STORAGE_KEY, resolved.steamId);
  state.profileName = resolved.profileName ? String(resolved.profileName).slice(0, NAME_MAX) : null;
  store(NAME_KEY, state.profileName);
  renderProfileLabel();
  // Name who was found: seventeen digits tell the reader nothing they can check.
  setProfileStatus(
    resolved.profileName
      ? say("profile.found", { name: resolved.profileName })
      : say("profile.foundNameless"),
  );
  // Left open, so the reader sees who was found.
  if (state.game) loadGame(state.game.appId);
});

el.steamIdClear.addEventListener("click", () => {
  state.steamId = null;
  state.profileName = null;
  el.steamId.value = "";
  store(STORAGE_KEY, null);
  store(NAME_KEY, null);
  renderProfileLabel();
  setProfileStatus(say("profile.removed"));
  if (state.game) loadGame(state.game.appId);
});

// A <details> closes only from its own summary; a click anywhere else should close it too.
document.addEventListener("click", (event) => {
  if (!el.profile.contains(event.target)) el.profile.open = false;
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !el.profile.open) return;
  // Focus left on a field that just closed would strand a keyboard user.
  const hadFocus = el.profile.contains(document.activeElement);
  el.profile.open = false;
  if (hadFocus) el.profile.querySelector("summary").focus();
});

function readStoredSteamId() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && /^\d{17}$/.test(value) ? value : null;
  } catch {
    // Private browsing, or storage disabled. The page works without it.
    return null;
  }
}

/** The display name saved with the profile, or null; only meaningful while an id is stored. */
function readStoredName() {
  try {
    const value = localStorage.getItem(NAME_KEY)?.trim();
    return value ? value.slice(0, NAME_MAX) : null;
  } catch {
    return null;
  }
}

/** The top bar names the player when it can, says PLAYER when it only has the id, and PROFILE otherwise. */
function renderProfileLabel() {
  const named = state.steamId !== null && state.profileName !== null;
  el.profileAnon.hidden = state.steamId !== null;
  el.profilePlayer.hidden = state.steamId === null || named;
  el.profileName.hidden = !named;
  el.profileName.textContent = named ? state.profileName : "";
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    setProfileStatus(say("profile.noStorage"), true);
  }
}

function setProfileStatus(message, isError = false) {
  el.profileStatus.textContent = message;
  el.profileStatus.classList.toggle("is-error", isError);
}

// -- shared helpers ---------------------------------------------------------

/** One interface string, in the language showing at the moment of use. */
function say(key, values) {
  return t(state.language, key, values);
}

/** Switches language in place, keeping the game, the open panels and the scroll position. */
function setLanguage(language) {
  if (!(language in DICTIONARY) || language === state.language) return;

  state.language = language;
  document.documentElement.lang = language;
  translate(document, language);
  markLanguage();

  // What the client drew itself carries no `data-i18n`, so it is redrawn.
  if (state.game) renderGame(state.game);
  if (state.steamId) setProfileStatus(say("profile.saved"));

  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // No storage: the choice lasts for this visit.
  }
}

/** Tells both buttons, and a screen reader, which language is showing. */
function markLanguage() {
  for (const button of el.language.querySelectorAll("[data-language]")) {
    button.setAttribute("aria-pressed", String(button.dataset.language === state.language));
  }
}

function setStatus(message) {
  el.status.textContent = message;
  el.status.classList.remove("is-error");
  el.status.hidden = message === "";
}

function showError(message) {
  el.status.textContent = message;
  el.status.classList.add("is-error");
  el.status.hidden = false;
  el.game.hidden = true;
  // The hero gives a dead link somewhere to go.
  showHero(true);
}

function link(text, href) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = text;
  anchor.target = "_blank";
  // Steam is a third party: deny it both the opener handle and the referrer.
  anchor.rel = "noopener noreferrer";
  return anchor;
}

/**
 * A usable image URL, or null. Old schemas hand out `http://`, which would be
 * blocked as mixed content, and an empty icon field leaves a URL with no file.
 */
function artwork(url) {
  if (typeof url !== "string" || url === "") return null;
  const secure = url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
  return /\/[^/?#]+\.[a-z]{3,4}(?:[?#]|$)/i.test(secure) ? secure : null;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? say("achievement.unlocked")
    : date.toLocaleDateString(state.language, { year: "numeric", month: "short", day: "numeric" });
}

// -- routing ----------------------------------------------------------------

/** Where the search form sits in the top bar, so it can go back after the home page borrows it. */
const searchHome = { parent: el.form.parentElement, next: el.form.nextElementSibling };

/**
 * Shows or hides the home scene. The one search form moves with it: over the
 * scene on the home page, in the top bar everywhere else. Moving the node keeps
 * its listeners and whatever the reader has typed.
 */
function showHero(visible) {
  el.hero.hidden = !visible;
  document.body.classList.toggle("is-home", visible);
  if (visible) el.heroSearch.append(el.form);
  else searchHome.parent.insertBefore(el.form, searchHome.next);
}

/** Goes to a game in place. A real path, not a fragment, so the server can describe it when shared. */
function goToGame(appId) {
  history.pushState({ appId }, "", `/game/${appId}`);
  route();
}

/** Back to the home page, without stacking history entries when already there. */
function goHome() {
  if (location.pathname !== "/") history.pushState({}, "", "/");
  // A real navigation would scroll to the top, so this does too.
  scrollTo(0, 0);
  route();
}

function route() {
  // Links shared before the move arrive as #/game/123; rewrite them to the real path.
  const legacy = /^#\/game\/(\d{1,10})$/.exec(location.hash);
  if (legacy) {
    history.replaceState({ appId: Number(legacy[1]) }, "", `/game/${legacy[1]}`);
  }

  const match = /^\/game\/(\d{1,10})$/.exec(location.pathname);
  if (match) {
    loadGame(Number(match[1]));
    return;
  }
  state.game = null;
  el.game.hidden = true;
  showHero(true);
  document.title = SITE_TITLE;
  setStatus("");
}

window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

el.hero.addEventListener("click", (event) => {
  const example = event.target.closest("[data-appid]");
  if (example) goToGame(Number(example.dataset.appid));
});

el.language.addEventListener("click", (event) => {
  const button = event.target.closest("[data-language]");
  if (button) setLanguage(button.dataset.language);
});

// A real link to "/", so a modified click still opens a tab; a plain one is routed in place.
el.brand.addEventListener("click", (event) => {
  if (!handledInPage(event)) return;
  event.preventDefault();
  goHome();
});

// An explicit choice beats the Worker's Accept-Language guess.
try {
  const chosen = localStorage.getItem(LANGUAGE_KEY);
  if (chosen && chosen !== state.language) setLanguage(chosen);
} catch {
  // No storage, so no stored choice to honour.
}

// Translate anyway. Normally a no-op, since the Worker already did; if its
// rewrite ever misses, this turns permanently wrong text into a brief flicker.
translate(document, state.language);
markLanguage();

if (state.steamId) {
  el.steamId.value = state.steamId;
  setProfileStatus(say("profile.saved"));
}
renderProfileLabel();
route();
mountWorld(el.world, el.worldDots);
