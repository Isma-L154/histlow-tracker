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

/**
 * The shipped HTML, as text.
 *
 * Vite resolves a `?raw` import to the file's contents; TypeScript has no idea
 * what an `.html` module is, and `tsc --noEmit` is a CI gate, so the shape is
 * declared here rather than silenced at each import.
 */
declare module "*.ts?raw" {
  const contents: string;
  export default contents;
}

declare module "*.jsonc?raw" {
  const contents: string;
  export default contents;
}

declare module "*.html?raw" {
  const contents: string;
  export default contents;
}
