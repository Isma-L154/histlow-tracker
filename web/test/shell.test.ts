/**
 * The markup of the static shell, asserted against the files that ship.
 *
 * These pages have no build step, so nothing else would notice a hand-edited
 * tag going stale. Read as text, because that is what leaves the server and
 * all a preview scraper ever sees.
 */

import { describe, expect, it } from "vitest";
import index from "../public/index.html?raw";
import privacy from "../public/privacy.html?raw";
import terms from "../public/terms.html?raw";

const PAGES: ReadonlyArray<[name: string, html: string]> = [
  ["index.html", index],
  ["privacy.html", privacy],
  ["terms.html", terms],
];

/**
 * The brand link, matched by class wherever it sits in the tag. `app.js`
 * dereferences this element at module scope, so a rename takes the client down.
 */
function brand(html: string): string {
  const match = /<a[^>]*class="brand"[^>]*>[\s\S]*?<\/a>/.exec(html);
  expect(match, "no element with class 'brand'").not.toBeNull();
  return match![0];
}

describe("the brand is a link home", () => {
  it.each(PAGES)("%s points the brand at the home page", (_name, html) => {
    // `href="#"` looks like a link and behaves like one on the home page, but
    // from /game/440 it only rewrites the fragment: the reader stays put.
    expect(brand(html)).toMatch(/href="\/"/);
  });

  it.each(PAGES)("%s gives the brand link a name a screen reader can read", (_name, html) => {
    // The name is computed from the link's own text, so the wordmark has to
    // stay text. Moving it into the SVG or a background image would leave an
    // icon with no accessible name at all.
    expect(brand(html)).toMatch(/>\s*HowToAchieve\s*</);
  });
});
