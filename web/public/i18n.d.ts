/**
 * Types for the shared dictionary.
 *
 * `i18n.js` is plain JavaScript because the browser loads it directly and this
 * project has no build step. Inference from the literal alone gives each key
 * its own type, which makes indexing by a variable an error in both the Worker
 * and the tests — so the shape is declared once here instead.
 */

export type Language = "en" | "es";

export type Table = Record<string, string>;

export declare const DEFAULT_LANGUAGE: Language;
export declare const LANGUAGES: Language[];
export declare const DICTIONARY: Record<Language, Table>;

/** One string, with `{placeholders}` filled in. Falls back to English. */
export declare function t(
  language: string,
  key: string,
  values?: Record<string, string | number>,
): string;

/** The stored choice if there is one, otherwise what the browser asked for. */
export declare function pickLanguage(acceptLanguage: string, stored: string | null): Language;

/** The best supported language named by an `Accept-Language` header. */
export declare function fromAcceptLanguage(header: string): Language;

/** Translates a document, or part of one, in place. */
export declare function translate(root: ParentNode, language: string): void;
