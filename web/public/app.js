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

const STORAGE_KEY = "histlow.steamid";
const SEARCH_DEBOUNCE_MS = 250;
const MAX_RESULTS = 12;

/** Steam's own achievement-guide hub, already filtered and in Spanish. */
const GUIDES_BASE = "https://steamcommunity.com/app";

const el = {
  form: document.getElementById("search-form"),
  search: document.getElementById("search-input"),
  results: document.getElementById("results"),
  profile: document.getElementById("profile"),
  steamId: document.getElementById("steamid-input"),
  steamIdSave: document.getElementById("steamid-save"),
  steamIdClear: document.getElementById("steamid-clear"),
  profileStatus: document.getElementById("profile-status"),
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
 * The API answers in English because that is its contract with any caller;
 * this page is in Spanish. Translating by status rather than by message text
 * keeps the two from having to agree on wording.
 */
const ERRORS = {
  400: "Escribe al menos dos caracteres para buscar.",
  404: "Este juego no tiene logros en Steam, o ese identificador no existe.",
  502: "Steam no está respondiendo ahora mismo. Prueba otra vez en un momento.",
  503: "Falta configurar la clave de Steam en el servidor.",
};

async function api(path, signal) {
  let response;
  try {
    response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.");
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Falls through to the generic message below.
  }
  if (!response.ok) {
    throw new Error(ERRORS[response.status] ?? body?.error ?? `La API respondió ${response.status}.`);
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
    setStatus("Ningún juego coincide con esa búsqueda.");
    return;
  }

  for (const result of results.slice(0, MAX_RESULTS)) {
    const button = document.createElement("button");
    button.type = "button";

    if (result.icon) {
      const icon = document.createElement("img");
      icon.src = https(result.icon);
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
      // The hash is the single source of truth for "which game", so a game can
      // be bookmarked and the back button works without extra bookkeeping.
      location.hash = `#/game/${result.appId}`;
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

  setStatus("Cargando logros…");
  el.game.hidden = true;

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
  document.title = `${game.name} · Logros de Steam`;

  if (game.headerImage) {
    el.cover.src = https(game.headerImage);
    el.cover.alt = `Portada de ${game.name}`;
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
    ? "Steam no da tu progreso en este juego. Suele ser porque no está en tu biblioteca, o porque tus datos de juego son privados."
    : "";

  if (!known) {
    el.visibleCount.textContent = `${game.total} logros`;
    return;
  }

  const percent = game.total > 0 ? Math.round((game.unlockedCount / game.total) * 100) : 0;
  el.progressText.textContent = `${game.unlockedCount} de ${game.total} logros · ${percent}%`;
  el.progressFill.style.width = `${percent}%`;
}

function renderLinks(game) {
  el.links.replaceChildren();
  const guides = `${GUIDES_BASE}/${game.appId}/guides/?browsefilter=toprated&requiredtags%5B%5D=Achievements`;
  const targets = [
    ["Guías de logros (español)", `${guides}&l=spanish`],
    ["Guías de logros (todas)", guides],
    ["Estadísticas en Steam", `https://steamcommunity.com/stats/${game.appId}/achievements/`],
    ["Ficha de la tienda", `https://store.steampowered.com/app/${game.appId}/`],
  ];
  for (const [label, href] of targets) {
    el.links.append(link(label, href));
  }
}

function renderAchievement(appId, achievement) {
  const item = document.createElement("li");
  item.className = "achievement";
  // `unlocked` is null when no player was resolved: then nothing is claimed
  // either way, and the row is styled as neutral rather than as missing.
  if (achievement.unlocked === true) item.classList.add("is-unlocked");
  if (achievement.unlocked === false) item.classList.add("is-locked");
  item.dataset.unlocked = String(achievement.unlocked);

  const icon = document.createElement("img");
  icon.className = "achievement-icon";
  icon.src = https(achievement.unlocked === false ? achievement.iconLocked || achievement.icon : achievement.icon);
  icon.alt = "";
  icon.loading = "lazy";
  icon.referrerPolicy = "no-referrer";
  // A few achievements point at art Steam no longer serves. An empty tile reads
  // as a missing icon; a broken-image box reads as a broken page.
  icon.addEventListener("error", () => icon.removeAttribute("src"), { once: true });

  const body = document.createElement("div");
  body.className = "achievement-body";

  const title = document.createElement("h3");
  const name = document.createElement("span");
  name.textContent = achievement.name;
  title.append(name);
  if (achievement.unlocked === true) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = achievement.unlockedAt
      ? `✓ ${formatDate(achievement.unlockedAt)}`
      : "✓ Conseguido";
    title.append(badge);
  }
  body.append(title);

  const description = document.createElement("p");
  // Hidden achievements come back with an empty description from Steam.
  description.textContent = achievement.description || "Logro oculto: Steam no publica la descripción.";
  body.append(description);

  const actions = document.createElement("div");
  actions.className = "achievement-actions";

  const panel = document.createElement("div");
  panel.className = "howto";
  panel.hidden = true;

  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "howto-button";
  reveal.textContent = "¿Cómo se consigue?";
  reveal.setAttribute("aria-expanded", "false");
  reveal.addEventListener("click", () => toggleHowTo(reveal, panel, appId, achievement));

  const guide = link(
    "Ver guías en Steam →",
    `${GUIDES_BASE}/${appId}/guides/?searchText=${encodeURIComponent(achievement.name)}&browsefilter=toprated&l=spanish`,
  );
  guide.className = "achievement-guide";

  actions.append(reveal, guide);
  body.append(actions);

  const rarity = document.createElement("div");
  rarity.className = "rarity";
  const tier = rarityTier(achievement.globalPercent);
  const percent = document.createElement("span");
  percent.className = `rarity-percent ${tier.className}`;
  percent.textContent = achievement.globalPercent === null ? "—" : `${achievement.globalPercent.toFixed(1)}%`;
  const label = document.createElement("span");
  label.className = `rarity-label ${tier.className}`;
  label.textContent = tier.label;
  rarity.append(percent, label);

  item.append(icon, body, rarity, panel);
  return item;
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
    note("Buscando en las guías de la comunidad… la primera consulta de cada juego tarda unos segundos."),
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
          ? "Las guías que mencionan este logro no explican cómo conseguirlo."
          : `Ninguna de las ${data.guidesSearched} guías revisadas explica este logro. Puede que nadie lo haya escrito todavía.`,
      ),
      link(
        "Buscar a mano en Steam →",
        `${GUIDES_BASE}/${appId}/guides/?searchText=${encodeURIComponent(achievement.name)}&browsefilter=toprated&l=spanish`,
      ),
    );
    return;
  }

  panel.append(renderSteps(data.steps));

  if (data.passages.length > 0) {
    const sources = document.createElement("p");
    sources.className = "howto-sources";
    sources.append(document.createTextNode("Escrito a partir de: "));
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
    "Resumen automático de guías escritas por otros jugadores. Si algo no cuadra, el enlace lleva al original.";
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
  if (percent === null) return { label: "Sin datos", className: "rarity-unknown" };
  if (percent < 5) return { label: "Legendario", className: "rarity-legendary" };
  if (percent < 15) return { label: "Raro", className: "rarity-rare" };
  if (percent < 40) return { label: "Poco común", className: "rarity-uncommon" };
  return { label: "Común", className: "rarity-common" };
}

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
    visible === total ? `${total} logros` : `${visible} de ${total} logros`;
}

// -- profile ----------------------------------------------------------------

el.steamIdSave.addEventListener("click", () => {
  const value = el.steamId.value.trim();
  if (!/^\d{17}$/.test(value)) {
    setProfileStatus("Un SteamID64 son exactamente 17 dígitos.", true);
    return;
  }
  state.steamId = value;
  store(STORAGE_KEY, value);
  setProfileStatus("Guardado. Recargando los logros con tu progreso…");
  el.profile.open = false;
  if (state.game) loadGame(state.game.appId);
});

el.steamIdClear.addEventListener("click", () => {
  state.steamId = null;
  el.steamId.value = "";
  store(STORAGE_KEY, null);
  setProfileStatus("Quitado. Ya no se marca ningún logro como conseguido.");
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
    setProfileStatus("Este navegador no permite guardar datos, así que se olvidará al salir.", true);
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
 * Some older Steam schemas still hand out `http://` icon URLs, which a browser
 * blocks outright as mixed content on an HTTPS page.
 */
function https(url) {
  return typeof url === "string" && url.startsWith("http://")
    ? `https://${url.slice("http://".length)}`
    : url;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Conseguido"
    : date.toLocaleDateString("es-CR", { year: "numeric", month: "short", day: "numeric" });
}

// -- routing ----------------------------------------------------------------

function route() {
  const match = /^#\/game\/(\d{1,10})$/.exec(location.hash);
  if (match) {
    loadGame(Number(match[1]));
    return;
  }
  state.game = null;
  el.game.hidden = true;
  document.title = "Logros de Steam";
  setStatus("Busca un juego para ver todos sus logros ordenados por rareza.");
}

window.addEventListener("hashchange", route);

if (state.steamId) {
  el.steamId.value = state.steamId;
  setProfileStatus("Guardado en este navegador.");
}
route();
