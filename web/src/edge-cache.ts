/**
 * The edge cache, keyed by what changes an answer and scoped to the deployment.
 *
 * Keys are built from a canonical path rather than the request URL, so a junk
 * query parameter cannot force a miss against the Steam key's quota. Scoping
 * them to the deployment id means a publish invalidates every route by
 * construction, instead of by someone remembering to bump a constant.
 */

/** The cache key for a canonical path, scoped to the running deployment. */
export function key(url: URL, canonical: string, env: Env): string {
  return new URL(`/${deployment(env)}${canonical}`, url.origin).toString();
}

/** The deployment id; a constant in tests and local development, where the binding is absent. */
function deployment(env: Env): string {
  return env.CF_VERSION?.id ?? "dev";
}

/**
 * Whether a response should go in the edge cache.
 *
 * The producer wins in both directions: `no-store` means what it says, and a
 * stable failure that carries its own lifetime is worth keeping. Exported so it
 * can be asserted, since the test pool does not exercise `caches.default`.
 */
export function storable(cacheControl: string | null, ok: boolean): boolean {
  if (cacheControl?.includes("no-store")) return false;
  return ok || cacheControl !== null;
}

/**
 * Serves from the edge cache when possible, populating it otherwise.
 *
 * A personal answer - one carrying somebody's unlocks - is never cached.
 */
export async function cached(
  cacheKey: string,
  personal: boolean,
  env: Env,
  ctx: ExecutionContext,
  produce: () => Promise<Response>,
): Promise<Response> {
  if (personal) {
    const fresh = await produce();
    fresh.headers.set("Cache-Control", "private, no-store");
    return fresh;
  }

  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const response = await produce();
  const control = response.headers.get("Cache-Control");
  if (storable(control, response.ok)) {
    if (control === null) {
      response.headers.set("Cache-Control", `public, max-age=${env.CACHE_SECONDS}`);
    }
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}
