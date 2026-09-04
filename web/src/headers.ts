/**
 * Giving a Worker-built response the protection the static side already has.
 *
 * `public/_headers` is read by the asset runtime, so every file it serves
 * carries the site's Content-Security-Policy, HSTS and the rest. A response
 * built in Worker code never passes through it. That left `/game/<id>` with no
 * policy at all - the one document here assembled by hand, out of a game name
 * written by a developer and relayed by Steam, and so the one document where a
 * policy would actually be doing something.
 *
 * The obvious fix is to write the headers out a second time in TypeScript.
 * That is two lists, in two files, in two formats, that must agree - and the
 * day they stop agreeing nothing says so, because each file is internally
 * consistent and only the pair is wrong. The drift would be silent and it
 * would be security-relevant, which is the worst combination.
 *
 * So there is still one list, and it is still `_headers`: the asset binding
 * applies it, measured, so asking the binding for any file returns the site's
 * policy already assembled. This copies it onto responses that did not come
 * that way. Adding a header to `_headers` needs no change here.
 */

import { logFailure } from "./http.ts";

/**
 * Headers that describe one particular response and cannot be carried to
 * another. Everything else the asset runtime attaches is site-wide by
 * definition - a rule in `_headers` is written per path, never per response -
 * so an exclusion list keeps this from needing to know what those rules say.
 */
const ENTITY = new Set([
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
]);

/**
 * The file asked for when reading the site's policy.
 *
 * The shell, because it is the one asset guaranteed to exist - the SPA
 * fallback is built on it. `_headers` currently carries a single `/*` rule, so
 * any file would answer the same; if it ever grows a per-path rule, what this
 * reads is the policy for the shell, which is the right baseline for a page
 * the Worker assembles out of that same shell.
 */
const REFERENCE = "/index.html";

/**
 * Remembered for the life of the isolate. The answer changes only when
 * `_headers` changes, and that means a deploy, and a deploy means new
 * isolates - so there is nothing to invalidate.
 *
 * Only a success is remembered. Caching the promise itself would let one
 * failed fetch, at the moment an isolate started, leave every later response
 * in it unprotected.
 */
let remembered: Map<string, string> | null = null;

async function sitePolicy(env: Env, origin: string): Promise<Map<string, string>> {
  if (remembered) return remembered;

  const asset = await env.ASSETS.fetch(new Request(new URL(REFERENCE, origin)));
  const policy = new Map<string, string>();
  for (const [name, value] of asset.headers) {
    const lower = name.toLowerCase();
    if (!ENTITY.has(lower)) policy.set(lower, value);
  }

  remembered = policy;
  return policy;
}

/**
 * The response, with any site-wide header it is missing.
 *
 * Never overwrites. A route that set a header deliberately - a narrower policy
 * for one page, say - keeps what it set.
 *
 * A response that is already complete is returned untouched, which is the case
 * for everything the asset runtime served: those are the majority of requests,
 * and rewrapping a response that is being streamed, to change nothing, is a
 * cost paid on all of them.
 */
export async function secured(response: Response, env: Env, origin: string): Promise<Response> {
  let policy: Map<string, string>;
  try {
    policy = await sitePolicy(env, origin);
  } catch (error) {
    // An internal binding, so this is close to impossible - but if it does
    // happen, a page without a policy beats no page at all, and the operator
    // needs to know the site is serving unprotected. Silence here would be the
    // same failure this module exists to prevent, one layer down.
    logFailure("security headers unavailable", error);
    return response;
  }

  const missing = [...policy].filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;

  // Headers on a response that came back from a fetch, or from
  // `Response.redirect`, are immutable; writing to them throws. Copying is the
  // only way to add to either.
  const out = new Response(response.body, response);
  for (const [name, value] of missing) out.headers.set(name, value);
  return out;
}
