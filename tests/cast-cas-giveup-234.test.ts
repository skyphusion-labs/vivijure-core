import { afterEach, describe, expect, it, vi } from "vitest";
import { addRefs, createCast, removeRef, type CastRefImage } from "../src/cast-db.js";
import type { DbEnv } from "../src/db-env.js";
import { openTestD1, type TestD1 } from "./helpers/d1-sqlite.js";

// core#234: casUpdateImageList gave up after 6 contended CAS attempts and returned the
// CURRENT row with changed: false. addRefs returned that row. The row is TRUTHY, so
// `if (!row) return` cannot see an abandoned write. The cf#441 finalize guard compares
// the module output against what landed and trusts the same signal.
//
// Forced contention: wrap the real engine so every CAS UPDATE returns no row. The
// SELECT still reads the live column, so this is not a stub that invents the give-up
// -- it is the UPDATE-never-matches path the production loop already has.

const REFS: CastRefImage[] = [
  { key: "loras/refs/c234-a.png", mime: "image/png" },
  { key: "loras/refs/c234-b.png", mime: "image/png" },
];

interface Handle {
  env: DbEnv;
  d1: TestD1;
  updates: number;
}

function wrapCasMiss(d1: TestD1): Handle {
  const handle: Handle = { env: { DB: d1.DB } as DbEnv, d1, updates: 0 };
  const inner = d1.DB as {
    prepare(sql: string): {
      bind(...args: unknown[]): {
        all(): Promise<unknown>;
        run(): Promise<unknown>;
        first(): Promise<unknown>;
      };
    };
  };
  handle.env = {
    DB: {
      prepare(sql: string) {
        const stmt = inner.prepare(sql);
        return {
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args);
            const casUpdate =
              /^\s*UPDATE cast_members/i.test(sql) && /ref_keys_json\s*=\s*\?/i.test(sql);
            return {
              async all() {
                return bound.all();
              },
              async run() {
                if (casUpdate) {
                  handle.updates += 1;
                  return { success: true, meta: { changes: 0 } };
                }
                return bound.run();
              },
              async first() {
                if (casUpdate) {
                  handle.updates += 1;
                  return null;
                }
                return bound.first();
              },
            };
          },
        };
      },
    } as DbEnv["DB"],
  };
  return handle;
}

const open: TestD1[] = [];
function openD1(): TestD1 {
  const d1 = openTestD1();
  open.push(d1);
  return d1;
}

afterEach(() => {
  while (open.length) open.pop()!.close();
});

function rawRefKeys(d1: TestD1, id: number): unknown {
  const row = d1.raw
    .prepare("SELECT ref_keys_json FROM cast_members WHERE id = ?")
    .get(id) as { ref_keys_json: string | null } | undefined;
  if (!row || row.ref_keys_json == null) return [];
  return JSON.parse(row.ref_keys_json);
}

describe("core#234: addRefs give-up is falsy, not a stale truthy row", () => {
  it("CONTROL (positive): an uncontended addRefs returns the row WITH the new refs", async () => {
    const d1 = openD1();
    const env = { DB: d1.DB } as DbEnv;
    const created = await createCast(env, { name: "Ada C234" });
    const row = await addRefs(env, created.id, REFS);
    expect(row, "uncontended addRefs must return a row, else the give-up assertion is vacuous").toBeTruthy();
    expect(row!.ref_keys).toEqual(REFS);
    expect(rawRefKeys(d1, created.id)).toEqual(REFS);
  });

  it("CONTROL (no-op): removeRef of a missing key still returns a truthy row", async () => {
    // changed:false + truthy row is the no-op path. Give-up must NOT reuse that shape.
    const d1 = openD1();
    const env = { DB: d1.DB } as DbEnv;
    const created = await createCast(env, { name: "Noop C234" });
    const result = await removeRef(env, created.id, "loras/refs/missing.png");
    expect(result.row).toBeTruthy();
    expect(result.removedKey).toBeNull();
    expect(result.row!.id).toBe(created.id);
  });

  it("give-up after max CAS misses: addRefs is falsy and the column is unchanged", async () => {
    const d1 = openD1();
    const created = await createCast({ DB: d1.DB } as DbEnv, { name: "Contend C234" });
    const h = wrapCasMiss(d1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let row: unknown;
    try {
      row = await addRefs(h.env, created.id, REFS);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("gave up after 6 CAS attempts")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
    console.log(
      `core#234 give-up: row=${JSON.stringify(row)} updates=${h.updates} stored=${JSON.stringify(rawRefKeys(d1, created.id))}`,
    );
    expect(h.updates).toBe(6);
    expect(row).toBeNull();
    expect(row).toBeFalsy();
    // Independent of the return: the write did not land. A truthy stale row would hide this.
    expect(rawRefKeys(d1, created.id)).toEqual([]);
  });
});
