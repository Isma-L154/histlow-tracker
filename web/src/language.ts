/**
 * The interface language, decided before the HTML leaves.
 *
 * Setting `lang` alone would not be enough. The shell ships English text, so a
 * Spanish reader would see English paint and then watch it change - which is
 * the thing the client cannot fix, because by the time a script runs the frame
 * is already on screen. Substituting here means the first paint is right.
 *
 * The dictionary is the same file the browser imports. Two copies of these
 * strings would drift, and the drift would show up as one English word on a
 * Spanish page that nobody testing in English would ever see.
 */

// Plain JS, because the browser loads the same file directly. Its shape is
// declared in the sibling `i18n.d.ts`.
import { DICTIONARY, fromAcceptLanguage, t } from "../public/i18n.js";

/** Languages the site has, which is what `Vary` has to account for. */
export const SUPPORTED: readonly string[] = Object.keys(DICTIONARY);

/**
 * Which language a request is asking for.
 *
 * Only the header. A reader who has chosen is honoured by the client, which
 * knows about `localStorage` and this does not - and keeping the choice out of
 * a cookie is what keeps this response cacheable at the edge for everyone who
 * has not chosen.
 */
export function languageFor(request: Request): string {
  return fromAcceptLanguage(request.headers.get("Accept-Language") ?? "");
}

/** Attribute markers the client also understands, kept in step deliberately. */
const ATTRIBUTES = ["placeholder", "aria-label", "title", "alt"];

/**
 * Rewrites a shell into one language.
 *
 * Matches the same `data-i18n` markers the client uses, so the markup declares
 * what is translatable exactly once and both sides read that declaration rather
 * than a list either of them keeps.
 *
 * The markers stay in the output. They are what lets the client retranslate on
 * a toggle without a reload, and they are three characters each.
 */
export function localise(html: string, language: string): string {
  // A document with nothing marked is not translatable, and its declared
  // language is therefore already correct. The privacy and terms pages are
  // written in English: stamping `lang="es"` on them because the reader's
  // browser asked for Spanish would make a screen reader pronounce English with
  // Spanish phonetics, and tell a search engine the wrong thing besides.
  if (!html.includes("data-i18n")) return html;

  let out = html.replace(
    /(<html[^>]*\slang=")[^"]*(")/,
    (_whole, before: string, after: string) => `${before}${language}${after}`,
  );

  // Text nodes. The pattern is deliberately narrow: it rewrites only between
  // the tag that carries the marker and its matching close, and refuses to
  // cross another tag boundary, so a marker on an element with children is left
  // alone rather than silently eating them.
  out = out.replace(
    /(<([a-z0-9]+)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/gi,
    (whole, open: string, _tag: string, key: string, _text: string, close: string) => {
      const value = t(language, key);
      return value === "" ? whole : `${open}${escapeText(value)}${close}`;
    },
  );

  for (const attribute of ATTRIBUTES) {
    const marker = `data-i18n-${attribute}`;
    // Rewrites the attribute in place wherever it already exists on the same
    // tag. An element marked for an attribute it does not have is left alone:
    // inventing one here would put it in a different order than the client
    // would, and the two outputs have to agree.
    out = out.replace(
      new RegExp(`<[a-z0-9]+\\b[^>]*\\s${marker}="([^"]+)"[^>]*>`, "gi"),
      (tag: string, key: string) => {
        const value = t(language, key);
        if (value === "") return tag;
        return tag.replace(
          new RegExp(`(\\s${attribute}=")[^"]*(")`, "i"),
          (_whole, before: string, after: string) => `${before}${escapeAttribute(value)}${after}`,
        );
      },
    );
  }

  return out;
}

/** These strings are ours, but they contain apostrophes and accents. */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
