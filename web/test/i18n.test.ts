/**
 * The two-language interface.
 *
 * The parity tests are the point of this file. A missing Spanish string is
 * invisible in review, invisible in the diff, and only shows up as a stray
 * English word on a Spanish page that nobody on the team reads - so it has to
 * fail CI instead.
 */

import { describe, expect, it } from "vitest";
import index from "../public/index.html?raw";
import { DICTIONARY, LANGUAGES, fromAcceptLanguage, pickLanguage, t } from "../public/i18n.js";

/** Every key the shipped HTML asks for, by the attribute that asks. */
function keysUsedInMarkup(): string[] {
  const markers = [...index.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)];
  return [...new Set(markers.map((m) => m[1]!))];
}

describe("the dictionary", () => {
  it("has the same keys in every language", () => {
    const [reference, ...others] = LANGUAGES.map((language) => Object.keys(DICTIONARY[language]).sort());
    for (const [index_, keys] of others.entries()) {
      const language = LANGUAGES[index_ + 1]!;
      expect(keys.filter((k) => !reference!.includes(k)), `${language} has keys English does not`).toEqual([]);
      expect(reference!.filter((k) => !keys.includes(k)), `${language} is missing keys`).toEqual([]);
    }
  });

  it("leaves no string untranslated by accident", () => {
    // Identical strings are legitimate for a proper noun, so this lists the
    // ones allowed to match rather than forbidding matches outright.
    const allowed = new Set(["search.placeholder"]);
    const same = Object.keys(DICTIONARY.en).filter(
      (key) => !allowed.has(key) && DICTIONARY.en[key] === DICTIONARY.es[key],
    );
    expect(same).toEqual([]);
  });

  it("keeps the same placeholders on both sides", () => {
    // A translation that drops `{total}` renders the literal word, and one that
    // invents `{totals}` renders the braces. Neither throws.
    for (const key of Object.keys(DICTIONARY.en)) {
      const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(placeholders(DICTIONARY.es[key]!), `placeholders differ for ${key}`).toEqual(
        placeholders(DICTIONARY.en[key]!),
      );
    }
  });
});

describe("the markup and the dictionary agree", () => {
  it("asks for no key that does not exist", () => {
    const missing = keysUsedInMarkup().filter((key) => !(key in DICTIONARY.en));
    expect(missing, "index.html marks keys the dictionary does not have").toEqual([]);
  });

  it("marks something for translation at all", () => {
    // Guards the guard: if the attribute were ever renamed, every assertion
    // above would pass against an empty list.
    expect(keysUsedInMarkup().length).toBeGreaterThan(10);
  });
});

describe("t", () => {
  it("fills placeholders", () => {
    expect(t("en", "game.progress", { unlocked: 3, total: 7 })).toBe("3 of 7 achievements");
    expect(t("es", "game.progress", { unlocked: 3, total: 7 })).toBe("3 de 7 logros");
  });

  it("leaves a placeholder alone when nothing was given for it", () => {
    expect(t("en", "game.progress", { unlocked: 3 })).toContain("{total}");
  });

  it("falls back to English rather than to the key", () => {
    // A reader seeing a slightly wrong language is recoverable. A reader seeing
    // `game.progress` is not.
    expect(t("de" as "en", "filters.all")).toBe("All");
  });

  it("returns empty for a key nobody defined", () => {
    expect(t("en", "no.such.key")).toBe("");
  });
});

describe("pickLanguage", () => {
  it("lets an explicit choice win over the browser", () => {
    // Someone who picked English on a Spanish laptop meant it, and re-deciding
    // on every visit would be a bug they cannot work around.
    expect(pickLanguage("es-ES,es;q=0.9", "en")).toBe("en");
    expect(pickLanguage("en-US,en;q=0.9", "es")).toBe("es");
  });

  it("ignores a stored value that is not a language we have", () => {
    expect(pickLanguage("es-ES", "fr")).toBe("es");
    expect(pickLanguage("es-ES", null)).toBe("es");
  });
});

describe("fromAcceptLanguage", () => {
  it.each([
    ["es-ES,es;q=0.9,en;q=0.8", "es"],
    ["en-US,en;q=0.9", "en"],
    ["es-419,es;q=0.9", "es"],
    ["ES-es", "es"],
    ["fr-FR,de;q=0.9", "en"],
    ["", "en"],
    ["   ", "en"],
    ["*", "en"],
  ])("reads %s as %s", (header, expected) => {
    expect(fromAcceptLanguage(header)).toBe(expected);
  });

  it("honours quality values over order", () => {
    // `en;q=0.8, es` means Spanish however it is written, and reading left to
    // right would get it backwards.
    expect(fromAcceptLanguage("en;q=0.8, es")).toBe("es");
    expect(fromAcceptLanguage("es;q=0.2, en;q=0.9")).toBe("en");
  });

  it("ignores a language explicitly refused", () => {
    expect(fromAcceptLanguage("es;q=0, en")).toBe("en");
  });

  it.each([undefined, null, 42, {}])("survives %s instead of a header", (header) => {
    expect(fromAcceptLanguage(header as string)).toBe("en");
  });
});
