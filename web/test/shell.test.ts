/**
 * The markup of the static shell, asserted against the files that ship.
 *
 * These pages have no build step, so nothing else would notice a hand-edited
 * tag going stale. The files are read as text rather than parsed in a browser
 * because what is being checked is what leaves the server - which is also all
 * a preview scraper ever sees.
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

/** The opening tag of the brand link, which is the site's way home. */
function brandAnchor(html: string): string {
  const match = /<a class="brand"[^>]*>/.exec(html);
  expect(match).not.toBeNull();
  return match![0];
}

describe("the brand is a link home", () => {
  it.each(PAGES)("%s points the brand at the home page", (_name, html) => {
    // `href="#"` looks like a link and behaves like one on the home page, but
    // from /game/440 it only rewrites the fragment: the reader stays put.
    expect(brandAnchor(html)).toMatch(/href="\/"/);
  });

  it("writes the brand link the same way on every page", () => {
    const [first, ...rest] = PAGES.map(([, html]) => brandAnchor(html));
    for (const anchor of rest) expect(anchor).toBe(first);
  });
});
