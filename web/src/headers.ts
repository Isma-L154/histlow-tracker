/**
 * The site's security headers on responses the Worker builds itself.
 *
 * `public/_headers` stays the only list: the asset runtime applies it to static
 * files, and this copies what it applied onto Worker-built responses. A second
 * list in TypeScript would drift silently, and the drift would be
 * security-relevant. Adding a header to `_headers` needs no change here.
 */

import { logFailure } from "./http.ts";

/** Headers that describe one response rather than the site, and so are never copied. */
export const ENTITY = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-range",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "age",
  "date",
  "vary",
  "accept-ranges",
  "transfer-encoding",
  "connection",
  "location",
  "set-cookie",
  "cf-cache-status",
  // A non-ok reference response can carry these; they must never become site-wide.
  "retry-after",
  "allow",
  "content-disposition",
  "content-location",
  "link",
  "server-timing",
]);

/**
 * The floor. A reference response missing these - a 404, or `_headers` no longer
 * applied - is not the site's policy, and must not read as "nothing to add".
 */
const REQUIRED = ["content-security-policy", "x-content-type-options"];

/** The file the policy is read from: always present, since the SPA fallback is built on it. */
const REFERENCE = "/index.html";

/** The site-wide headers in a response, or null when it carries no policy. */
export function policyFrom(headers: Headers): Map<string, string> | null {
  const policy = new Map<string, string>();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!ENTITY.has(lower)) policy.set(lower, value);
  }

  const absent = REQUIRED.filter((name) => !policy.get(name));
  return absent.length === 0 ? policy : null;
}

/**
 * Remembered for the isolate's life: `_headers` only changes with a deploy, and
 * a deploy starts new isolates. Only a usable policy is kept, so one bad fetch at
 * startup cannot leave the isolate unprotected until the next deploy.
 */
let remembered: Map<string, string> | null = null;

let reported = false;

async function sitePolicy(env: Env, origin: string): Promise<Map<string, string>> {
  if (remembered) return remembered;

  const asset = await env.ASSETS.fetch(new Request(new URL(REFERENCE, origin)));
  if (!asset.ok) throw new Error(`${REFERENCE} answered ${asset.status}`);

  const policy = policyFrom(asset.headers);
  if (!policy) {
    throw new Error(`${REFERENCE} carries no policy (${[...asset.headers.keys()].join(", ") || "no headers"})`);
  }

  remembered = policy;
  return policy;
}

/**
 * The response with any site-wide header it lacks, never overwriting one a route
 * set. Cannot throw: it runs on every response, and a failure here would cost
 * the page rather than only the policy.
 */
export async function secured(response: Response, env: Env, origin: string): Promise<Response> {
  try {
    const policy = await sitePolicy(env, origin);

    const missing = [...policy].filter(([name]) => !response.headers.has(name));
    if (missing.length === 0) return response;

    // Headers from a fetch or from `Response.redirect` are immutable; copying is the only way in.
    const out = new Response(response.body, response);
    for (const [name, value] of missing) out.headers.set(name, value);
    return out;
  } catch (error) {
    // A page without a policy beats no page. Logged once per isolate; the fetch
    // is still retried on every request, so a blip recovers on its own.
    if (!reported) {
      reported = true;
      logFailure("serving without the site's security policy", error);
    }
    return response;
  }
}
