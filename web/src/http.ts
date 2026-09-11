/**
 * Response and logging helpers.
 *
 * Kept out of the entry module: the runtime treats every named export there as
 * a handler and refuses to start, and `wrangler deploy --dry-run` does not catch it.
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
 * An error in plain English, for callers outside the site's own client. Never
 * quotes a credential or an upstream body.
 */
export function problem(status: number, message: string, headers?: Record<string, string>): Response {
  return json({ error: message }, { status, ...(headers ? { headers } : {}) });
}

/**
 * An error the client can show in the reader's language.
 *
 * The prose comes from the dictionary the browser uses. There is no `message`
 * parameter on purpose: a second copy of the wording is what drifted before.
 */
export function known(status: number, reason: string, headers?: Record<string, string>): Response {
  const message = DICTIONARY[DEFAULT_LANGUAGE][reason];
  return json(
    { error: message ?? reason, reason },
    { status, ...(headers ? { headers } : {}) },
  );
}

/**
 * Query parameters whose values are safe to log. Everything else is redacted,
 * so a new upstream's credential is hidden by default rather than leaked.
 */
const LOGGABLE = new Set(["appid", "appids", "gameid", "steamids", "l", "filters", "format", "browsefilter"]);

function redactQuery(text: string): string {
  return text.replace(/([?&])([\w.-]+)=[^&\s"']*/g, (whole, lead: string, name: string) =>
    LOGGABLE.has(name.toLowerCase()) ? whole : `${lead}${name}=<redacted>`,
  );
}

/** Logs a failure with every query value that could be a credential stripped out. */
export function logFailure(context: string, error: unknown): void {
  const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(context, redactQuery(rendered));
}
