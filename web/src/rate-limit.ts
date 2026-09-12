/**
 * Per-caller limits on the routes that spend a budget.
 *
 * The platform limiter fails open: it protects a budget, and breaking the
 * feature to defend it would hand over the outage for free. Measured on this
 * account, `limit()` never returned `success: false` - thirty concurrent calls
 * against a limit of twenty were all allowed - so the how-to route also keeps a
 * per-isolate allowance, which is what actually holds the line.
 */

import { logFailure } from "./http.ts";

/**
 * First-time model answers per caller, per isolate.
 *
 * A damage cap, not a quota. A burst of twenty-five requests from one address
 * was measured spreading across eight isolates, the busiest seeing eight, so the
 * ceiling sits where a spread burst still trips it and a reader never will.
 */
const recentByCaller = new Map<string, number[]>();
const FRESH_ANSWER_WINDOW_MS = 60_000;
const MAX_FRESH_ANSWERS = 8;

function spentAllowance(caller: string, now: number): boolean {
  const seen = (recentByCaller.get(caller) ?? []).filter((at) => now - at < FRESH_ANSWER_WINDOW_MS);
  seen.push(now);
  recentByCaller.set(caller, seen);

  // Bounded, so a burst of distinct addresses cannot exhaust the isolate's memory.
  if (recentByCaller.size > 5_000) recentByCaller.clear();

  return seen.length > MAX_FRESH_ANSWERS;
}

/** Whether this caller may continue. A missing or failing limiter allows the request. */
export async function withinRate(
  request: Request,
  env: Env,
  which: "HOWTO" | "PROFILE" = "HOWTO",
): Promise<boolean> {
  const limiter = which === "HOWTO" ? env.HOWTO_LIMITER : env.PROFILE_LIMITER;
  if (!limiter) return true;

  // Written by the edge and not settable by a client. Absent only outside
  // Cloudflare, where one shared bucket is stricter rather than looser.
  const caller = request.headers.get("CF-Connecting-IP") ?? "unidentified";
  if (which === "HOWTO" && spentAllowance(caller, Date.now())) return false;

  try {
    const { success } = await limiter.limit({ key: caller });
    return success;
  } catch (error) {
    logFailure("rate limiter unavailable", error);
    return true;
  }
}
