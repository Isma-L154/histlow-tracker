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
import shell from "../public/index.html?raw";

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
    const out = localise('<img data-i18n-alt="game.cover" alt="cover" src="x.png">', "es");
    expect(out).toContain('src="x.png"');
    expect(out).toMatch(/alt="Portada/);
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
 * The assumption that makes the rest of this safe.
 *
 * These patterns do not know about `<script>` or `<style>`, so a marker written
 * inside one - in a string, or a comment - would be rewritten as though it were
 * markup. There is no inline script or style in the shell, and the CSP forbids
 * inline script anyway, so this cannot happen today. Pinning it means the day
 * someone adds one, this says so rather than the page quietly breaking.
 */
describe("the shell has no inline script or style for the patterns to walk into", () => {
  it.each([
    ["script", /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/i],
    ["style", /<style[^>]*>[\s\S]*?<\/style>/i],
  ])("contains no inline %s", (_name, pattern) => {
    expect(pattern.test(shell), "add script/style skipping to localise first").toBe(false);
  });
});
