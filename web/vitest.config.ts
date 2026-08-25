import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Runs the tests inside workerd rather than Node, so a route is exercised by
 * the same runtime that serves it in production. Anything passing here only
 * because Node is more forgiving would be a lie.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The handler refuses to build a Steam client without one, and these
        // tests must reach validation without ever calling Steam.
        bindings: { STEAM_WEB_API_KEY: "test-key-not-real" },
      },
    }),
  ],
});
