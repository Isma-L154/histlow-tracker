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
export function problem(
  status: number,
  message: string,
  reason?: string,
  headers?: Record<string, string>,
): Response {
  // `error` is prose for any caller; `reason` is a code for this site's own
  // client, which has to say the same thing in two languages and cannot
  // translate a sentence. Callers that have nothing more specific than the
  // status omit it.
  //
  // `headers` exists for the one failure worth caching: a profile name Steam
  // has never heard of is a stable answer, and re-asking spends the API key.
  return json({ error: message, ...(reason ? { reason } : {}) }, { status, ...(headers ? { headers } : {}) });
}

/**
 * Logs a failure with any credential stripped out.
 *
 * Steam takes its API key as a query parameter, so a thrown error that quotes
 * the URL it was fetching would carry the key into the Worker's logs. Nothing
 * here reaches the browser - this is about not leaving the secret sitting in
 * an observability dashboard.
 */
export function logFailure(context: string, error: unknown): void {
  const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(context, rendered.replace(/([?&](?:key|token|steamid)=)[^&\s"']+/gi, "$1<redacted>"));
}
