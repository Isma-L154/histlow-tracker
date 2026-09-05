/**
 * Response helpers.
 *
 * These live outside the entrypoint on purpose. The Workers runtime treats
 * every named export of the entry module as a handler or binding, so exporting
 * a helper - or even a version string - from `index.ts` fails at startup with
 * "the provided value is not of type 'function or ExportedHandler'". Notably
 * `wrangler deploy --dry-run` does not catch that; only starting the runtime
 * does.
 */

import { DEFAULT_LANGUAGE, DICTIONARY } from "../public/i18n.js";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
} as const;

export const VERSION = "0.1.0";

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...init.headers },
  });
}

/**
 * An error response carrying a message meant for a person to read.
 *
 * Messages are written to be safe in a public response: they never quote a
 * credential and never repeat an upstream body verbatim.
 */
export function problem(status: number, message: string, headers?: Record<string, string>): Response {
  // Prose for any caller, and nothing the site's own client can translate. The
  // client falls back to a table keyed on the status for these, which is why
  // they are the ones with no better answer than their status: a 405, a route
  // that matches nothing, a failure nobody can name.
  //
  // `headers` exists for the one failure worth caching: a profile name Steam
  // has never heard of is a stable answer, and re-asking spends the API key.
  return json({ error: message }, { status, ...(headers ? { headers } : {}) });
}

/**
 * An error the client can say in the reader's own language.
 *
 * The prose is not written here. It is looked up from the same dictionary the
 * browser uses, because writing it at the call site meant writing it twice -
 * and all three places that did had already drifted:
 *
 *   index.ts   "Too many lookups. …"              profile.tooMany  "Too many profile lookups. …"
 *   steam.ts   "Steam does not know that name."   profile.unknown  "… Check it, or paste your link."
 *   index.ts   PROFILE_PROBLEMS, seven entries, a second copy of profile.* in TypeScript
 *
 * Both copies ship: a caller that is not this browser reads the prose. So the
 * two could disagree about what happened and nothing would say so.
 *
 * There is no `message` parameter, which is the point - the duplication is
 * gone rather than guarded. A key with no entry falls back to the key itself
 * and is caught by a test rather than shipped, because a caller reading
 * `profile.tooMany` as a sentence is worse than a clumsy one.
 */
export function known(status: number, reason: string, headers?: Record<string, string>): Response {
  const message = DICTIONARY[DEFAULT_LANGUAGE][reason];
  return json(
    { error: message ?? reason, reason },
    { status, ...(headers ? { headers } : {}) },
  );
}

/**
 * Logs a failure with any credential stripped out.
 *
 * Steam takes its API key as a query parameter, so a thrown error that quotes
 * the URL it was fetching would carry the key into the Worker's logs. Nothing
 * here reaches the browser - this is about not leaving the secret sitting in
 * an observability dashboard.
 */
/**
 * Parameter names whose values are safe to keep in a log.
 *
 * An allowlist of what to *redact* fails open: the day a new upstream takes a
 * differently-named credential, it is logged in clear until somebody notices.
 * That is what happened here - the filter covered `key`, `token` and `steamid`,
 * and IGDB authenticates with `client_id` and `client_secret`.
 *
 * So everything is redacted except the handful of parameters that are worth
 * having in a log and cannot be a secret.
 */
const LOGGABLE = new Set(["appid", "appids", "gameid", "steamids", "l", "filters", "format", "browsefilter"]);

/** Strips the value from every query parameter that is not known to be safe. */
function redactQuery(text: string): string {
  return text.replace(/([?&])([\w.-]+)=[^&\s"']*/g, (whole, lead: string, name: string) =>
    LOGGABLE.has(name.toLowerCase()) ? whole : `${lead}${name}=<redacted>`,
  );
}

/**
 * Whether a response should go in the edge cache.
 *
 * Extracted so it can be asserted. The test pool does not exercise
 * `caches.default`, so a rule that quietly stopped honouring `no-store` would
 * pass every test and cache the very responses written to avoid it - which is
 * exactly what happened, and was only found by review.
 *
 * The producer wins in both directions. Most failures are transient and must
 * not be cached, so success is the default; but a stable failure - "Steam has
 * never heard of that name" - carries its own lifetime and is worth keeping,
 * and a response marked `no-store` means it.
 */
export function storable(cacheControl: string | null, ok: boolean): boolean {
  if (cacheControl?.includes("no-store")) return false;
  return ok || cacheControl !== null;
}

export function logFailure(context: string, error: unknown): void {
  const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(context, redactQuery(rendered));
}
