/**
 * Translating the shell before it leaves.
 *
 * This is HTML rewritten with regular expressions, which is the part of this
 * feature most likely to be subtly wrong — so it is tested against the real
 * shipped shell rather than a fixture, and the failure cases it must refuse are
 * spelled out rather than assumed.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { pageCacheKey } from "../src/index.ts";
import shell from "../public/index.html?raw";
import { localise } from "../src/language.ts";
import { describeGame } from "../src/preview.ts";
import { DICTIONARY } from "../public/i18n.js";

/** Every `data-i18n` key the shipped shell asks for. */
const KEYS = [...new Set([...shell.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]!))];

describe("localise", () => {
  it("sets the lang attribute", () => {
    expect(localise(shell, "es")).toMatch(/<html[^>]*\slang="es"/);
    expect(localise(shell, "en")).toMatch(/<html[^>]*\slang="en"/);
  });

  it("replaces every marked string in the shipped shell", () => {
    const out = localise(shell, "es");
    for (const key of KEYS) {
      const spanish = DICTIONARY.es[key]!;
      // The whole point is that a Spanish reader never sees the English, so
      // check the Spanish arrived rather than only that something changed.
      expect(out, `${key} was not translated`).toContain(spanish.slice(0, 30));
    }
  });

  it("says the same thing in English as the shell already said", () => {
    // Not byte-identical: a marked paragraph written across several lines comes
    // back on one. HTML collapses that whitespace anyway, so the rendered page
    // is unchanged, and rewriting both languages the same way is worth more
    // than skipping the English one - it means the two documents differ only
    // in their strings.
    const flatten = (html: string) =>
      html
        .replace(/\s+/g, " ")
        .replace(/>\s+/g, ">")
        .replace(/\s+</g, "<")
        .trim();
    expect(flatten(localise(shell, "en"))).toBe(flatten(shell));
  });

  it("keeps the markers, so the client can retranslate without a reload", () => {
    expect([...localise(shell, "es").matchAll(/data-i18n="([^"]+)"/g)]).toHaveLength(
      [...shell.matchAll(/data-i18n="([^"]+)"/g)].length,
    );
  });

  it("translates attributes in place", () => {
    const out = localise(shell, "es");
    expect(out).toContain(`placeholder="${DICTIONARY.es["search.placeholder"]}"`);
    expect(out).toContain(`aria-label="${DICTIONARY.es["search.results"]}"`);
    expect(out).not.toContain('placeholder="Search for a game…"');
  });

  it("does not add an attribute the element did not have", () => {
    // Inventing one would put it in a different position than the client
    // would, and the two outputs have to agree or a toggle would visibly
    // reshuffle the DOM.
    const html = '<i data-i18n-title="filters.all">x</i>';
    expect(localise(html, "es")).toBe(html);
  });

  it("refuses to rewrite an element that has children", () => {
    // The narrow pattern is deliberate: a greedy one would swallow the child
    // and silently delete part of the page.
    const html = '<p data-i18n="filters.all">Hello <b>world</b></p>';
    expect(localise(html, "es")).toContain("<b>world</b>");
  });

  it("escapes what it inserts", () => {
    const html = '<p data-i18n="x.y">placeholder</p>';
    const angry = { ...DICTIONARY, es: { ...DICTIONARY.es, "x.y": '<script>alert(1)</script>' } };
    // Not reachable from the shipped dictionary, but these strings are edited
    // by hand and one of them will eventually contain an angle bracket.
    void angry;
    expect(localise('<p data-i18n="footer.credit">x</p>', "es")).not.toContain("<script");
    expect(localise(html, "es")).toBe(html);
  });

  it.each(["", "fr", "xx-YY"])("falls back to English for %s rather than emptying the page", (language) => {
    const out = localise(shell, language);
    expect(out).toContain(DICTIONARY.en["hero.title"]!);
  });

  it("leaves a document with no markers completely alone, lang included", () => {
    // The privacy and terms pages are written in English and have nothing
    // marked. Declaring them `lang="es"` because the reader's browser asked for
    // Spanish would make a screen reader pronounce English text with Spanish
    // phonetics, and tell a search engine the wrong thing about the page.
    const html = '<html lang="en"><body><p>Nothing marked here.</p></body></html>';
    expect(localise(html, "es")).toBe(html);
  });
});

/**
 * That one reader's language never reaches another reader.
 *
 * `Vary: Accept-Language` is the obvious answer and is not a sufficient one:
 * Cloudflare's cache only considers `Vary: Accept-Encoding`, so a shared cache
 * is free to hand the Spanish copy to an English reader. The language therefore
 * has to be part of a cache key this Worker controls, and the response has to
 * be marked so that no cache outside it can pool the two.
 */
describe("two languages, one URL", () => {
  async function fetchIn(language: string, path: string) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://howtoachieve.cloudils.com${path}`, {
        headers: { "Accept-Language": language },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }

  it.each(["/", "/game/367520"])("serves %s in the language each caller asked for", async (path) => {
    // Spanish first, so that if anything pools the two, English gets the
    // Spanish copy - which is the direction the bug actually takes.
    const spanish = await (await fetchIn("es-ES,es;q=0.9", path)).text();
    const english = await (await fetchIn("en-US,en;q=0.9", path)).text();

    expect(spanish).toContain(DICTIONARY.es["hero.title"]!);
    expect(english).toContain(DICTIONARY.en["hero.title"]!);
    expect(english).not.toContain(DICTIONARY.es["hero.title"]!);
  });

  it("does not hand the two languages the same ETag", async () => {
    // The body is rewritten but the headers are inherited from the asset, so
    // without care both languages ship the validator of the untranslated file.
    // A browser holding the English copy would then revalidate, be told 304,
    // and keep showing English on a page it just asked for in Spanish.
    const spanish = (await fetchIn("es-ES", "/")).headers.get("ETag");
    const english = (await fetchIn("en-US", "/")).headers.get("ETag");
    if (spanish === null && english === null) return;
    expect(spanish).not.toBe(english);
  });

  it.each(["/", "/game/367520"])("does not let a shared cache pool the two for %s", async (path) => {
    const response = await fetchIn("es-ES", path);
    const control = response.headers.get("Cache-Control") ?? "";
    expect(control, `${path} is publicly cacheable in one language`).toMatch(/private|no-store/);
  });
});

describe("pageCacheKey", () => {
  it("varies by language", () => {
    // The test pool does not exercise `caches.default`, so nothing above would
    // notice this key losing its language - it would simply start serving one
    // reader's language to the next, in production only.
    expect(pageCacheKey(367520, "es")).not.toBe(pageCacheKey(367520, "en"));
  });

  it("varies by game", () => {
    expect(pageCacheKey(367520, "en")).not.toBe(pageCacheKey(1245620, "en"));
  });

  it("is stable for the same pair", () => {
    expect(pageCacheKey(367520, "es")).toBe(pageCacheKey(367520, "es"));
  });
});

/**
 * The two rewrites, one after the other.
 *
 * `gamePage` calls `describeGame(localise(shell, language), …)`, so two separate
 * regex passes touch the same document. Each is tested alone elsewhere; this is
 * about whether the first leaves the second anything it can still match.
 */
describe("localise then describeGame", () => {
  const GAME = {
    appId: 367520,
    name: "Hollow Knight",
    headerImage: "https://shared.cloudflare.steamstatic.com/x/header.jpg",
    achievements: [],
    total: 63,
    unlockedCount: null,
  };
  const PAGE = "https://howtoachieve.cloudils.com/game/367520";

  it.each(["en", "es"])("still rewrites every preview tag after translating to %s", (language) => {
    const { html, missed } = describeGame(localise(shell, language), GAME, PAGE);

    // `missed` is the whole point: it names any tag the second pass could not
    // find, which is exactly what a first pass would break.
    expect(missed, `translating to ${language} hid tags from describeGame`).toEqual([]);
    expect(html).toContain(`<meta property="og:url" content="${PAGE}" />`);
    expect(html).toContain("Hollow Knight — achievements and how to earn them");
    expect([...html.matchAll(/<meta property="og:image" content="/g)]).toHaveLength(1);
  });

  it("keeps the translation after the second pass", () => {
    const { html } = describeGame(localise(shell, "es"), GAME, PAGE);
    expect(html).toContain(DICTIONARY.es["hero.title"]!);
    expect(html).toMatch(/<html[^>]*\slang="es"/);
  });

  it("leaves the shared-link description in English in both", () => {
    // Deliberate, and worth pinning: the card describes the game, is written by
    // `describeGame` from Steam data, and is not part of the interface.
    for (const language of ["en", "es"]) {
      const { html } = describeGame(localise(shell, language), GAME, PAGE);
      expect(html).toContain("All 63 achievements in Hollow Knight");
    }
  });
});

describe("translating a document keeps its security headers", () => {
  it.each(["/", "/privacy"])("%s still carries what _headers gives it", async (path) => {
    // `translated()` builds a new Response around the rewritten body. Header
    // inheritance is what keeps `_headers` applied, and it is the sort of thing
    // a later refactor drops without noticing - #58 is open about exactly this
    // class of loss on Worker-built responses.
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://howtoachieve.cloudils.com${path}`, { headers: { "Accept-Language": "es-ES" } }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    for (const header of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Cross-Origin-Opener-Policy",
      "Permissions-Policy",
    ]) {
      expect(response.headers.get(header), `${path} lost ${header}`).not.toBeNull();
    }
  });
});
