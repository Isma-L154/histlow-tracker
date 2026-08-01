/**
 * Secrets are not visible to `wrangler types`.
 *
 * `worker-configuration.d.ts` is generated from `wrangler.jsonc`, which lists
 * plain vars only - a secret exists solely in Cloudflare's store, so nothing
 * in the config describes it. Declaring it here by interface merging keeps the
 * type accurate without committing anything sensitive, and without the
 * generated file needing to be edited by hand.
 */

interface Env {
  /**
   * Steam Web API key.
   *
   * Set with `wrangler secret put STEAM_WEB_API_KEY`. Required by the
   * achievement schema and player progress endpoints; absent, the API answers
   * 503 rather than pretending the game has no achievements.
   */
  STEAM_WEB_API_KEY: string;
}
