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
function put(html: string, pattern: RegExp, tag: string): string {
  return html.replace(pattern, () => tag);
}

/**
 * Rewrites the shell's metadata to describe one game.
 *
 * Replaces rather than appends: duplicate `og:title` tags leave the choice of
 * which one wins up to whichever scraper is reading, and they do not agree.
 */
export function describeGame(html: string, game: GameAchievements, origin: string): string {
  const title = `${game.name} — logros y cómo conseguirlos`;
  const description =
    `Los ${game.total} logros de ${game.name}, ordenados por lo raros que son ` +
    `de verdad, y cómo se consigue cada uno.`;
  const url = `${origin}/game/${game.appId}`;

  let out = put(html, /<title>[^<]*<\/title>/, `<title>${text(title)}</title>`);
  out = put(
    out,
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${attribute(description)}" />`,
  );
  out = put(
    out,
    /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${attribute(title)}" />`,
  );
  out = put(
    out,
    /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${attribute(url)}" />`,
  );
  out = put(
    out,
    /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${attribute(url)}" />`,
  );

  // The description tag spans several lines in the shell, so it is matched
  // separately rather than folded into the single-line patterns above.
  out = put(
    out,
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${attribute(description)}" />`,
  );

  // The shell ships the site's own card, so the game's cover art replaces it
  // rather than joining it: two `og:image` tags leave the choice of which one
  // wins to whichever scraper is reading, and they do not agree. The declared
  // dimensions have to travel with the image, or they describe a picture that
  // is not there.
  //
  // A game Steam does not know, or has no artwork for, keeps the site's card.
  // That is a worse preview than the cover and a better one than none.
  if (game.headerImage) {
    out = put(
      out,
      /<meta property="og:image" content="[^"]*" \/>/,
      `<meta property="og:image" content="${attribute(game.headerImage)}" />`,
    );
    out = put(
      out,
      /<meta property="og:image:width" content="[^"]*" \/>/,
      `<meta property="og:image:width" content="${HEADER_WIDTH}" />`,
    );
    out = put(
      out,
      /<meta property="og:image:height" content="[^"]*" \/>/,
      `<meta property="og:image:height" content="${HEADER_HEIGHT}" />`,
    );
    out = put(
      out,
      /<meta property="og:image:alt" content="[^"]*" \/>/,
      `<meta property="og:image:alt" content="${attribute(`Portada de ${game.name}`)}" />`,
    );
  }

  return out;
}
