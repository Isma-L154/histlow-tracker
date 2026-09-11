/**
 * The interface language, decided before the HTML leaves.
 *
 * The shell ships English, and by the time a client script runs the first frame
 * is already painted, so a Spanish reader would watch it change. Translating
 * here makes the first paint right. The dictionary is the file the browser
 * imports, so the two sides cannot drift.
 */

import { ATTRIBUTES, fromAcceptLanguage, t } from "../public/i18n.js";

/**
 * Which language a request asks for. Only the header: a reader's explicit choice
 * lives in the client's `localStorage`, which keeps this response cacheable.
 */
export function languageFor(request: Request): string {
  return fromAcceptLanguage(request.headers.get("Accept-Language") ?? "");
}

/**
 * The inside of a tag, up to its closing bracket. Quote-aware, because a `>` is
 * legal inside an attribute value and `[^>]*` would end the tag early.
 */
const WITHIN_TAG = `(?:"[^"]*"|'[^']*'|[^>"'])*`;

/**
 * Rewrites a shell into one language, matching the `data-i18n` markers the
 * client reads. The markers stay, so the client can retranslate on a toggle.
 */
export function localise(html: string, language: string): string {
  // An unmarked document (privacy, terms) is English and keeps `lang="en"`, or a
  // screen reader would pronounce it with Spanish phonetics.
  if (!html.includes("data-i18n")) return html;

  let out = html.replace(
    /(<html[^>]*\slang=")[^"]*(")/,
    (_whole, before: string, after: string) => `${before}${language}${after}`,
  );

  // Only between the marked tag and its close, never across another tag, so a
  // marker on an element with children cannot eat them.
  out = out.replace(
    new RegExp(`(<([a-z0-9]+)\\b${WITHIN_TAG}\\sdata-i18n="([^"]+)"${WITHIN_TAG}>)([^<]*)(</\\2>)`, "gi"),
    (whole, open: string, _tag: string, key: string, _text: string, close: string) => {
      const value = t(language, key);
      return value === "" ? whole : `${open}${escapeText(value)}${close}`;
    },
  );

  for (const attribute of ATTRIBUTES) {
    const marker = `data-i18n-${attribute}`;
    // Only an attribute the tag already has is rewritten, in place, so the
    // output matches what the client produces.
    out = out.replace(
      new RegExp(`<[a-z0-9]+\\b${WITHIN_TAG}\\s${marker}="([^"]+)"${WITHIN_TAG}>`, "gi"),
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

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/**
 * Where a rendered game page is cached. The language is in the key because
 * Cloudflare's cache ignores `Vary: Accept-Language`.
 */
export function pageCacheKey(appId: number, language: string): string {
  return `https://page.invalid/game/v2/${appId}/${language}`;
}
