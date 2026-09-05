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
    /**
     * Optional, unlike the Steam key. The IGDB-backed section hides itself when
     * these are absent, so the type has to allow absent.
     */
    TWITCH_CLIENT_ID?: string;
    TWITCH_CLIENT_SECRET?: string;
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

/**
 * `import.meta.glob`, which Vite provides and TypeScript does not know about.
 *
 * Declared rather than silenced at the call site, for the same reason as the
 * `?raw` modules above: `tsc --noEmit` is a CI gate, and a `@ts-ignore` there
 * would hide a real mistake in the same expression.
 *
 * Only the eager, raw form is declared, because that is the only one used -
 * `prose.test.ts` enumerates the Worker's own modules so that adding one
 * brings it under the checks without anybody remembering to.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
