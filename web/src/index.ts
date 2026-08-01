/**
 * Steam achievement browser.
 *
 * One Worker serves both halves of the site. Requests under `/api/` run this
 * code; everything else is served directly from `public/` by the assets
 * runtime without invoking the Worker at all.
 *
 * The Worker exists for two reasons the browser cannot solve on its own:
 * none of Steam's endpoints send CORS headers, so a page cannot call them
 * directly, and the Steam Web API key must never reach the client.
 *
 * This module exports the default handler and nothing else. The runtime reads
 * every named export here as a handler or binding, so helpers live in
 * sibling modules.
 */

import { VERSION, json, problem } from "./http.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      // Unreachable in production: `run_worker_first` limits Worker execution
      // to /api/*. Kept so `wrangler dev` and tests behave the same way.
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET") {
      return problem(405, "Only GET is supported.");
    }

    switch (url.pathname) {
      case "/api/health":
        return json({ ok: true, version: VERSION });
      default:
        return problem(404, `No API route matches ${url.pathname}.`);
    }
  },
} satisfies ExportedHandler<Env>;
