/**
 * Steam achievement browser - client.
 *
 * No framework and no build step: the page has one job, and every dependency
 * would be another thing to keep patched on a public URL.
 *
 * Nothing from the API is ever inserted as HTML. Achievement names and
 * descriptions are written by game developers, so they are untrusted text and
 * only ever reach the page through `textContent` or an attribute setter.
 */

import { handledInPage } from "./nav.js";

const SITE_TITLE = "HowToAchieve";
const STORAGE_KEY = "histlow.steamid";
const SEARCH_DEBOUNCE_MS = 250;
const MAX_RESULTS = 12;

/** Steam's own achievement-guide hub, already filtered to achievement guides. */
const GUIDES_BASE = "https://steamcommunity.com/app";

const el = {
  brand: document.querySelector(".brand"),
  form: document.getElementById("search-form"),
  search: document.getElementById("search-input"),
  results: document.getElementById("results"),
  profile: document.getElementById("profile"),
  steamId: document.getElementById("steamid-input"),
  steamIdSave: document.getElementById("steamid-save"),
  steamIdClear: document.getElementById("steamid-clear"),
  profileStatus: document.getElementById("profile-status"),
  hero: document.getElementById("hero"),
  status: document.getElementById("status"),
  game: document.getElementById("game"),
  cover: document.getElementById("game-cover"),
  name: document.getElementById("game-name"),
  progressLine: document.getElementById("progress-line"),
  progressText: document.getElementById("progress-text"),
  progressBar: document.getElementById("progress-bar"),
  progressFill: document.getElementById("progress-fill"),
  progressNotice: document.getElementById("progress-notice"),
  links: document.getElementById("game-links"),
  filters: document.getElementById("filters"),
  visibleCount: document.getElementById("visible-count"),
  list: document.getElementById("achievements"),
};

const state = {
  steamId: readStoredSteamId(),
  game: null,
  filter: "all",
};

/** In-flight requests, aborted when a newer one supersedes them. */
let searchRequest = null;
let gameRequest = null;
let searchTimer = null;

// -- api --------------------------------------------------------------------

/**
 * What to tell the reader when the API says no.
 *
 * Translating by status rather than by message text keeps the page and the
 * API from having to agree on wording: the API states a condition, and this
 * decides how to say it to a reader.
 */
const ERRORS = {
  400: "Type at least two characters to search.",
  404: "This game has no achievements on Steam, or that id does not exist.",
  502: "Steam is not responding right now. Try again in a moment.",
  503: "The Steam key is not configured on the server.",
};

async function api(path, signal) {
  let response;
  try {
    response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Could not connect. Check your connection and try again.");
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Falls through to the generic message below.
  }
  if (!response.ok) {
    throw new Error(ERRORS[response.status] ?? body?.error ?? `The API answered ${response.status}.`);
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
    setStatus("No game matches that search.");
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
      // The path is the single source of truth for "which game", so a game
      // can be bookmarked, the back button works without extra bookkeeping,
      // and the server can describe it when the link is shared.
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

  setStatus("Loading achievements…");
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
    el.cover.alt = `${game.name} cover art`;
    el.cover.hidden = false;
  } else {
    el.cover.hidden = true;
    el.cover.removeAttribute("src");
  }

  renderProgress(game);
  renderLinks(game);

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

  // Asking for progress and getting none is not the same as never asking. Say
  // so, or an unowned game looks exactly like a broken SteamID.
  const unexplained = state.steamId !== null && !known;
  el.progressNotice.hidden = !unexplained;
  el.progressNotice.textContent = unexplained
    ? "Steam is not sharing your progress for this game. Usually that means it is not in your library, or your game details are private."
    : "";

  if (!known) {
    el.visibleCount.textContent = `${game.total} achievements`;
    return;
  }

  const percent = game.total > 0 ? Math.round((game.unlockedCount / game.total) * 100) : 0;
  el.progressText.textContent = `${game.unlockedCount} of ${game.total} achievements · ${percent}%`;
  el.progressFill.style.width = `${percent}%`;
}

function renderLinks(game) {
  el.links.replaceChildren();
  const targets = [
    [
      "Achievement guides",
      `${GUIDES_BASE}/${game.appId}/guides/?browsefilter=toprated&requiredtags%5B%5D=Achievements&l=english`,
      "M4 5h16M4 12h16M4 19h10",
    ],
    [
      "Store page",
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
  // `unlocked` is null when no player was resolved: then nothing is claimed
  // either way, and the row is styled as neutral rather than as missing.
  if (achievement.unlocked === true) item.classList.add("is-unlocked");
  if (achievement.unlocked === false) item.classList.add("is-locked");
  item.dataset.unlocked = String(achievement.unlocked);

  const tier = rarityTier(achievement.globalPercent);

  // The whole row is the control. A separate button per achievement meant
  // sixty-three identical buttons down the page, and a row tall enough to
  // hold one - which is what made a single game eight screens long.
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
  // A few achievements point at art Steam no longer serves. An empty tile reads
  // as a missing icon; a broken-image box reads as a broken page.
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
      : "✓ Unlocked";
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
    achievement.description || "Hidden achievement: Steam does not publish the description.";
  detail.append(description);

  const panel = document.createElement("div");
  panel.className = "howto";
  panel.hidden = true;

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "howto-button";
  reveal.textContent = "How is it earned?";
  reveal.setAttribute("aria-expanded", "false");
  reveal.addEventListener("click", () => toggleHowTo(reveal, panel, appId, achievement));

  // Reading the guides costs a model call, so it stays a deliberate second
  // action rather than firing on every row somebody opens out of curiosity.
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
 * The rarity figure, plus a bar that can be compared without reading it.
 *
 * The bar is the reason this page exists: sorted by rarity, the list is meant
 * to be scanned, and a column of numbers cannot be. It is decorative in the
 * accessibility sense - the percentage next to it carries the same value, and
 * colour is never the only signal.
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
  value.title = `${tier.label}${percent === null ? "" : ` · ${percent.toFixed(1)}% of players`}`;

  wrap.append(bar, value);
  return wrap;
}

/**
 * How full the bar is, from 0 (everyone has it) to 1 (almost nobody does).
 *
 * Logarithmic, because a linear scale wastes itself where the interest is:
 * Hollow Knight's rarest six sit between 3.9% and 5.5%, which on a linear bar
 * are indistinguishable. On this one they separate visibly, while a 24%
 * achievement still reads as obviously easier.
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
    note("Searching community guides… the first lookup for each game takes a few seconds."),
  );

  try {
    const data = await api(`/api/howto/${appId}/${encodeURIComponent(achievement.key)}`);
    panel.dataset.loaded = "true";
    renderHowTo(panel, data, appId, achievement);
  } catch (error) {
    if (error.name === "AbortError") return;
    // Deliberately not marked as loaded: a failure here is usually transient,
    // so collapsing and reopening should try again rather than replay the error.
    panel.replaceChildren(note(error.message));
  }
}

function renderHowTo(panel, data, appId, achievement) {
  panel.replaceChildren();

  if (!data.answered) {
    panel.append(
      note(
        data.passages.length > 0
          ? "The guides that mention this achievement do not explain how to earn it."
          : `None of the ${data.guidesSearched} guides checked explains this achievement. Perhaps nobody has written it up yet.`,
      ),
      searchLink(appId, achievement.name),
    );
    return;
  }

  panel.append(renderSteps(data.steps));

  if (data.passages.length > 0) {
    const sources = document.createElement("p");
    sources.className = "howto-sources";
    sources.append(document.createTextNode("Written from: "));
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
    "Automatic summary of guides written by other players. If something looks wrong, the link goes to the original.";
  panel.append(disclaimer);
}

/**
 * The model is asked for a sentence followed by dashed steps, so that is what
 * gets rendered. Anything that does not match falls back to a paragraph rather
 * than being dropped.
 */
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
    "Search Steam yourself",
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

/**
 * Turns a raw unlock percentage into something a person can act on.
 *
 * The thresholds are the ones the completionist community already uses, so the
 * labels line up with how these achievements get talked about elsewhere.
 */
function rarityTier(percent) {
  if (percent === null) return { label: "No data", className: "rarity-unknown" };
  if (percent < 5) return { label: "Legendary", className: "rarity-legendary" };
  if (percent < 15) return { label: "Rare", className: "rarity-rare" };
  if (percent < 40) return { label: "Uncommon", className: "rarity-uncommon" };
  return { label: "Common", className: "rarity-common" };
}

/*
 * Publishes the top bar's height so the toolbar can stick directly beneath it.
 *
 * The bar wraps to two rows on a narrow screen, so the offset is measured
 * rather than hard-coded: a guessed value leaves either a gap or an overlap at
 * exactly the widths nobody tests.
 */
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
    visible === total ? `${total} achievements` : `${visible} of ${total} achievements`;
}

// -- profile ----------------------------------------------------------------

el.steamIdSave.addEventListener("click", () => {
  const value = el.steamId.value.trim();
  if (!/^\d{17}$/.test(value)) {
    setProfileStatus("A SteamID64 is exactly 17 digits.", true);
    return;
  }
  state.steamId = value;
  store(STORAGE_KEY, value);
  setProfileStatus("Saved. Reloading the achievements with your progress…");
  el.profile.open = false;
  if (state.game) loadGame(state.game.appId);
});

el.steamIdClear.addEventListener("click", () => {
  state.steamId = null;
  el.steamId.value = "";
  store(STORAGE_KEY, null);
  setProfileStatus("Removed. No achievement is marked as unlocked any more.");
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
    setProfileStatus("This browser will not store data, so this will be forgotten when you leave.", true);
  }
}

function setProfileStatus(message, isError = false) {
  el.profileStatus.textContent = message;
  el.profileStatus.classList.toggle("is-error", isError);
}

// -- shared helpers ---------------------------------------------------------

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
  // Bringing the hero back leaves somewhere to go from a dead link, instead of
  // an error on an otherwise empty page.
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
 * A usable image URL, or null.
 *
 * Two things go wrong with Steam's artwork. Some older schemas still hand out
 * `http://` URLs, which a browser blocks as mixed content on an HTTPS page.
 * And some achievements carry an empty icon field, which leaves a directory
 * URL ending in a slash: requesting it returns a listing rather than an image,
 * which the browser blocks and logs. Not asking is cleaner than handling the
 * failure afterwards.
 */
function artwork(url) {
  if (typeof url !== "string" || url === "") return null;
  const secure = url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
  return /\/[^/?#]+\.[a-z]{3,4}(?:[?#]|$)/i.test(secure) ? secure : null;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Unlocked"
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// -- routing ----------------------------------------------------------------

/**
 * Sends the browser to a game without reloading the page.
 *
 * A real path rather than a fragment, because a fragment never reaches the
 * server and the server is what writes the preview card a chat app shows.
 */
function goToGame(appId) {
  history.pushState({ appId }, "", `/game/${appId}`);
  route();
}

/**
 * The same, back to the home page.
 *
 * No second history entry when the reader is already home: the brand sits in
 * the header of every page and gets clicked idly, and three idle clicks used
 * to mean three presses of Back before anything appeared to happen.
 */
function goHome() {
  if (location.pathname !== "/") history.pushState({}, "", "/");
  // `href="#"` sent the reader to the top of the document, and a full
  // navigation to "/" still does. Cancelling the navigation has to keep that,
  // or arriving from deep in a long achievement list lands them halfway down
  // a page that just got much shorter.
  scrollTo(0, 0);
  route();
}

function route() {
  // Links shared before the move still arrive as #/game/123. Rewriting them
  // in place keeps every bookmark and pasted message working, and leaves the
  // reader on a URL that will preview properly if they share it onward.
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

// Back and forward now move between real paths.
window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

el.hero.addEventListener("click", (event) => {
  const example = event.target.closest("[data-appid]");
  if (example) goToGame(Number(example.dataset.appid));
});

// The brand is a plain link to "/", so it opens in a new tab, works from the
// keyboard, and still goes home with scripting off. Once the page is running
// there is no reason to reload the whole document for it: the router already
// knows how to draw the home page.
el.brand.addEventListener("click", (event) => {
  if (!handledInPage(event)) return;
  event.preventDefault();
  goHome();
});

if (state.steamId) {
  el.steamId.value = state.steamId;
  setProfileStatus("Saved in this browser.");
}
route();
