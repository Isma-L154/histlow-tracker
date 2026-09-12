/**
 * HowToAchieve's client. No framework and no build step.
 *
 * Nothing from the API is ever inserted as HTML: achievement names and
 * descriptions are written by game developers, so they only reach the page as text.
 */

import { handledInPage } from "./nav.js";
import { DICTIONARY, pickLanguage, t, translate } from "./i18n.js";
import { completionDifficulty } from "./difficulty.js";

const SITE_TITLE = "HowToAchieve";
const STORAGE_KEY = "histlow.steamid";
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
  steamId: document.getElementById("steamid-input"),
  steamIdSave: document.getElementById("steamid-save"),
  steamIdClear: document.getElementById("steamid-clear"),
  profileStatus: document.getElementById("profile-status"),
  hero: document.getElementById("hero"),
  upcoming: document.getElementById("upcoming"),
  upcomingList: document.getElementById("upcoming-list"),
  status: document.getElementById("status"),
  game: document.getElementById("game"),
  cover: document.getElementById("game-cover"),
  name: document.getElementById("game-name"),
  progressLine: document.getElementById("progress-line"),
  progressText: document.getElementById("progress-text"),
  progressBar: document.getElementById("progress-bar"),
  progressFill: document.getElementById("progress-fill"),
  progressNotice: document.getElementById("progress-notice"),
  difficulty: document.getElementById("difficulty"),
  completionTime: document.getElementById("completion-time"),
  completionHours: document.getElementById("completion-hours"),
  difficultyScore: document.getElementById("difficulty-score"),
  difficultyTier: document.getElementById("difficulty-tier"),
  links: document.getElementById("game-links"),
  filters: document.getElementById("filters"),
  visibleCount: document.getElementById("visible-count"),
  list: document.getElementById("achievements"),
};

const state = {
  // The Worker already decided this and wrote it into `lang`.
  language: pickLanguage("", document.documentElement.lang),
  steamId: readStoredSteamId(),
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
  el.hero.hidden = true;

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

  const cover = artwork(game.headerImage);
  if (cover) {
    el.cover.src = cover;
    el.cover.alt = say("game.cover", { name: game.name });
    el.cover.hidden = false;
  } else {
    el.cover.hidden = true;
    el.cover.removeAttribute("src");
  }

  renderProgress(game);
  renderDifficulty(game);
  renderLinks(game);
  renderCompletionTime(game.appId);

  // The filters only mean something once we know what the player already has.
  el.filters.hidden = game.unlockedCount === null;
  setActiveChip("all");

  el.list.replaceChildren();
  for (const achievement of game.achievements) {
    el.list.append(renderAchievement(game.appId, achievement));
  }
  applyFilter();

  el.game.hidden = false;
}

function renderProgress(game) {
  const known = game.unlockedCount !== null;
  el.progressLine.hidden = !known;
  el.progressBar.hidden = !known;

  // Asked for progress and got none: say so, or an unowned game looks like a broken SteamID.
  const unexplained = state.steamId !== null && !known;
  el.progressNotice.hidden = !unexplained;
  el.progressNotice.textContent = unexplained
    ? say("game.noProgress")
    : "";

  if (!known) {
    el.visibleCount.textContent = say("game.count", { total: game.total });
    return;
  }

  const percent = game.total > 0 ? Math.round((game.unlockedCount / game.total) * 100) : 0;
  el.progressText.textContent = `${say("game.progress", { unlocked: game.unlockedCount, total: game.total })} · ${percent}%`;
  el.progressFill.style.width = `${percent}%`;
}

/** How hard the game is to finish, or nothing when there is too little to read. */
function renderDifficulty(game) {
  const difficulty = completionDifficulty(game.achievements.map((a) => a.globalPercent));
  el.difficulty.hidden = difficulty === null;
  if (!difficulty) return;

  el.difficulty.dataset.tier = difficulty.tier;
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
    [
      say("game.guides"),
      `${GUIDES_BASE}/${game.appId}/guides/?browsefilter=toprated&requiredtags%5B%5D=Achievements&l=english`,
      "M4 5h16M4 12h16M4 19h10",
    ],
    [
      say("game.store"),
      `https://store.steampowered.com/app/${game.appId}/`,
      "M5 7h14l-1 12H6zM9 7V5a3 3 0 0 1 6 0v2",
    ],
  ];
  for (const [label, href, path] of targets) {
    const anchor = link(label, href);
    anchor.className = "steam-link";
    anchor.prepend(icon(path));
    el.links.append(anchor);
  }
}

/** A small line-art glyph from a single path, drawn inline to satisfy the CSP. */
function icon(path) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
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

  const icon = document.createElement("img");
  icon.className = "achievement-icon";
  const art = artwork(
    achievement.unlocked === false ? achievement.iconLocked || achievement.icon : achievement.icon,
  );
  if (art) icon.src = art;
  icon.alt = "";
  icon.loading = "lazy";
  icon.referrerPolicy = "no-referrer";
  // Some art is no longer served, and an empty tile beats a broken-image box.
  icon.addEventListener("error", () => icon.removeAttribute("src"), { once: true });

  const name = document.createElement("span");
  name.className = "achievement-name";
  name.textContent = achievement.name;

  summary.append(icon, name);

  if (achievement.unlocked === true) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = achievement.unlockedAt
      ? `✓ ${formatDate(achievement.unlockedAt)}`
      : `✓ ${say("achievement.unlocked")}`;
    summary.append(badge);
  }

  summary.append(rarityMeter(achievement.globalPercent, tier), chevron());

  const detail = document.createElement("div");
  detail.className = "achievement-detail";
  detail.hidden = true;

  const description = document.createElement("p");
  description.className = "achievement-description";
  // Hidden achievements come back with an empty description from Steam.
  description.textContent =
    achievement.description || say("achievement.hidden");
  detail.append(description);

  const panel = document.createElement("div");
  panel.className = "howto";
  panel.hidden = true;

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "howto-button";
  reveal.textContent = say("achievement.reveal");
  reveal.setAttribute("aria-expanded", "false");
  reveal.addEventListener("click", () => toggleHowTo(reveal, panel, appId, achievement));

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
 * The rarity figure, with a bar for scanning. The bar is decorative: the
 * percentage carries the same value, so colour is never the only signal.
 */
function rarityMeter(percent, tier) {
  const wrap = document.createElement("span");
  wrap.className = "rarity";

  const bar = document.createElement("span");
  bar.className = `rarity-bar ${tier.className}`;
  bar.setAttribute("aria-hidden", "true");
  const fill = document.createElement("span");
  fill.style.width = `${Math.round(rarityWeight(percent) * 100)}%`;
  bar.append(fill);

  const value = document.createElement("span");
  value.className = `rarity-percent ${tier.className}`;
  value.textContent = percent === null ? "—" : `${percent.toFixed(1)}%`;
  value.title = `${tier.label}${percent === null ? "" : ` · ${say("rarity.players", { percent: percent.toFixed(1) })}`}`;

  wrap.append(bar, value);
  return wrap;
}

/**
 * How full the bar is, from 0 (everyone has it) to 1 (almost nobody does).
 * Logarithmic, so achievements a few percent apart near the bottom separate.
 */
function rarityWeight(percent) {
  if (percent === null || percent <= 0) return 0;
  const clamped = Math.min(100, Math.max(0.1, percent));
  return Math.min(1, Math.log10(100 / clamped) / 3);
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "chevron");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 9l6 6 6-6");
  svg.append(path);
  return svg;
}

// -- how an achievement is earned -------------------------------------------

async function toggleHowTo(button, panel, appId, achievement) {
  const open = button.getAttribute("aria-expanded") === "true";
  if (open) {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    return;
  }

  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  if (panel.dataset.loaded === "true") return;

  panel.replaceChildren(
    note(say("howto.searching")),
  );

  try {
    const data = await api(`/api/howto/${appId}/${encodeURIComponent(achievement.key)}`);
    panel.dataset.loaded = "true";
    renderHowTo(panel, data, appId, achievement);
  } catch (error) {
    if (error.name === "AbortError") return;
    // Not marked as loaded, so reopening retries what was usually a transient failure.
    panel.replaceChildren(note(error.message));
  }
}

function renderHowTo(panel, data, appId, achievement) {
  panel.replaceChildren();

  if (!data.answered) {
    panel.append(
      note(
        data.passages.length > 0
          ? say("howto.notExplained")
          : say("howto.noneExplain", { count: data.guidesSearched }),
      ),
      searchLink(appId, achievement.name),
    );
    return;
  }

  panel.append(renderSteps(data.steps));

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
    panel.append(sources);
  }

  const disclaimer = document.createElement("p");
  disclaimer.className = "howto-disclaimer";
  disclaimer.textContent =
    say("howto.disclaimer");
  panel.append(disclaimer);
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
  anchor.prepend(icon("M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M20 20l-3.5-3.5"));
  return anchor;
}

function note(message) {
  const paragraph = document.createElement("p");
  paragraph.className = "howto-note";
  paragraph.textContent = message;
  return paragraph;
}

/** Rarity bands, at the thresholds the completionist community already uses. */
function rarityTier(percent) {
  if (percent === null) return { label: say("rarity.unknown"), className: "rarity-unknown" };
  if (percent < 5) return { label: say("rarity.legendary"), className: "rarity-legendary" };
  if (percent < 15) return { label: say("rarity.rare"), className: "rarity-rare" };
  if (percent < 40) return { label: say("rarity.uncommon"), className: "rarity-uncommon" };
  return { label: say("rarity.common"), className: "rarity-common" };
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

function setActiveChip(filter) {
  for (const chip of el.filters.querySelectorAll("[data-filter]")) {
    chip.classList.toggle("is-active", chip.dataset.filter === filter);
  }
}

function applyFilter() {
  let visible = 0;
  for (const item of el.list.children) {
    const unlocked = item.dataset.unlocked;
    const show =
      state.filter === "all" ||
      (state.filter === "unlocked" && unlocked === "true") ||
      (state.filter === "missing" && unlocked === "false");
    item.hidden = !show;
    if (show) visible += 1;
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
  el.steamId.value = "";
  store(STORAGE_KEY, null);
  setProfileStatus(say("profile.removed"));
  if (state.game) loadGame(state.game.appId);
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
  if (upcomingReleases.length > 0) renderUpcoming();
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
  el.hero.hidden = false;
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

// -- upcoming releases ------------------------------------------------------

/** Redrawn on this interval so a countdown does not go stale on an open tab. */
const COUNTDOWN_REFRESH_MS = 60_000;

/** What the API last returned, so a language switch can redraw without refetching. */
let upcomingReleases = [];

/** How far off a date is, in days rather than a ticking clock. */
function countdown(releasedAt, now) {
  const days = Math.ceil((releasedAt * 1000 - now) / 86_400_000);
  if (days <= 0) return say("upcoming.today");
  if (days === 1) return say("upcoming.tomorrow");
  return say("upcoming.days", { days });
}

/** The most anticipated releases, or nothing at all: a heading over no cards is worse than none. */
async function loadUpcoming() {
  try {
    const data = await api("/api/upcoming");
    upcomingReleases = Array.isArray(data?.releases) ? data.releases : [];
  } catch {
    // The Worker logged it. A reader can do nothing about IGDB being down.
    upcomingReleases = [];
  }
  renderUpcoming();
}

function renderUpcoming() {
  const now = Date.now();
  // A release that passed while the tab was open drops out rather than counting past zero.
  const live = upcomingReleases.filter((release) => release.releasedAt * 1000 > now - 86_400_000);

  el.upcoming.hidden = live.length === 0;
  if (live.length === 0) return;

  el.upcomingList.replaceChildren();
  for (const release of live) {
    const card = document.createElement("li");
    card.className = "upcoming-card";

    if (release.coverUrl) {
      const cover = document.createElement("img");
      cover.className = "upcoming-cover";
      cover.src = release.coverUrl;
      cover.alt = "";
      cover.loading = "lazy";
      // A third party, like Steam: no referrer.
      cover.referrerPolicy = "no-referrer";
      card.append(cover);
    }

    const name = document.createElement("p");
    name.className = "upcoming-name";
    // Titles come from IGDB and are untrusted, like everything else here.
    name.textContent = release.name;

    const when = document.createElement("p");
    when.className = "upcoming-when";
    when.textContent = countdown(release.releasedAt, now);

    card.append(name, when);
    el.upcomingList.append(card);
  }
}

// -- routing ----------------------------------------------------------------

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
  el.hero.hidden = false;
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
route();

// After routing, so a direct link to a game does not wait for it.
loadUpcoming();
setInterval(renderUpcoming, COUNTDOWN_REFRESH_MS);
