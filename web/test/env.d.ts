/**
 * The Steam key, as far as the type system is concerned.
 *
 * `wrangler types` generates `Cloudflare.Env` from the config file, which
 * lists bindings and vars and deliberately never lists secrets - so the key
 * the Worker requires is absent from the type the tests see. It is declared
 * here and supplied at runtime by `vitest.config.ts`.
 */
declare namespace Cloudflare {
  interface Env {
    STEAM_WEB_API_KEY: string;
  }
}
