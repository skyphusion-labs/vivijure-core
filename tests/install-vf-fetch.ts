import { afterEach } from "vitest";

let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
});

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
