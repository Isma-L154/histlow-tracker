/**
 * Per-game link previews. Preview bots do not run JavaScript, so the game's
 * title and art have to be in the HTML as it leaves the Worker.
 */

import type { GameAchievements } from "./steam.ts";
import type { Art } from "./art.ts";
import { escapeAttribute as attribute, escapeText as text, put, type Rewrite } from "./html.ts";

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

  // `<` is escaped inside the JSON, so a name holding `</script>` cannot end the block.
  const data = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "VideoGame",
    name: game.name,
    url,
    ...(art ? { image: art.url } : {}),
  }).replace(/</g, "\\u003c");
  put(out, "structured data", /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${data}</script>`);

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
