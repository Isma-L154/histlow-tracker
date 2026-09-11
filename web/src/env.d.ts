/**
 * Secrets, which `wrangler types` cannot see: they exist only in Cloudflare's
 * store, so they are declared here by interface merging.
 */
interface Env {
  /** Set with `wrangler secret put`. Without it the API answers 503. */
  STEAM_WEB_API_KEY: string;
  /** IGDB, through Twitch. Optional: the sections that need them hide themselves. */
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
}
