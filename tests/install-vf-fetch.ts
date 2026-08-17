import { afterEach } from "vitest";

let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
});

/** Honest /async/finish + /async/status fixture. Not a sync-to-async shim. */
export function vfAsyncFinish(
  result: unknown,
  opts: { jobId?: string } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const jobId = opts.jobId ?? "job-test";
  const json = (b: unknown, status: number) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return async (input) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.includes("/async/finish")) {
      return json({ ok: true, jobId, status: "pending" }, 202);
    }
    if (u.includes("/async/status/")) {
      return json({ ok: true, status: "completed", result }, 200);
    }
    return json({ ok: false, error: "unexpected video-finish path " + u }, 404);
  };
}

/** Point VIDEO_FINISH_URL at a fake origin and route those fetches to `handler`. */
export function installVfFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (u.includes("video-finish")) return handler(input, init);
    return prev(input as RequestInfo, init);
  }) as typeof fetch;
  undo = () => {
    globalThis.fetch = prev;
  };
}
