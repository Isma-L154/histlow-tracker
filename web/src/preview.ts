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

  let out = html
    .replace(/<title>[^<]*<\/title>/, `<title>${text(title)}</title>`)
    .replace(
      /<meta name="description" content="[^"]*" \/>/,
      `<meta name="description" content="${attribute(description)}" />`,
    )
    .replace(
      /<meta property="og:title" content="[^"]*" \/>/,
      `<meta property="og:title" content="${attribute(title)}" />`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*" \/>/,
      `<meta property="og:url" content="${attribute(url)}" />`,
    )
    .replace(
      /<link rel="canonical" href="[^"]*" \/>/,
      `<link rel="canonical" href="${attribute(url)}" />`,
    );

  // The description tag spans several lines in the shell, so it is matched
  // separately rather than folded into the single-line pattern above.
  out = out.replace(
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
    out = out
      .replace(
        /<meta property="og:image" content="[^"]*" \/>/,
        `<meta property="og:image" content="${attribute(game.headerImage)}" />`,
      )
      .replace(
        /<meta property="og:image:width" content="[^"]*" \/>/,
        `<meta property="og:image:width" content="${HEADER_WIDTH}" />`,
      )
      .replace(
        /<meta property="og:image:height" content="[^"]*" \/>/,
        `<meta property="og:image:height" content="${HEADER_HEIGHT}" />`,
      )
      .replace(
        /<meta property="og:image:alt" content="[^"]*" \/>/,
        `<meta property="og:image:alt" content="${attribute(`Portada de ${game.name}`)}" />`,
      );
  }

  return out;
}
