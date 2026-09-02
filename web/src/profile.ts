/**
 * Turning whatever someone has into a SteamID64.
 *
 * The profile panel asked for a "SteamID64 (17 digits)". Almost nobody knows
 * theirs, Steam does not show it anywhere obvious, and the usual answer is to
 * visit a third-party site to look it up — a hostile first step for the one
 * feature that personalises the page.
 *
 * So the parsing lives here, apart from the network call, because deciding what
 * someone pasted is pure and worth testing exhaustively, while asking Steam
 * about it is neither.
 */

/** Steam's own format: 17 digits, and the only thing that needs no lookup. */
const STEAM_ID64 = /^\d{17}$/;

/**
 * A custom URL, as Steam allows it.
 *
 * Steam permits letters, digits, underscores and hyphens, between 2 and 32
 * characters. Bounded here rather than upstream: an unbounded parameter
 * forwarded to Steam is free amplification against a quota this project cannot
 * afford to lose, which is the same reason the search route has a ceiling.
 */
const VANITY = /^[A-Za-z0-9_-]{2,32}$/;

/** Longer than any input this accepts, so a huge paste is refused early. */
export const MAX_INPUT = 200;

export type Parsed =
  | { kind: "id"; value: string }
  | { kind: "vanity"; value: string }
  | { kind: "invalid"; reason: string };

/**
 * What someone pasted, as far as it can be told without asking Steam.
 *
 * Accepts the things people actually have to hand: a profile URL of either
 * shape, with or without a scheme or a trailing slash, and the bare id or name
 * on its own.
 */
export function parseProfile(input: string): Parsed {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "invalid", reason: "empty" };
  if (trimmed.length > MAX_INPUT) return { kind: "invalid", reason: "too long" };

  // A URL, however it was written. Matching on the path rather than parsing the
  // whole thing keeps `steamcommunity.com/id/x` working, which is what people
  // copy out of the address bar as often as the full URL.
  const path = /(?:^|\/)(id|profiles)\/([^/?#\s]+)/.exec(trimmed);
  if (path) {
    const [, kind, raw] = path;
    const value = decodeURIComponentSafely(raw!);
    if (value === null) return { kind: "invalid", reason: "unreadable" };
    // `/profiles/` carries the id and `/id/` carries the custom name, but a URL
    // is typed by hand often enough that the shape of the value is trusted over
    // the path that framed it.
    if (STEAM_ID64.test(value)) return { kind: "id", value };
    if (kind === "profiles") return { kind: "invalid", reason: "not an id" };
    return VANITY.test(value) ? { kind: "vanity", value } : { kind: "invalid", reason: "not a name" };
  }

  // Anything else has to be the id or the name on its own. A URL that got this
  // far is one this does not understand, and guessing at it would be worse than
  // saying so.
  if (/[/\\?#]/.test(trimmed) || trimmed.includes(".")) {
    return { kind: "invalid", reason: "unrecognised link" };
  }
  if (STEAM_ID64.test(trimmed)) return { kind: "id", value: trimmed };

  // All digits, but the wrong length. Steam does allow a numeric custom URL, so
  // this is not impossible — but someone typing sixteen digits into a box
  // labelled SteamID64 has miscounted, and saying so is worth far more than
  // honouring a case that essentially never happens. Pasting the profile URL
  // still resolves a genuinely numeric name, because `/id/` says what it is.
  if (/^\d+$/.test(trimmed)) return { kind: "invalid", reason: "wrong length for an id" };

  if (VANITY.test(trimmed)) return { kind: "vanity", value: trimmed };

  return { kind: "invalid", reason: "neither an id nor a name" };
}

/** `decodeURIComponent` throws on a malformed escape; a bad paste is not a 500. */
function decodeURIComponentSafely(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
