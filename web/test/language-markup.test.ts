/**
 * `localise` against markup that is legal but awkward.
 *
 * It rewrites HTML with regular expressions, so the interesting question is not
 * whether it handles the shipped shell — the other file covers that — but what
 * it does to valid markup nobody wrote yet. One of these found a real fault:
 * a `>` inside an attribute value ended the tag early and the rewrite ate the
 * rest of it.
 */

import { describe, expect, it } from "vitest";
import { localise } from "../src/language.ts";
import { DICTIONARY } from "../public/i18n.js";

describe("adversarial input", () => {
  it.each([
    ["attribute order reversed", '<p data-i18n="footer.privacy" class="foo">Privacy</p>'],
    ["marker last", '<p class="foo" data-i18n="footer.privacy">Privacy</p>'],
    ["uppercase tag", '<P data-i18n="footer.privacy">Privacy</P>'],
    ["greater-than inside another attribute", '<p data-i18n="footer.privacy" title="a > b">Privacy</p>'],
    ["quote-ish content", '<p data-i18n="footer.privacy">a "b" c</p>'],
  ])("%s: translates and leaves the tag intact", (_name, html) => {
    const out = localise(html, "es");
    expect(out, "lost the translation").toContain(DICTIONARY.es["footer.privacy"]);
    // Nothing outside the text node may change.
    const attrs = [...html.matchAll(/(\w[\w-]*)="([^"]*)"/g)].map((m) => m[0]);
    for (const a of attrs) expect(out, `mangled ${a}`).toContain(a);
    expect(out.match(/<\/p>/gi) ?? [], "duplicated or lost the close tag").toHaveLength(1);
  });

  it("void element attribute marker", () => {
    const out = localise('<img data-i18n-alt="profile.prompt" alt="profile" src="x.png">', "es");
    expect(out).toContain('src="x.png"');
    expect(out).toMatch(/alt="Tu perfil/);
  });

  it("two attribute markers on one tag", () => {
    const out = localise(
      '<input data-i18n-placeholder="search.placeholder" data-i18n-aria-label="search.results" placeholder="x" aria-label="y">',
      "es",
    );
    expect(out).toContain(`placeholder="${DICTIONARY.es["search.placeholder"]}"`);
    expect(out).toContain(`aria-label="${DICTIONARY.es["search.results"]}"`);
  });

  it("text and attribute markers on one tag", () => {
    const out = localise('<div id="x" data-i18n="footer.privacy" data-i18n-title="footer.terms" title="t">Privacy</div>', "es");
    expect(out).toContain(DICTIONARY.es["footer.privacy"]);
    expect(out).toContain(`title="${DICTIONARY.es["footer.terms"]}"`);
    expect(out).toContain('id="x"');
  });

  it("nested markers translate the inner one and leave the outer alone", () => {
    const out = localise('<div data-i18n="footer.privacy"><span data-i18n="footer.terms">Terms</span></div>', "es");
    expect(out).toContain(DICTIONARY.es["footer.terms"]);
    expect(out).toContain("<span");
  });

  it("self-closing syntax is left alone rather than half-rewritten", () => {
    const html = '<span data-i18n="footer.privacy" />after';
    expect(localise(html, "es")).toBe(html);
  });
});

/**
 * These patterns know nothing of JavaScript or CSS, so a marker written inside
 * a script or a style - in a string, or a comment - would be rewritten as
 * though it were markup. The shell carries a JSON-LD block, so they skip both.
 */
describe("script and style content is not markup", () => {
  it.each(["script", "style"])("leaves a marker inside a %s alone", (tag) => {
    const block = `<${tag}>"<span data-i18n="footer.terms">Terms</span>"</${tag}>`;
    expect(localise(`<p data-i18n="footer.privacy">Privacy</p>${block}`, "es")).toBe(
      `<p data-i18n="footer.privacy">${DICTIONARY.es["footer.privacy"]}</p>${block}`,
    );
  });

  it("still translates what follows the block", () => {
    const out = localise('<script type="application/ld+json">{}</script><p data-i18n="footer.terms">Terms</p>', "es");
    expect(out).toContain(DICTIONARY.es["footer.terms"]);
  });
});
