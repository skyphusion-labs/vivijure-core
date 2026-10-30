import { afterEach, describe, expect, it, vi } from "vitest";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";
import {
  FINISH_QUEUE_CAP_COOLDOWN_SECONDS,
  FINISH_QUEUE_LEASE_SECONDS,
  FINISH_QUEUE_PRUNE_SECONDS,
  FINISH_QUEUE_SCHEMA,
  FINISH_QUEUE_STALE_SECONDS,
  finishQueueSlots,
  sqlFinishQueue,
} from "../src/finish-queue.js";
import type { Database } from "../src/platform/types.js";
import {
  FINISH_QUEUE_RECHECK_SECONDS,
  decodeAssembleWait,
  encodeAssembleWait,
  finishSlotGate,
  tickVideoFinishAssemble,
} from "../src/video-finish-assemble.js";
import type { Env } from "../src/platform/orchestrator-context.js";

// Real SQLite and the shipped SQL. A fake database would only return what the test decided it should.

let d1: TestD1 | undefined;
afterEach(() => {
  d1?.close();
  d1 = undefined;
  vi.restoreAllMocks();
});

function open(slots = 2, batch = true) {
  d1 = openTestD1();
  d1.raw.exec(FINISH_QUEUE_SCHEMA);
  const clock = { t: 1_000_000 };
  const raw = d1.DB as Database;
  const db: Database = batch ? raw : { prepare: raw.prepare.bind(raw) };
  const make = () => sqlFinishQueue(db, { slots, now: () => clock.t });
  return { q: make(), make, clock, raw: d1.raw };
}

const granted = async (q: ReturnType<typeof sqlFinishQueue>, h: string) => (await q.acquire(h)).granted;

describe("finish queue order", () => {
  it("serves films in the order they first asked, under contention", async () => {
    const { q } = open(1);
    expect(await granted(q, "a")).toBe(true);
    // b, c and d line up in that order, then ask again in the reverse order. Asking more often or
    // more recently must buy nothing, which is the whole defect.
    for (const h of ["b", "c", "d"]) expect(await granted(q, h)).toBe(false);
    for (const h of ["d", "c", "b"]) expect(await granted(q, h)).toBe(false);
    await q.release("a");
    expect(await granted(q, "d")).toBe(false);
    expect(await granted(q, "c")).toBe(false);
    expect(await granted(q, "b")).toBe(true);
    await q.release("b");
    expect(await granted(q, "d")).toBe(false);
    expect(await granted(q, "c")).toBe(true);
    await q.release("c");
    expect(await granted(q, "d")).toBe(true);
  });

  it("does not let a new film take a freed slot from one already waiting", async () => {
    const { q } = open(1);
    await q.acquire("a");
    await q.acquire("b");
    await q.release("a");
    expect(await granted(q, "newcomer")).toBe(false);
    expect(await granted(q, "b")).toBe(true);
  });

  it("reports position and depth, and position falls as the line moves", async () => {
    const { q } = open(1);
    await q.acquire("a");
    await q.acquire("b");
    await q.acquire("c");
    const c = await q.acquire("c");
    expect(c).toMatchObject({ granted: false, position: 2, depth: 2, running: 1 });
    await q.release("a");
    await q.acquire("b");
    expect(await q.acquire("c")).toMatchObject({ granted: false, position: 1, depth: 1, running: 1 });
  });

  it("runs as many films as there are slots, and no more", async () => {
    const { q, raw } = open(3);
    for (const h of ["a", "b", "c"]) expect(await granted(q, h)).toBe(true);
    expect(await granted(q, "d")).toBe(false);
    const row = raw.prepare("SELECT COUNT(*) AS n FROM finish_queue WHERE state = 'leased'").get() as { n: number };
    expect(row.n).toBe(3);
  });

  it("keeps a film's place after it releases, so its next step goes ahead of newer films", async () => {
    const { q } = open(1);
    await q.acquire("a");
    await q.acquire("b");
    await q.release("a"); // assemble ended; mux not asked yet
    expect(await granted(q, "a")).toBe(true);
    expect(await granted(q, "b")).toBe(false);
  });

  it("is idempotent for a holder that asks again while it holds the slot", async () => {
    const { q } = open(1);
    expect(await granted(q, "a")).toBe(true);
    expect(await granted(q, "a")).toBe(true);
    expect((await q.acquire("b")).granted).toBe(false);
  });

  it("works on a host with no batch", async () => {
    const { q } = open(1, false);
    expect(await granted(q, "a")).toBe(true);
    expect(await granted(q, "b")).toBe(false);
    await q.release("a");
    expect(await granted(q, "b")).toBe(true);
  });

  it("lists waiters in order for a driver, without those holding a slot", async () => {
    const { q } = open(1);
    for (const h of ["a", "b", "c"]) await q.acquire(h);
    expect(await q.next(10)).toEqual(["b", "c"]);
    expect(await q.next(1)).toEqual(["b"]);
  });
});

describe("two sweeps racing", () => {
  // The harness runs a batch statement by statement with an await between, so these really do
  // interleave. That is harsher than D1, where a batch is one transaction. The grant is one statement,
  // so it must hold even here.
  it("only one wins the last slot, however the statements interleave", async () => {
    for (let round = 0; round < 50; round++) {
      const { q, raw } = open(1);
      const answers = await Promise.all([q.acquire("a"), q.acquire("b")]);
      expect(answers.filter((x) => x.granted)).toHaveLength(1);
      const leased = raw.prepare("SELECT COUNT(*) AS n FROM finish_queue WHERE state = 'leased'").get() as { n: number };
      expect(leased.n).toBe(1);
      d1?.close();
      d1 = undefined;
    }
  });

  it("never exceeds the slots with many racing, and the winners are the earliest", async () => {
    const { q, raw } = open(3);
    for (const h of ["a", "b", "c", "d", "e", "f"]) await q.acquire(h);
    await q.release("a");
    await q.release("b");
    await q.release("c");
    await Promise.all(["f", "e", "d", "c", "b", "a"].map((h) => q.acquire(h)));
    const rows = raw.prepare("SELECT holder FROM finish_queue WHERE state = 'leased' ORDER BY seq").all() as { holder: string }[];
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const r of rows) expect(["a", "b", "c"]).toContain(r.holder);
  });

  it("a holder re-asking from two sweeps at once takes one slot", async () => {
    const { q, raw } = open(2);
    await Promise.all([q.acquire("a"), q.acquire("a")]);
    const leased = raw.prepare("SELECT COUNT(*) AS n FROM finish_queue WHERE state = 'leased'").get() as { n: number };
    expect(leased.n).toBe(1);
  });
});

describe("finish queue recovery", () => {
  it("an expired lease goes back to waiting in its FIFO position, ahead of later films", async () => {
    const { q, clock, raw } = open(1);
    await q.acquire("first");
    await q.acquire("second");
    clock.t += (FINISH_QUEUE_LEASE_SECONDS + 1) * 1000;
    await q.acquire("second"); // this ask runs the expiry
    // "first" is waiting again and is listed first, so a driver reaches it before "second"...
    const state = raw.prepare("SELECT state FROM finish_queue WHERE holder = 'first'").get() as { state: string };
    expect(state.state).toBe("waiting");
    await q.acquire("third");
    expect(await q.next(10)).toEqual(["first", "third"]);
    // ...and once it asks again, it is ahead of a film that asked after it.
    expect((await q.acquire("first")).granted).toBe(false);
    await q.release("second");
    expect(await granted(q, "third")).toBe(false);
    expect(await granted(q, "first")).toBe(true);
  });

  it("lists holders, so a driver can see a job end before its page comes round", async () => {
    const { q } = open(2);
    await q.acquire("a");
    await q.acquire("b");
    await q.acquire("c");
    expect(await q.holders()).toEqual(["a", "b"]);
  });

  it("a crashed holder's lease expires and the next film goes", async () => {
    const { q, clock } = open(1);
    await q.acquire("crashed");
    await q.acquire("b");
    clock.t += (FINISH_QUEUE_LEASE_SECONDS - 1) * 1000;
    expect(await granted(q, "b")).toBe(false);
    clock.t += 2000;
    expect(await granted(q, "b")).toBe(true);
  });

  it("asking does not extend a lease: a film granted a slot that never submits loses it", async () => {
    const { q, clock } = open(1);
    await q.acquire("stuck");
    await q.acquire("b");
    for (let i = 0; i < 4; i++) {
      clock.t += (FINISH_QUEUE_STALE_SECONDS - 60) * 1000;
      await q.acquire("stuck"); // its tick asks, then throws before it can submit
      await q.acquire("b");
    }
    clock.t += FINISH_QUEUE_LEASE_SECONDS * 1000;
    await q.acquire("b");
    expect(await q.next(10)).toContain("stuck");
  });

  it("position and depth count only waiters that can hold anyone up", async () => {
    const { q, clock } = open(1);
    await q.acquire("a");
    await q.acquire("gone");
    clock.t += (FINISH_QUEUE_STALE_SECONDS + 1) * 1000;
    await q.renew("a");
    expect(await q.acquire("c")).toMatchObject({ granted: false, position: 1, depth: 1 });
  });

  it("renewing holds the slot past the original lease", async () => {
    const { q, clock } = open(1);
    await q.acquire("a");
    await q.acquire("b");
    for (let i = 0; i < 3; i++) {
      clock.t += (FINISH_QUEUE_LEASE_SECONDS - 60) * 1000;
      await q.renew("a");
      expect(await granted(q, "b")).toBe(false);
    }
  });

  it("a waiter that stops asking is skipped, and has its place back if it returns", async () => {
    const { q, clock } = open(1);
    await q.acquire("a");
    await q.acquire("gone");
    await q.acquire("c");
    await q.release("a");
    clock.t += (FINISH_QUEUE_STALE_SECONDS + 1) * 1000;
    expect(await granted(q, "c")).toBe(true);
    await q.release("c");
    expect(await granted(q, "gone")).toBe(true);
  });

  it("survives a restart: a new instance over the same table sees the same line", async () => {
    const { q, make } = open(1);
    await q.acquire("a");
    await q.acquire("b");
    await q.acquire("c");
    const restarted = make();
    expect(await granted(restarted, "c")).toBe(false);
    expect(await granted(restarted, "b")).toBe(false);
    await restarted.release("a");
    expect(await granted(restarted, "c")).toBe(false);
    expect(await granted(restarted, "b")).toBe(true);
  });

  it("forget removes the ticket, and asking again goes to the back", async () => {
    const { q } = open(1);
    await q.acquire("a");
    await q.acquire("b");
    await q.acquire("c");
    await q.forget("b");
    expect(await q.next(10)).toEqual(["c"]);
    await q.acquire("b");
    expect(await q.next(10)).toEqual(["c", "b"]);
  });

  it("prunes rows nobody has touched, and never one holding a slot", async () => {
    const { q, raw, clock } = open(1);
    await q.acquire("old");
    await q.release("old");
    clock.t += (FINISH_QUEUE_PRUNE_SECONDS + 1) * 1000;
    await q.acquire("new");
    const holders = (raw.prepare("SELECT holder FROM finish_queue").all() as { holder: string }[]).map((r) => r.holder);
    expect(holders).toEqual(["new"]);
  });

  it("renew takes a slot for a job already running when the queue was bound", async () => {
    const { q } = open(1);
    await q.renew("running-before-deploy");
    expect(await granted(q, "b")).toBe(false);
  });
});

describe("a door refusal after a grant", () => {
  it("keeps the film's place, and caps grants at what is really running", async () => {
    const { q } = open(5);
    await q.acquire("a");
    await q.acquire("b");
    expect(await granted(q, "c")).toBe(true);
    await q.yield("c"); // the door holds 2 and refused the third
    expect(await granted(q, "d")).toBe(false); // slots say 5 free; the door has said otherwise
    await q.release("a");
    expect(await granted(q, "d")).toBe(false); // the freed slot is c's, not d's
    expect(await granted(q, "c")).toBe(true);
  });

  it("lifts the cap after the cooldown, so a wrong reading does not stick", async () => {
    const { q, clock } = open(3);
    await q.acquire("a");
    await q.acquire("b");
    await q.yield("b");
    expect(await granted(q, "b")).toBe(false);
    clock.t += (FINISH_QUEUE_CAP_COOLDOWN_SECONDS + 1) * 1000;
    expect(await granted(q, "b")).toBe(true);
  });

  it("leaves the head able to probe when nothing is running", async () => {
    const { q } = open(3);
    await q.acquire("a");
    await q.yield("a");
    expect(await granted(q, "a")).toBe(true);
  });
});

describe("an optional fairness key", () => {
  function capped(slots: number, perKeyCap?: number) {
    d1 = openTestD1();
    d1.raw.exec(FINISH_QUEUE_SCHEMA);
    return sqlFinishQueue(d1.DB as Database, { slots, perKeyCap, now: () => 1_000_000 });
  }
  const ask = async (q: ReturnType<typeof sqlFinishQueue>, h: string, fairnessKey?: string) =>
    (await q.acquire(h, { fairnessKey })).granted;

  it("one key cannot hold every slot while another waits", async () => {
    const q = capped(3, 2);
    expect(await ask(q, "b1", "batch")).toBe(true);
    expect(await ask(q, "b2", "batch")).toBe(true);
    expect(await ask(q, "b3", "batch")).toBe(false); // at the key's cap, though a slot is free
    expect(await ask(q, "other", "solo")).toBe(true); // not held up by b3, which is ahead of it
  });

  it("keeps FIFO inside a key", async () => {
    const q = capped(2, 1);
    await ask(q, "b1", "batch");
    await ask(q, "b2", "batch");
    await ask(q, "b3", "batch");
    await q.release("b1");
    expect(await ask(q, "b3", "batch")).toBe(false);
    expect(await ask(q, "b2", "batch")).toBe(true);
  });

  it("with no cap a key changes nothing: plain FIFO", async () => {
    const q = capped(2);
    expect(await ask(q, "b1", "batch")).toBe(true);
    expect(await ask(q, "b2", "batch")).toBe(true);
    expect(await ask(q, "b3", "batch")).toBe(false);
    expect(await ask(q, "other", "solo")).toBe(false);
  });

  it("a ticket with no key is never capped", async () => {
    const q = capped(3, 1);
    expect(await ask(q, "a")).toBe(true);
    expect(await ask(q, "b")).toBe(true);
    expect(await ask(q, "c")).toBe(true);
  });
});

describe("finishQueueSlots", () => {
  it("takes a positive integer and otherwise the default, never zero", () => {
    expect(finishQueueSlots("4")).toBe(4);
    expect(finishQueueSlots(7)).toBe(7);
    for (const bad of ["", "0", "-1", "two", "1.5", undefined, null]) expect(finishQueueSlots(bad)).toBe(19);
  });
});

function doorEnv(extra: Record<string, unknown>, status = 202) {
  const calls: string[] = [];
  const env = {
    MEDIA_FINISH_TOKEN: "t",
    VIDEO_FINISH_URL: "http://video-finish",
    MEDIA_DOOR_FETCHERS: {
      VIDEO_FINISH_URL: {
        fetch: async (url: string) => {
          const path = new URL(url).pathname;
          calls.push(path);
          if (path.startsWith("/async/status")) return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
          if (status === 429) return new Response(JSON.stringify({ error: "capacity_exhausted", detail: "full" }), { status: 429 });
          return new Response(JSON.stringify({ ok: true, jobId: "j" }), { status: 202 });
        },
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, calls };
}
const payload = { clips: [{ url: "https://r2/c" }], outputUrl: "https://r2/o", outputKey: "k" };

describe("the gate and the tick", () => {
  it("with no queue bound, goes straight to the door: today's retry", async () => {
    const { env } = doorEnv({});
    expect(await finishSlotGate(env, "f", undefined, { step: "assemble" })).toEqual({ kind: "go" });
  });

  it("falls back and says so when the queue throws, and the film is not stopped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { acquire: async () => { throw new Error("no such table: finish_queue"); } };
    const { env } = doorEnv({ FINISH_QUEUE: broken });
    expect(await finishSlotGate(env, "f", undefined, { step: "assemble" })).toEqual({ kind: "go" });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("finish_queue.unavailable"))).toBe(true);
  });

  it("holds a film behind others, with its position in the wait, and asks again soon", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { q } = open(1);
    await q.acquire("first");
    const { env } = doorEnv({ FINISH_QUEUE: q });
    const now = Date.now();
    const gate = await finishSlotGate(env, "f", undefined, { step: "assemble" }, now);
    if (gate.kind !== "waiting") throw new Error("expected waiting");
    const w = decodeAssembleWait(gate.wait)!;
    expect(w).toMatchObject({ queued: true, position: 1, depth: 1, step: "assemble" });
    expect(w.nextAt).toBe(now + FINISH_QUEUE_RECHECK_SECONDS * 1000);
    expect(gate.detail).toContain("position 1 of 1");
  });

  it("does not call the queue inside the wait window", async () => {
    const acquire = vi.fn();
    const { env } = doorEnv({ FINISH_QUEUE: { acquire } });
    const now = Date.now();
    const wait = encodeAssembleWait({ firstAt: now, attempts: 1, nextAt: now + 1000, detail: "d" });
    expect((await finishSlotGate(env, "f", wait, { step: "assemble" }, now)).kind).toBe("waiting");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("past the bound it goes, so the door decides and the one failure path names the cause", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { q } = open(1);
    await q.acquire("first");
    const { env } = doorEnv({ FINISH_QUEUE: q });
    const now = Date.now();
    const wait = encodeAssembleWait({ firstAt: now - 6 * 3600 * 1000, attempts: 700, nextAt: now - 1, detail: "d" });
    expect(await finishSlotGate(env, "f", wait, { step: "assemble" }, now)).toEqual({ kind: "go" });
  });

  it("a running job renews, and an ended one releases and keeps its place", async () => {
    const { q, raw } = open(1);
    const { env } = doorEnv({ FINISH_QUEUE: q });
    const tick = await tickVideoFinishAssemble(env, payload, undefined, { affinity: "f" });
    expect(tick.kind).toBe("pending");
    const state = () => (raw.prepare("SELECT state FROM finish_queue WHERE holder = 'f'").get() as { state: string }).state;
    expect(state()).toBe("leased");
    if (tick.kind !== "pending") return;
    const { env: doneEnv } = doorEnv({ FINISH_QUEUE: q });
    (doneEnv.MEDIA_DOOR_FETCHERS as { VIDEO_FINISH_URL: { fetch: unknown } }).VIDEO_FINISH_URL.fetch = async () =>
      new Response(JSON.stringify({ status: "completed", result: { ok: true } }), { status: 200 });
    const done = await tickVideoFinishAssemble(doneEnv, payload, JSON.stringify(tick.poll), { affinity: "f" });
    expect(done.kind).toBe("done");
    expect(state()).toBe("parked");
  });

  it("a door 429 after a grant yields the slot and waits for the queue, not a long backoff", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { q, raw } = open(5);
    const { env } = doorEnv({ FINISH_QUEUE: q }, 429);
    await q.acquire("f");
    const tick = await tickVideoFinishAssemble(env, payload, undefined, { affinity: "f" });
    if (tick.kind !== "waiting") throw new Error(`expected waiting, got ${tick.kind}`);
    const row = raw.prepare("SELECT state FROM finish_queue WHERE holder = 'f'").get() as { state: string };
    expect(row.state).toBe("waiting");
    expect(decodeAssembleWait(tick.wait)!.queued).toBe(true);
  });

  it("a queue that throws on yield means the backoff, not the 30 second recheck", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { acquire: async () => ({ granted: true }), yield: async () => { throw new Error("d1 down"); } };
    const { env } = doorEnv({ FINISH_QUEUE: broken }, 429);
    const now = Date.now();
    const wait = encodeAssembleWait({ firstAt: now - 1000, attempts: 3, nextAt: now - 1, detail: "d" });
    const tick = await tickVideoFinishAssemble(env, payload, undefined, { affinity: "f", wait });
    if (tick.kind !== "waiting") throw new Error(`expected waiting, got ${tick.kind}`);
    const w = decodeAssembleWait(tick.wait)!;
    expect(w.queued).toBeUndefined();
    expect(w.nextAt - now).toBeGreaterThan(FINISH_QUEUE_RECHECK_SECONDS * 1000);
  });

  it("a queue failure during renew does not fail a running job", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { acquire: async () => ({ granted: true }), renew: async () => { throw new Error("d1 down"); } };
    const { env } = doorEnv({ FINISH_QUEUE: broken });
    expect((await tickVideoFinishAssemble(env, payload, undefined, { affinity: "f" })).kind).toBe("pending");
  });
});
