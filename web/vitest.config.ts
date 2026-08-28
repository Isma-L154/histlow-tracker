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
      /*
       * Workers AI has no local simulator: the binding always reaches the real
       * account, so the pool opens a remote proxy session for it before any
       * test runs, and that session needs credentials. CI has none, which is
       * why the deploy stopped at the test step while it passed locally on
       * stored OAuth.
       *
       * Nothing here calls the model - these tests cover input bounds and the
       * rate limit - so the honest fix is to declare that no binding needs to
       * be real. It also keeps the suite offline, deterministic, and unable to
       * spend the daily allowance by running.
       */
      remoteBindings: false,
      miniflare: {
        // The handler refuses to build a Steam client without one, and these
        // tests must reach validation without ever calling Steam.
        bindings: { STEAM_WEB_API_KEY: "test-key-not-real" },
      },
    }),
  ],
});
