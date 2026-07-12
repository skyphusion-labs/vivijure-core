// Structured observability events for the homelab host.
//
// Production vivijure ships console JSON lines to a tail worker -> Loki. vivijure-local
// has no tail consumer: stdout IS the observability surface (docker compose logs -f studio).
// Every line is a single JSON object with an `ev` field so operators and smoke tests can grep.

export type StructuredEvent = Record<string, unknown> & { ev: string };

/** Emit one structured event as a single stdout line. Never throws. */
export function emitStructuredEvent(event: StructuredEvent): void {
  try {
    console.log(JSON.stringify(event));
  } catch {
    // Serialization failure must not break the render path.
  }
}
