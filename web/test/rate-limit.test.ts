/**
 * The limit on the model-backed route, proven by tripping it.
 *
 * A configured limit that has never been provoked is an assumption. These
 * tests exist because the audit found sixty consecutive requests sailing
 * through, and a passing config file would not have told anyone.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const BASE = "https://example.com";

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${BASE}${path}`, { headers }), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** A key that fails validation, so the route is exercised without reaching Steam. */
const CHEAP = "/api/howto/367520/%FF%FE";

describe("the how-to route is limited", () => {
  it("answers 429 once the allowance is spent", async () => {
    const caller = { "CF-Connecting-IP": "203.0.113.10" };
    let sawLimit = false;

    for (let i = 0; i < 40; i++) {
      const response = await get(CHEAP, caller);
      if (response.status === 429) {
        sawLimit = true;
        break;
      }
    }

    expect(sawLimit).toBe(true);
  });

  it("tells the caller how long to wait", async () => {
    const caller = { "CF-Connecting-IP": "203.0.113.11" };
    let limited: Response | null = null;

    for (let i = 0; i < 40; i++) {
      const response = await get(CHEAP, caller);
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).not.toBeNull();
    expect(limited?.headers.get("Retry-After")).toBeTruthy();
  });

  it("limits one caller without touching another", async () => {
    // Per-IP, not global: one noisy visitor must not silence everyone else.
    const noisy = { "CF-Connecting-IP": "203.0.113.12" };
    for (let i = 0; i < 40; i++) {
      if ((await get(CHEAP, noisy)).status === 429) break;
    }

    const bystander = await get(CHEAP, { "CF-Connecting-IP": "203.0.113.99" });
    expect(bystander.status).not.toBe(429);
  });

  it("leaves the unmetered routes alone", async () => {
    // Health and search do not reach the model, so they keep their own limits
    // and must not be caught by this one.
    const caller = { "CF-Connecting-IP": "203.0.113.13" };
    for (let i = 0; i < 40; i++) await get(CHEAP, caller);

    expect((await get("/api/health", caller)).status).toBe(200);
  });
});
