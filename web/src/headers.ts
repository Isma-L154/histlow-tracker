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
  // Added after review. A reference response that is not `ok` but does carry
  // headers would otherwise promote them to site-wide: a 503 from the asset
  // runtime carries `Retry-After`, and every 200 in that isolate would have
  // been stamped with it. The `asset.ok` check below is the real guard; these
  // are here because a deny-list has to be argued for header by header, and
  // these are the ones that came to mind once the question was asked.
  "retry-after",
  "allow",
  "content-disposition",
  "content-location",
  "link",
  "server-timing",
]);

/**
 * The floor. Below this, whatever came back is not the site's policy.
 *
 * This is not the second list the module exists to avoid, and the difference
 * matters: the list of headers to apply is still read from `_headers` in full,
 * and adding one there still needs no change here. This says only that a
 * result missing these two is not worth believing.
 *
 * Without it the failure is perfectly silent. A 404 from the binding, a
 * `_headers` that stopped being applied, a reference file that was renamed -
 * each of those produces an empty set of headers, and an empty set is
 * indistinguishable from "this response already has everything" at the point
 * where the decision is made. Every page would ship unprotected and every
 * check would stay green, which is the exact failure this module was written
 * against, one layer down.
 *
 * Two names rather than six: the CSP because it is what this module exists
 * for, and `nosniff` because it is the one that carries weight on the JSON
 * routes. A floor that listed all six would go stale the day one is
 * deliberately dropped.
 */
const REQUIRED = ["content-security-policy", "x-content-type-options"];

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
 * The site-wide headers in a response, or null if it does not carry a policy.
 *
 * Pure, and exported, so the judgement above can be tested directly. The
 * failure it guards against cannot be reached through the asset binding in a
 * test - the binding always answers - so testing it through `secured` would
 * mean never testing it at all.
 */
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
 * Remembered for the life of the isolate. The answer changes only when
 * `_headers` changes, and that means a deploy, and a deploy means new
 * isolates - so there is nothing to invalidate.
 *
 * Only a usable policy is remembered. Caching whatever came back would let one
 * bad answer, at the moment an isolate started, leave every later response in
 * it unprotected until the next deploy - and caching the promise would do the
 * same for one failed fetch.
 *
 * Not keyed by origin, though `sitePolicy` takes one: the first origin into an
 * isolate wins. The Worker answers on two hostnames and the former one only
 * ever redirects, so there is one policy to hold - but the signature reads as
 * though there could be more than one, and there could not.
 */
let remembered: Map<string, string> | null = null;

/** Whether this isolate has already said the policy is unreadable. */
let reported = false;

async function sitePolicy(env: Env, origin: string): Promise<Map<string, string>> {
  if (remembered) return remembered;

  const asset = await env.ASSETS.fetch(new Request(new URL(REFERENCE, origin)));
  if (!asset.ok) throw new Error(`${REFERENCE} answered ${asset.status}`);

  const policy = policyFrom(asset.headers);
  if (!policy) {
    // Named, because the two causes need different fixes: `_headers` no longer
    // being applied is Cloudflare's side, and a policy that genuinely lost its
    // CSP is this repository's.
    throw new Error(`${REFERENCE} carries no policy (${[...asset.headers.keys()].join(", ") || "no headers"})`);
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
 *
 * Cannot throw. It runs on every response the Worker produces, so a failure
 * here would not cost a policy - it would cost the page, on a path that had no
 * way to fail before this module existed.
 */
export async function secured(response: Response, env: Env, origin: string): Promise<Response> {
  try {
    const policy = await sitePolicy(env, origin);

    const missing = [...policy].filter(([name]) => !response.headers.has(name));
    if (missing.length === 0) return response;

    // Headers on a response that came back from a fetch, or from
    // `Response.redirect`, are immutable; writing to them throws. Copying is
    // the only way to add to either.
    const out = new Response(response.body, response);
    for (const [name, value] of missing) out.headers.set(name, value);
    return out;
  } catch (error) {
    // A page without a policy beats no page at all. But silence here would be
    // the same failure this module exists to prevent, so it is said - once per
    // isolate rather than once per request, because a fault that persists is
    // one fact repeated, and repeating it at request rate buries it.
    //
    // The fetch is still retried every request. Only the log is rationed, so
    // an isolate that started during a blip recovers on its own.
    if (!reported) {
      reported = true;
      logFailure("serving without the site's security policy", error);
    }
    return response;
  }
}
