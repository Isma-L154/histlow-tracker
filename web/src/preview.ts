/**
 * Per-game link previews. Preview bots do not run JavaScript, so the game's
 * title and art have to be in the HTML as it leaves the Worker.
 */

import type { GameAchievements } from "./steam.ts";
import type { Art } from "./art.ts";

/**
 * Escapes text for a double-quoted attribute. Game titles come from Steam and are
 * untrusted, and this is the only place the project builds HTML by hand.
 */
function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The document's title element, which holds text rather than an attribute. */
function text(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Rewrite {
  html: string;
  /** Tags the shell no longer contains, so an edited shell cannot fall back silently. */
  missed: string[];
}

/**
 * Replaces `pattern` with `tag`, taking the replacement literally.
 *
 * A string replacement reads `$&`, `` $` ``, `$'` and `$1` as instructions, and
 * `attribute()` cannot prevent it: its own `&amp;` supplies the `&` that turns a
 * `$` in a game title into `$&`. A replacer function's result is never scanned.
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
 * Rewrites the shell's metadata to describe one game. Replaces rather than
 * appends, because scrapers disagree about which of two `og:title` tags wins.
 */
export function describeGame(
  html: string,
  game: GameAchievements | null,
  url: string,
  art: Art | null,
): Rewrite {
  const out: Rewrite = { html, missed: [] };

  // Known from the request, so rewritten even when Steam could not describe the
  // game. Left alone, every game page would claim to be the home page.
  put(out, 'link rel="canonical"', /<link rel="canonical" href="[^"]*" \/>/,
    `<link rel="canonical" href="${attribute(url)}" />`);
  put(out, 'meta property="og:url"', /<meta property="og:url" content="[^"]*" \/>/,
    `<meta property="og:url" content="${attribute(url)}" />`);

  if (!game) return out;

  const title = `${game.name} — achievements and how to earn them`;
  const description =
    `All ${game.total} achievements in ${game.name}, ordered by how rare they ` +
    `really are, and how each one is earned.`;

  put(out, "title", /<title>[^<]*<\/title>/, `<title>${text(title)}</title>`);
  put(out, 'meta name="description"', /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${attribute(description)}" />`);
  put(out, 'meta property="og:title"', /<meta property="og:title" content="[^"]*" \/>/,
    `<meta property="og:title" content="${attribute(title)}" />`);

  // The shell spreads this tag over several lines.
  put(out, 'meta property="og:description"',
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
    `<meta property="og:description" content="${attribute(description)}" />`);

  // The site's own card is replaced rather than joined, and the dimensions travel
  // with the image. A game with no art keeps the site's card.
  if (art) {
    put(out, 'meta property="og:image"', /<meta property="og:image" content="[^"]*" \/>/,
      `<meta property="og:image" content="${attribute(art.url)}" />`);
    put(out, 'meta property="og:image:width"', /<meta property="og:image:width" content="[^"]*" \/>/,
      `<meta property="og:image:width" content="${art.width}" />`);
    put(out, 'meta property="og:image:height"', /<meta property="og:image:height" content="[^"]*" \/>/,
      `<meta property="og:image:height" content="${art.height}" />`);
    put(out, 'meta property="og:image:alt"', /<meta property="og:image:alt" content="[^"]*" \/>/,
      `<meta property="og:image:alt" content="${attribute(`${game.name} cover art`)}" />`);
  }

  return out;
}
