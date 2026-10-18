/**
 * One request through the Worker, as the runtime makes it: in an execution
 * context of its own, waited on so anything handed to `waitUntil` (a cache
 * write, a token refresh) has finished before the test looks.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.ts";

export async function serve(request: Request, using: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, using, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
