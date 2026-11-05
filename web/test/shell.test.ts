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
import notFound from "../public/404.html?raw";
import sitemap from "../public/sitemap.xml?raw";

const PAGES: ReadonlyArray<[name: string, html: string]> = [
  ["index.html", index],
  ["privacy.html", privacy],
  ["terms.html", terms],
  ["404.html", notFound],
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

describe("the contact address is published", () => {
  const MAILTO = 'href="mailto:info@cloudils.com"';

  function footer(html: string): string {
    const match = /<footer[^>]*>[\s\S]*?<\/footer>/.exec(html);
    expect(match, "no footer").not.toBeNull();
    return match![0];
  }

  it.each(PAGES)("%s links the address from its footer", (_name, html) => {
    expect(footer(html)).toContain(MAILTO);
  });

  it.each([
    ["privacy.html", privacy],
    ["terms.html", terms],
  ])("%s names the address under Contact, with no placeholder left", (_name, html) => {
    const contact = /<h2>Contact<\/h2>[\s\S]*?<\/p>/.exec(html);
    expect(contact, "no Contact section").not.toBeNull();
    expect(contact![0]).toContain(MAILTO);
    expect(html).not.toContain("doc-todo");
  });
});

describe("the site links to its games", () => {
  /** The game ids an element's links point at, in document order. */
  function linked(html: string): number[] {
    return [...html.matchAll(/<a class="example" href="\/game\/(\d+)" data-appid="\1">/g)].map((m) => Number(m[1]));
  }

  function section(html: string, open: RegExp, close: string): string {
    const start = html.search(open);
    expect(start, `no ${open}`).toBeGreaterThanOrEqual(0);
    return html.slice(start, html.indexOf(close, start));
  }

  const hero = linked(section(index, /<div class="hero-examples">/, "</div>"));
  const more = linked(section(index, /<nav class="more-games"/, "</nav>"));

  it("offers the example games as links a crawler can follow", () => {
    // Buttons with a data attribute look the same and lead nowhere outside JavaScript.
    expect(hero).toContain(367520);
    expect(index).not.toMatch(/<button[^>]*data-appid/);
  });

  it("links each game page to the same games", () => {
    expect(more).toEqual(hero);
  });

  it("lists in the sitemap exactly the games the home page links to", () => {
    // A listed page nothing links to is one Google is told about but never led to.
    const listed = [...sitemap.matchAll(/<loc>https:\/\/howtoachieve\.cloudils\.com\/game\/(\d+)<\/loc>/g)]
      .map((m) => Number(m[1]));
    expect(listed.sort()).toEqual([...hero].sort());
  });

  it.each(PAGES)("%s links the parent site from its footer", (_name, html) => {
    const footer = /<footer[^>]*>[\s\S]*?<\/footer>/.exec(html)![0];
    expect(footer).toContain('href="https://cloudils.com/"');
  });
});
