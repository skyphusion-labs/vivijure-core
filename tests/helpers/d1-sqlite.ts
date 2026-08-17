// A D1-shaped facade over a REAL SQLite engine, with the REAL vivijure-cf migrations applied.
//
// WHY THIS EXISTS. Every other renders-db test in this suite fakes `env.DB` with an object that
// RECORDS the SQL string and returns a canned result. That is the right tool for asserting which
// statement was issued, and it is structurally incapable of testing the SEMANTICS of a statement --
// `ORDER BY submitted_at ASC LIMIT 25` returns whatever the fake decides to return, so a fake can
// never observe that the newest row is never reached (core#180). A stubbed input encodes the
// author's own assumption; here the assumption IS the thing under test.
//
// So: a real engine, the real schema, and the SHIPPED query text (the test imports the exported
// function rather than restating its SQL -- a suite that defines its own half of a contract passes
// forever, see the crew corpus on cross-repo contracts).
//
// `node:sqlite` is stdlib on Node 22+, so this adds ZERO dependencies, runtime or dev.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** Locate vivijure-cf's migrations. Mirrors the checkout layouts vitest.config.ts already probes. */
export function cfMigrationsDir(): string {
  const candidates = [
    resolve(repoRoot, "vivijure/migrations"), // CI sparse-checkout into repo-root/vivijure
    resolve(repoRoot, "../vivijure-cf/migrations"), // sibling clone
    resolve(repoRoot, "../vivijure/migrations"), // legacy sibling alias
    resolve(repoRoot, "../../vivijure/migrations"), // vivijure-local CI layout
  ];
  const hit = candidates.find((c) => existsSync(resolve(c, "0001_init.sql")));
  if (!hit) {
    // REFUSE rather than degrade. A harness that silently proceeds with no schema produces an
    // empty table, and an empty table makes every assertion below vacuously true -- a green run
    // about nothing. Failing loudly is the only honest option.
    throw new Error(
      "vivijure-cf migrations not found (looked for 0001_init.sql in: " +
        candidates.join(", ") +
        "). Clone skyphusion-labs/vivijure-cf as a sibling, or sparse-checkout it to ./vivijure.",
    );
  }
  return hit;
}

/** Top-level migrations only, in lexical order. `manual/` and `demo/` are deliberately excluded:
 *  they are not part of the auto-applied schema and one of them DROPs a column. */
export function migrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export interface TestD1 {
  /** The D1-shaped binding to hand to code under test as `env.DB`. */
  DB: unknown;
  /** Direct engine access for fixtures and for independent verification of what the code did. */
  raw: DatabaseSync;
  /** Applied migration filenames, so a test can assert a non-zero denominator. */
  applied: string[];
  close(): void;
}

/**
 * Open an in-memory SQLite with the real cf schema and wrap it in the subset of the D1 API this
 * codebase uses: `prepare(sql).bind(...).all() / .run() / .first()`, plus the unbound forms.
 */
export function openTestD1(): TestD1 {
  const db = new DatabaseSync(":memory:");
  const dir = cfMigrationsDir();
  const files = migrationFiles(dir);
  if (files.length === 0) {
    throw new Error(`no .sql migrations in ${dir} -- refusing to run against an empty schema`);
  }
  for (const f of files) {
    const sql = readFileSync(resolve(dir, f), "utf8");
    try {
      db.exec(sql);
    } catch (e) {
      throw new Error(`migration ${f} failed to apply: ${(e as Error).message}`);
    }
  }

  const exec = (sql: string, binds: unknown[]) => {
    const stmt = db.prepare(sql);
    // node:sqlite accepts null/number/string/bigint/Uint8Array. D1 callers pass undefined for
    // "no value"; normalise it to null so a bind mismatch is not silently a different query.
    const vals = binds.map((b) => (b === undefined ? null : b)) as never[];
    const isRead = /^\s*(select|with|pragma)/i.test(sql);
    // INSERT/UPDATE ... RETURNING is a write that still produces rows. stmt.run()
    // discards them, so first() would always be null and createCast / CAS updates
    // would look like failures against this harness (core#234).
    const hasReturning = /\breturning\b/i.test(sql);
    if (isRead || hasReturning) {
      const rows = stmt.all(...vals) as Record<string, unknown>[];
      return { rows, changes: hasReturning ? rows.length : 0 };
    }
    const info = stmt.run(...vals);
    return { rows: [] as Record<string, unknown>[], changes: Number(info.changes ?? 0) };
  };

  const bound = (sql: string, binds: unknown[]) => ({
    async all<T = Record<string, unknown>>() {
      const { rows } = exec(sql, binds);
      return { results: rows as T[], success: true, meta: { changes: 0 } };
    },
    async run() {
      const { changes } = exec(sql, binds);
      return { success: true, meta: { changes } };
    },
    async first<T = Record<string, unknown>>(col?: string) {
      const { rows } = exec(sql, binds);
      const row = rows[0];
      if (!row) return null;
      return (col ? (row[col] as T) : (row as unknown as T)) ?? null;
    },
  });

  const DB = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          return bound(sql, binds);
        },
        ...bound(sql, []),
      };
    },
    async batch(stmts: { all(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.all());
      return out;
    },
  };

  return { DB, raw: db, applied: files, close: () => db.close() };
}
