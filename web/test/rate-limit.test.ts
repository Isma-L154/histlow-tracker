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

/**
 * The game route's only defence was the cache, and the caller chose whether it
 * applied.
 *
 * `?steamid=` makes the answer somebody's own, so it cannot be shared - and
 * `cached` honours that by neither reading nor writing. That is correct for a
 * personal answer and it left the route with nothing: four Steam calls, no
 * limit, and a parameter that turns the cache off, on games that are already
 * known. Measured against production before this existed: three requests with
 * the parameter were flat at 0.40s, 0.33s, 0.35s and answered
 * `cache-control: private, no-store`, while the same id without it stepped
 * down 0.68s, 0.25s, 0.24s.
 *
 * So the uncacheable path is the limited one, and the reader browsing games is
 * not touched.
 */
describe("the personalised game route is limited", () => {
  /** Seventeen digits: enough to be taken for a SteamID64 and turn caching off. */
  const PERSONAL = "/api/game/440?steamid=76561190000000000";

  /**
   * Spends one caller's profile allowance without reaching the network.
   *
   * The completion-time route takes the same allowance and, with no IGDB
   * credentials, answers without calling anybody - which is what keeps this
   * suite offline while still exercising the real limiter.
   */
  async function exhaust(ip: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const response = await get("/api/time/918274656", { "CF-Connecting-IP": ip });
      if (response.status === 429) return;
    }
    throw new Error("the profile allowance never ran out");
  }

  it("refuses a personalised request once the allowance is spent", async () => {
    const caller = { "CF-Connecting-IP": "203.0.113.40" };
    await exhaust("203.0.113.40");

    // 429 before Steam is called: the point is to cost a flooder as little of
    // our time - and as little of the key's quota - as possible.
    expect((await get(PERSONAL, caller)).status).toBe(429);
  });

  it("tells the caller how long to wait", async () => {
    const caller = { "CF-Connecting-IP": "203.0.113.41" };
    await exhaust("203.0.113.41");

    expect((await get(PERSONAL, caller)).headers.get("Retry-After")).toBeTruthy();
  });

  it("limits one caller without touching another", async () => {
    await exhaust("203.0.113.42");

    // A shared address must not be silenced by one noisy neighbour's walk.
    const bystander = { "CF-Connecting-IP": "203.0.113.43" };
    expect((await get("/api/time/918274656", bystander)).status).not.toBe(429);
  });
});
