import type { FetcherLike } from "./types.js";

export function asFetcher(v: unknown): FetcherLike | null {
  if (v && typeof (v as { fetch?: unknown }).fetch === "function") {
    return v as FetcherLike;
  }
  return null;
}
