/**
 * The Steam key, as far as the type system is concerned.
 *
 * `wrangler types` generates `Cloudflare.Env` from the config file, which
 * never lists secrets, so the key the Worker requires is absent from the type
 * the tests see. `vitest.config.ts` supplies it at runtime.
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

/** A `?raw` import, which Vite resolves to the file's contents and TypeScript does not know. */
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
 * Declared rather than silenced, since a `@ts-ignore` would hide a real
 * mistake in the same expression. Only the eager raw form is used.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}

declare module "*.js?raw" {
  const contents: string;
  export default contents;
}
