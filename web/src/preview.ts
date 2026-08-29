/**
 * Per-game link previews.
 *
 * A shared link used to render as the site's generic card, because the game
 * id lived in the URL fragment and a fragment never reaches the server. On a
 * real path the Worker can look the game up and describe it before the HTML
 * leaves, which is the only moment that matters: preview bots do not run
 * JavaScript, so whatever the client would set afterwards is invisible to them.
 */

import type { GameAchievements } from "./steam.ts";

/**
 * The size Steam serves cover art at, the same for every game.
 *
 * Declared so a scraper can reserve the space before the image arrives. The
 * wide shape is also why the card is a `summary_large_image` one.
 */
const HEADER_WIDTH = 460;
const HEADER_HEIGHT = 215;

/**
 * Escapes text for use inside a double-quoted HTML attribute.
 *
 * Game titles are written by developers and arrive from Steam, so they are
 * untrusted. This is the only place in the project that builds HTML by hand,
 * which makes it the only place that could be injected into - hence escaping
 * the quote and the angle brackets rather than trusting that no game is called
 * something hostile.
 */
function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The document's own title element, which is text rather than an attribute. */
function text(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Replaces `pattern` with `tag`, taking the replacement literally.
 *
 * `String.replace` reads `$&`, `` $` ``, `$'` and `$1` in a *string*
 * replacement as instructions. Every tag below is built from a game name that
 * came from Steam, and `attribute()` cannot defend against this: it runs
 * before the replacement is assembled, and its own `&amp;` is what supplies
 * the ampersand that turns a bare `$` into `$&`. A game called `$&` used to
 * splice the matched tag - angle brackets, quotes and all - into the middle of
 * an attribute value, which is the precise escape `attribute()` exists to
 * prevent.
 *
 * A replacer function's return value is never scanned for those sequences, so
 * passing one closes the hole for all of them at once.
 */
interface Rewrite {
  html: string;
  /**
   * Tags the shell no longer contains, named as they were looked for.
   *
   * A replacement that matches nothing returns its input and says nothing, so
   * a shell edited into a shape these patterns no longer recognise would go on
   * serving the site's own card for every game, indefinitely and silently.
   * Collecting the misses lets the caller say so out loud.
   */
  missed: string[];
}

/**
 * Replaces `pattern` with `tag`, taking the replacement literally.
 *
 * `String.replace` reads `$&`, `` $` ``, `$'` and `$1` in a *string*
 * replacement as instructions. Every tag here is built from a game name that
 * came from Steam, and `attribute()` cannot defend against it: it runs before
 * the replacement is assembled, and its own `&amp;` is what supplies the
 * ampersand that turns a bare `$` into `$&`. A game called `$&` used to splice
 * the matched tag - angle brackets, quotes and all - into the middle of an
 * attribute value, which is the precise escape `attribute()` exists to
 * prevent.
 *
 * A replacer function's return value is never scanned for those sequences, so
 * passing one closes the hole for all of them at once.
 */
function put(into: Rewrite, name: string, pattern: RegExp, tag: string): Rewrite {
  if (!pattern.test(into.html)) {
    into.missed.push(name);
    return into;
  }
  into.html = into.html.replace(pattern, () => tag);
  return into;
}

/**
 * Rewrites the shell's metadata to describe one game.
 *
 * Replaces rather than appends: duplicate `og:title` tags leave the choice of
 * which one wins up to whichever scraper is reading, and they do not agree.
 */
export function describeGame(
  html: string,
  game: GameAchievements | null,
  url: string,
): Rewrite {
  const out: Rewrite = { html, missed: [] };

  // The address is known from the request, so it is rewritten whether or not
  // Steam could describe the game. Leaving the shell's own values behind left
  // every game page claiming, on a crawlable path cached for a day, to be the
  // home page - which tells a search engine they are all duplicates of it.
  put(out, 'link rel="canonical"', /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${attribute(url)}" />`);
  put(out, 'meta property="og:url"', /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${attribute(url)}" />`);

  // Without a game there is nothing truer than the site's own card to say, and
  // saying it is better than saying nothing.
  if (!game) return out;

  const title = `${game.name} — logros y cómo conseguirlos`;
  const description =
    `Los ${game.total} logros de ${game.name}, ordenados por lo raros que son ` +
    `de verdad, y cómo se consigue cada uno.`;

  put(out, "title", /<title>[^<]*<\/title>/, `<title>${text(title)}</title>`);
  put(out, 'meta name="description"', /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${attribute(description)}" />`);
  put(out, 'meta property="og:title"', /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${attribute(title)}" />`);

  // The description tag spans several lines in the shell, so it is matched
  // separately rather than folded into the single-line patterns above.
  put(out, 'meta property="og:description"',
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${attribute(description)}" />`);

  // The shell ships the site's own card, so the game's cover art replaces it
  // rather than joining it: two `og:image` tags leave the choice of which one
  // wins to whichever scraper is reading, and they do not agree. The declared
  // dimensions have to travel with the image, or they describe a picture that
  // is not there.
  //
  // A game with no artwork keeps the site's card, which is a worse preview
  // than the cover and a better one than none.
  if (game.headerImage) {
    put(out, 'meta property="og:image"', /<meta property="og:image" content="[^"]*" \/>/,
      `<meta property="og:image" content="${attribute(game.headerImage)}" />`);
    put(out, 'meta property="og:image:width"', /<meta property="og:image:width" content="[^"]*" \/>/,
      `<meta property="og:image:width" content="${HEADER_WIDTH}" />`);
    put(out, 'meta property="og:image:height"', /<meta property="og:image:height" content="[^"]*" \/>/,
      `<meta property="og:image:height" content="${HEADER_HEIGHT}" />`);
    put(out, 'meta property="og:image:alt"', /<meta property="og:image:alt" content="[^"]*" \/>/,
      `<meta property="og:image:alt" content="${attribute(`Portada de ${game.name}`)}" />`);
  }

  return out;
}
