import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FILM_CANCEL_CLAIM_EVERY_MS,
  FILM_CANCEL_WAIT_MS,
  FilmBusyError,
  cancelFilmJob,
  filmJobDocKey,
  type FilmJob,
} from "../src/film-orchestrator.js";
import { claimFilmAdvance, releaseFilmAdvance } from "../src/film-advance-lease.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// vivijure-cf#1215. A tick writes the film doc under the advance lease; a cancel wrote it with none. So a tick that
// read the doc before a cancel could write it back after, and `cancelled` was lost while the film kept spending.
// The studio's R2 retry is one way in: a tick's put that lands and errors is put again, seconds later, over the
// cancel. Here the tick is any holder of the lease that writes the doc it read, which is what that retry does.

afterEach(() => vi.restoreAllMocks());

const ID = "film-cancel-1215";
const KEY = filmJobDocKey(ID);

/** D1 with the lease SQL as written: claim, renew, release. Each run() has no await inside, so it is atomic. */
function leaseDb() {
  const row = { advance_lease: null as number | null, advance_lease_token: null as string | null };
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => {
              if (sql.includes("advance_lease = NULL")) {
                const [, token] = args as [string, string];
                if (row.advance_lease_token !== null && row.advance_lease_token === token) {
                  row.advance_lease = null;
                  row.advance_lease_token = null;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("SET advance_lease = ? WHERE")) {
                const [lease, , token] = args as [number, string, string];
                if (row.advance_lease_token === token) {
                  row.advance_lease = lease;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              if (sql.includes("SET advance_lease")) {
                const [lease, token, , now, tokenPred] = args as [number, string, string, number, string];
                if (row.advance_lease === null || row.advance_lease < now || row.advance_lease_token === tokenPred) {
                  row.advance_lease = lease;
                  row.advance_lease_token = token;
                  return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
              }
              return { meta: { changes: 0 } };
            },
            first: async () => ({ one: 1 }),
            all: async () => ({ results: [] }),
          };
        },
      };
    },
  };
  return { DB, row };
}

function setup(phase: FilmJob["phase"] = "clips") {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const job = { film_id: ID, project: "p1", phase, created_at: Date.now() - 1000, scenes: [], bundle_key: "b" } as unknown as FilmJob;
  const stored: Record<string, string> = { [KEY]: JSON.stringify(job) };
  const { DB, row } = leaseDb();
  const e = {
    DB,
    R2_RENDERS: {
      head: async (k: string) => (k in stored ? { size: 1 } : null),
      get: async (k: string) => (k in stored ? { text: async () => stored[k] } : null),
      put: async (k: string, b: string) => { stored[k] = b; },
      delete: async (k: string) => { delete stored[k]; },
      list: async () => ({ objects: [] }),
    },
  } as unknown as Env;
  const doc = () => JSON.parse(stored[KEY]) as FilmJob;
  return { e, stored, row, doc };
}

describe("a cancel and a tick write one doc, one at a time (vivijure-cf#1215)", () => {
  it("a tick that writes back the doc it read cannot undo a cancel", async () => {
    const { e, stored, doc } = setup();
    const tick = await claimFilmAdvance(e, ID);
    expect(tick.won).toBe(true);
    const read = stored[KEY]; // what the tick read, before any cancel
    let open!: () => void;
    const opened = new Promise<void>((r) => { open = r; });
    const ticking = (async () => {
      await opened;
      stored[KEY] = read; // the retried put: lands the old doc again
      await releaseFilmAdvance(e, ID, tick.token!);
    })();
    let sleeps = 0;
    const cancel = cancelFilmJob(e, ID, {
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) open();
        await new Promise((r) => setTimeout(r, 1));
      },
    });
    const r = await cancel;
    open(); // a cancel that did not wait has already written; the tick's put now lands after it
    await ticking;
    expect(sleeps).toBeGreaterThanOrEqual(2);
    expect(r?.cancelled).toBe(true);
    expect(doc()).toMatchObject({ cancelled: true, phase: "failed", error: "cancelled" });
  });

  it("a tick that holds the film past the wait gets a busy error, and nothing is written", async () => {
    const { e, stored } = setup();
    const tick = await claimFilmAdvance(e, ID);
    const before = stored[KEY];
    let sleeps = 0;
    await expect(cancelFilmJob(e, ID, { sleep: async () => { sleeps += 1; } })).rejects.toBeInstanceOf(FilmBusyError);
    expect(sleeps).toBe(FILM_CANCEL_WAIT_MS / FILM_CANCEL_CLAIM_EVERY_MS);
    expect(stored[KEY]).toBe(before);
    await releaseFilmAdvance(e, ID, tick.token!);
  });

  it("a film already terminal is returned as it is, even while a tick holds it", async () => {
    const { e } = setup("done");
    await claimFilmAdvance(e, ID);
    const r = await cancelFilmJob(e, ID, { sleep: async () => {} });
    expect(r?.phase).toBe("done");
    expect(r?.cancelled).toBeUndefined();
  });

  it("a cancel lets go of the film, so the next tick can claim it", async () => {
    const { e, row, doc } = setup();
    await cancelFilmJob(e, ID, { sleep: async () => {} });
    expect(doc().cancelled).toBe(true);
    expect(row.advance_lease_token).toBeNull();
    expect((await claimFilmAdvance(e, ID)).won).toBe(true);
  });

  it("an unknown film is null, as before", async () => {
    const { e, stored } = setup();
    delete stored[KEY];
    expect(await cancelFilmJob(e, ID, { sleep: async () => {} })).toBeNull();
  });
});
