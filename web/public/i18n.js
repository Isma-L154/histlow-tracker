/**
 * The interface, in two languages.
 *
 * One file, imported by both sides. The Worker substitutes the strings into the
 * HTML before it leaves, so a Spanish reader never sees a frame of English; the
 * client imports the same table to translate what it renders itself and to
 * redraw when the toggle is used. Two copies of these strings would drift, and
 * the drift would be invisible until someone complained.
 *
 * Only the interface is translated. The achievement steps are generated in
 * English and stay that way: the Workers AI free tier allows roughly seventy
 * first-time lookups a day, and a second language would halve that for both.
 *
 * Achievement names, game titles and guide text are data, not interface, and
 * are never translated.
 */

/** The language used when nothing else applies, and the source of these keys. */
export const DEFAULT_LANGUAGE = "en";

export const LANGUAGES = ["en", "es"];

export const DICTIONARY = {
  en: {
    "brand.tagline": "every Steam achievement, explained",
    "search.label": "Search for a game",
    "search.placeholder": "Search for a game…",
    "search.results": "Results",
    "profile.title": "My profile",
    "profile.prompt": "Your Steam profile",
    "profile.placeholder": "steamcommunity.com/id/yourname",
    "profile.helpTitle": "Where do I find this?",
    "profile.help1": "Open Steam and click your name, then Profile.",
    "profile.help2": "Copy the address from your browser.",
    "profile.help3": "Paste it above. Any form of it works.",
    "profile.unknown": "Steam does not know that profile name. Check it, or paste your profile link instead.",
    "profile.tooMany": "Too many profile lookups. Wait a minute and try again.",
    "profile.empty": "Paste your Steam profile link, or your SteamID64.",
    "profile.too long": "That is longer than any Steam profile link.",
    "profile.wrong length for an id": "A SteamID64 is exactly 17 digits.",
    "profile.unrecognised link": "That link is not a Steam profile. It should start with steamcommunity.com.",
    "profile.not an id": "A /profiles/ link should end in a 17-digit SteamID64.",
    "profile.unreadable": "That link could not be read. Try copying it again from your browser.",
    "profile.default": "That is not a Steam profile link, a SteamID64, or a custom profile name.",
    "profile.looking": "Looking up that profile…",
    "profile.found": "Found {name}. Saved in this browser.",
    "profile.foundNameless": "Found that profile. Saved in this browser.",
    "profile.hint": "Stored only in this browser. We use it to mark the achievements you already hold.",
    "profile.save": "Save",
    "profile.remove": "Remove",
    "profile.saved": "Saved in this browser.",
    "profile.saving": "Saved. Reloading the achievements with your progress…",
    "profile.removed": "Removed. No achievement is marked as unlocked any more.",
    "profile.noStorage": "This browser will not store data, so this will be forgotten when you leave.",
    "hero.title": "Find out how every achievement is earned",
    "hero.lead":
      "Search for a game and see every achievement ordered from the rarest to the most common. The steps come from guides the community wrote, summarised here.",
    "hero.try": "Try",
    "language.label": "Language",
    "filters.label": "Filter achievements",
    "filters.all": "All",
    "filters.missing": "Missing",
    "filters.unlocked": "Unlocked",
    "scale.note": "The bar and the percentage are how many people hold it: the fewer, the rarer.",
    "footer.credit": "Data from Steam. The steps come from guides written by the community.",
    "footer.privacy": "Privacy",
    "footer.terms": "Terms",
    "status.loading": "Loading achievements…",
    "status.noMatch": "No game matches that search.",
    "error.400": "Type at least two characters to search.",
    "error.404": "This game has no achievements on Steam, or that id does not exist.",
    "error.502": "Steam is not responding right now. Try again in a moment.",
    "error.503": "The Steam key is not configured on the server.",
    "error.offline": "Could not connect. Check your connection and try again.",
    "error.api": "The API answered {status}.",
    "time.label": "Time to 100%",
    "time.hours": "about {hours} hours",
    "time.source": "Estimated by IGDB, from times players reported.",
    "difficulty.label": "Completion difficulty",
    "difficulty.score": "{score}/10",
    "difficulty.straightforward": "Straightforward",
    "difficulty.someWork": "Some work",
    "difficulty.demanding": "Demanding",
    "difficulty.veryHard": "Very hard",
    "difficulty.brutal": "Brutal",
    "difficulty.basis": "Worked out from how few players on Steam hold these achievements. It is a reading of rarity, not a community vote.",
    "game.progress": "{unlocked} of {total} achievements",
    "game.count": "{total} achievements",
    "game.countFiltered": "{visible} of {total} achievements",
    "game.noProgress":
      "Steam is not sharing your progress for this game. Usually that means it is not in your library, or your game details are private.",
    "game.guides": "Achievement guides",
    "game.store": "Store page",
    "game.cover": "{name} cover art",
    "achievement.unlocked": "Unlocked",
    "achievement.hidden": "Hidden achievement: Steam does not publish the description.",
    "achievement.reveal": "How is it earned?",
    "rarity.unknown": "No data",
    "rarity.legendary": "Legendary",
    "rarity.rare": "Rare",
    "rarity.uncommon": "Uncommon",
    "rarity.common": "Common",
    "rarity.players": "{percent}% of players",
    "howto.searching": "Searching community guides… the first lookup for each game takes a few seconds.",
    "howto.notExplained": "The guides that mention this achievement do not explain how to earn it.",
    "howto.noneExplain": "None of the {count} guides checked explains this achievement. Perhaps nobody has written it up yet.",
    "howto.sources": "Written from: ",
    "howto.disclaimer":
      "Automatic summary of guides written by other players. If something looks wrong, the link goes to the original.",
    "howto.searchSteam": "Search Steam yourself",
    "howto.language": "The steps are written in English whichever language this page is in.",
  },
  es: {
    "brand.tagline": "los logros de Steam, explicados",
    "search.label": "Buscar un juego",
    "search.placeholder": "Buscar un juego…",
    "search.results": "Resultados",
    "profile.title": "Mi perfil",
    "profile.prompt": "Tu perfil de Steam",
    "profile.placeholder": "steamcommunity.com/id/tunombre",
    "profile.helpTitle": "¿De dónde saco esto?",
    "profile.help1": "Abre Steam, pulsa tu nombre y entra en Perfil.",
    "profile.help2": "Copia la dirección de tu navegador.",
    "profile.help3": "Pégala aquí arriba. Vale en cualquier formato.",
    "profile.unknown": "Steam no conoce ese nombre de perfil. Revísalo, o pega el enlace de tu perfil.",
    "profile.tooMany": "Demasiadas búsquedas de perfil. Espera un minuto y vuelve a intentarlo.",
    "profile.empty": "Pega el enlace de tu perfil de Steam, o tu SteamID64.",
    "profile.too long": "Eso es más largo que cualquier enlace de perfil de Steam.",
    "profile.wrong length for an id": "Un SteamID64 son exactamente 17 dígitos.",
    "profile.unrecognised link": "Ese enlace no es un perfil de Steam. Debería empezar por steamcommunity.com.",
    "profile.not an id": "Un enlace /profiles/ termina en un SteamID64 de 17 dígitos.",
    "profile.unreadable": "No se pudo leer ese enlace. Prueba a copiarlo otra vez del navegador.",
    "profile.default": "Eso no es un enlace de perfil de Steam, ni un SteamID64, ni un nombre personalizado.",
    "profile.looking": "Buscando ese perfil…",
    "profile.found": "Encontrado: {name}. Guardado en este navegador.",
    "profile.foundNameless": "Perfil encontrado. Guardado en este navegador.",
    "profile.hint": "Se guarda solo en este navegador. Con él marcamos los logros que ya tienes.",
    "profile.save": "Guardar",
    "profile.remove": "Quitar",
    "profile.saved": "Guardado en este navegador.",
    "profile.saving": "Guardado. Recargando los logros con tu progreso…",
    "profile.removed": "Quitado. Ya no se marca ningún logro como conseguido.",
    "profile.noStorage": "Este navegador no permite guardar datos, así que se olvidará al salir.",
    "hero.title": "Descubre cómo se consigue cada logro",
    "hero.lead":
      "Busca un juego y verás todos sus logros ordenados del más raro al más común. Los pasos salen de las guías que escribió la comunidad, resumidos aquí.",
    "hero.try": "Prueba con",
    "language.label": "Idioma",
    "filters.label": "Filtrar logros",
    "filters.all": "Todos",
    "filters.missing": "Me faltan",
    "filters.unlocked": "Conseguidos",
    "scale.note": "La barra y el porcentaje son cuánta gente lo tiene: cuanto menos, más raro.",
    "footer.credit": "Datos de Steam. Los pasos salen de guías escritas por la comunidad.",
    "footer.privacy": "Privacidad",
    "footer.terms": "Términos",
    "status.loading": "Cargando logros…",
    "status.noMatch": "Ningún juego coincide con esa búsqueda.",
    "error.400": "Escribe al menos dos caracteres para buscar.",
    "error.404": "Este juego no tiene logros en Steam, o ese identificador no existe.",
    "error.502": "Steam no está respondiendo ahora mismo. Prueba otra vez en un momento.",
    "error.503": "Falta configurar la clave de Steam en el servidor.",
    "error.offline": "No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.",
    "error.api": "La API respondió {status}.",
    "time.label": "Tiempo para el 100%",
    "time.hours": "unas {hours} horas",
    "time.source": "Estimación de IGDB, a partir de los tiempos que reportan los jugadores.",
    "difficulty.label": "Dificultad para completarlo",
    "difficulty.score": "{score}/10",
    "difficulty.straightforward": "Sencillo",
    "difficulty.someWork": "Moderado",
    "difficulty.demanding": "Exigente",
    "difficulty.veryHard": "Muy difícil",
    "difficulty.brutal": "Brutal",
    "difficulty.basis": "Calculado a partir de cuán poca gente tiene estos logros en Steam. Es una medida de rareza, no el voto de la comunidad.",
    "game.progress": "{unlocked} de {total} logros",
    "game.count": "{total} logros",
    "game.countFiltered": "{visible} de {total} logros",
    "game.noProgress":
      "Steam no da tu progreso en este juego. Suele ser porque no está en tu biblioteca, o porque tus datos de juego son privados.",
    "game.guides": "Guías de logros",
    "game.store": "Ficha de la tienda",
    "game.cover": "Portada de {name}",
    "achievement.unlocked": "Conseguido",
    "achievement.hidden": "Logro oculto: Steam no publica la descripción.",
    "achievement.reveal": "¿Cómo se consigue?",
    "rarity.unknown": "Sin datos",
    "rarity.legendary": "Legendario",
    "rarity.rare": "Raro",
    "rarity.uncommon": "Poco común",
    "rarity.common": "Común",
    "rarity.players": "{percent}% de los jugadores",
    "howto.searching": "Buscando en las guías de la comunidad… la primera consulta de cada juego tarda unos segundos.",
    "howto.notExplained": "Las guías que mencionan este logro no explican cómo conseguirlo.",
    "howto.noneExplain":
      "Ninguna de las {count} guías revisadas explica este logro. Puede que nadie lo haya escrito todavía.",
    "howto.sources": "Escrito a partir de: ",
    "howto.disclaimer":
      "Resumen automático de guías escritas por otros jugadores. Si algo no cuadra, el enlace lleva al original.",
    "howto.searchSteam": "Buscar a mano en Steam",
    "howto.language": "Los pasos están en inglés, sea cual sea el idioma de la página.",
  },
};

/**
 * One string, with `{placeholders}` filled in.
 *
 * Falls back to English rather than to the key. A missing translation should
 * read as slightly wrong, not as `game.progress` - and CI fails on a missing
 * key anyway, so this only ever runs for a key added and deployed in the same
 * breath as its own bug.
 */
export function t(language, key, values) {
  const table = DICTIONARY[language] ?? DICTIONARY[DEFAULT_LANGUAGE];
  const template = table[key] ?? DICTIONARY[DEFAULT_LANGUAGE][key];
  if (template === undefined) return "";
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole,
  );
}

/**
 * Which language to show, given what the browser asked for and what was chosen.
 *
 * An explicit choice always wins: someone who picked English on a Spanish
 * laptop meant it, and re-deciding for them on every visit would be a bug they
 * cannot work around.
 */
export function pickLanguage(acceptLanguage, stored) {
  if (LANGUAGES.includes(stored)) return stored;
  return fromAcceptLanguage(acceptLanguage);
}

/**
 * The best supported language named by an `Accept-Language` header.
 *
 * Quality values are honoured, because `en;q=0.8, es` means Spanish however it
 * is ordered. Regional tags match on their base - `es-419` is Latin American
 * Spanish and this site has one Spanish.
 */
export function fromAcceptLanguage(header) {
  if (typeof header !== "string" || header === "") return DEFAULT_LANGUAGE;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(parameter))
        .find(Boolean);
      const weight = quality ? Number(quality[1]) : 1;
      return { base: (tag ?? "").trim().toLowerCase().split("-")[0], weight };
    })
    .filter((entry) => entry.base && Number.isFinite(entry.weight) && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  return ranked.find((entry) => LANGUAGES.includes(entry.base))?.base ?? DEFAULT_LANGUAGE;
}

/**
 * The attributes a `data-i18n-*` marker can fill.
 *
 * Text is not the only thing a reader sees: a placeholder is visible, and an
 * aria-label is the only thing a screen reader gets.
 */
const ATTRIBUTES = ["placeholder", "aria-label", "title", "alt"];

/**
 * Translates a document, or any part of one, in place.
 *
 * Marked by attribute rather than by selector so that the markup says which
 * strings are translatable. A list of selectors in a script would go stale the
 * first time someone edited the HTML without reading it.
 */
export function translate(root, language) {
  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = t(language, element.dataset.i18n);
  }
  for (const attribute of ATTRIBUTES) {
    const marker = `data-i18n-${attribute}`;
    for (const element of root.querySelectorAll(`[${marker}]`)) {
      element.setAttribute(attribute, t(language, element.getAttribute(marker)));
    }
  }
}
