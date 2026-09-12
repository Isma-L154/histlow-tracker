/**
 * Turning whatever someone pastes into a SteamID64.
 *
 * Almost nobody knows their SteamID64, so a profile link of any shape is
 * accepted. Pure, so it can be tested exhaustively; asking Steam happens elsewhere.
 */

const STEAM_ID64 = /^\d{17}$/;

/** A custom URL as Steam allows it, bounded so an oversized input never reaches Steam. */
const VANITY = /^[A-Za-z0-9_-]{2,32}$/;

/** Longer than any input accepted, so a huge paste is refused early. */
export const MAX_INPUT = 200;

type Parsed =
  | { kind: "id"; value: string }
  | { kind: "vanity"; value: string }
  | { kind: "invalid"; reason: string };

/** A profile URL of either shape, with or without a scheme, or a bare id or name. */
export function parseProfile(input: string): Parsed {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "invalid", reason: "empty" };
  if (trimmed.length > MAX_INPUT) return { kind: "invalid", reason: "too long" };

  // Matched on the path, so `steamcommunity.com/id/x` works without a scheme.
  const path = /(?:^|\/)(id|profiles)\/([^/?#\s]+)/.exec(trimmed);
  if (path) {
    const [, kind, raw] = path;
    const value = decodeURIComponentSafely(raw!);
    if (value === null) return { kind: "invalid", reason: "unreadable" };
    // The value's shape is trusted over the path around it: URLs get typed by hand.
    if (STEAM_ID64.test(value)) return { kind: "id", value };
    if (kind === "profiles") return { kind: "invalid", reason: "not an id" };
    return VANITY.test(value) ? { kind: "vanity", value } : { kind: "invalid", reason: "not a name" };
  }

  // Anything left must be a bare id or name; guessing at an unknown link would be worse.
  if (/[/\\?#]/.test(trimmed) || trimmed.includes(".")) {
    return { kind: "invalid", reason: "unrecognised link" };
  }
  if (STEAM_ID64.test(trimmed)) return { kind: "id", value: trimmed };

  // Steam allows a numeric custom URL, but sixteen digits in a SteamID64 box is
  // a miscount far more often. A numeric name still resolves through its `/id/` link.
  if (/^\d+$/.test(trimmed)) return { kind: "invalid", reason: "wrong length for an id" };

  if (VANITY.test(trimmed)) return { kind: "vanity", value: trimmed };

  return { kind: "invalid", reason: "neither an id nor a name" };
}

/**
 * The SteamID64 a request asks to be answered as, if any. This decides whether an
 * answer is personal, and so bypasses the cache; the id is trusted only for shape.
 */
export function resolveSteamId(requested: string | null, fallback: string | undefined): string | null {
  const candidate = requested ?? fallback ?? "";
  return STEAM_ID64.test(candidate) ? candidate : null;
}

/** `decodeURIComponent` throws on a malformed escape; a bad paste is not a 500. */
function decodeURIComponentSafely(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
