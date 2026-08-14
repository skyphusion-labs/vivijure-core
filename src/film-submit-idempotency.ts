// Film submit idempotency (cf#518).
//
// THE DEFECT. `film_id` is minted as `"film-" + crypto.randomUUID()` at two sites in
// film-orchestrator, so two identical submits produce two different ids, two jobs, and two GPU
// bills. It is not hypothetical: a D1 storage-timeout on `insertRender` turned film-941a4d3b's 201
// into a 500 and baited a retry-on-5xx client into a SECOND film -- denial-of-wallet by our own
// response. cf#695 fixed that TRIGGER (post-start bookkeeping is best-effort now) and left the
// EXPOSURE: a double-click, a client timeout, or a proxy retry still produces a second live film.
//
// WHY THE GUARD IS HERE AND NOT IN A PANEL. Both mint sites are in core, and cf, vivijure-local and
// the scatter path all funnel through them. A cf-side guard would knowingly leave the other two
// exposed, and two-panel product parity is a standing invariant.
//
// WHAT IT IS NOT. `renders-db.ts` already carries `ON CONFLICT(job_id) DO NOTHING` one module over,
// and the resemblance is a trap worth naming here rather than leaving for the next reader to
// re-derive: that clause deduplicates a retry carrying the SAME job_id. This defect mints a
// DIFFERENT id on every submit, so that clause never fires for it. What it does establish is that
// this is the layer where such things live, and that the table tolerates a uniqueness constraint.
//
// THE SHAPE, per the cf#518 ruling.
//
//   C  client-supplied idempotency key -- ZERO false positives, because the client declares intent,
//      and the double-click case IS the panel. Replaces the natural key outright when present.
//   D  short-window natural-key dedup -- the backstop for every path that cannot be changed: MCP,
//      direct API consumers, proxy retries.
//
// The window is 60 SECONDS, and the number is defended rather than picked: every mechanism this
// guards against fires in seconds (a double-click ~2s, a retry-on-5xx seconds, a proxy retry
// seconds). Nobody deliberately re-renders an identical bundle within 60 seconds. Longer starts
// eating legitimate re-renders; shorter starts missing slow client retries.
//
// REJECTED: refuse-with-409. It is hostile, and it breaks a LEGITIMATE re-render of identical
// inputs, which is exactly what someone does after a degraded run. A guard that refuses correct
// work is the guard people switch off.
//
// STORAGE. Core writes the host-supplied `env.DB` directly (renders-db.ts:302) and already ships a
// table it creates itself where it writes it (`storage_usage_meta`, storage-quota.ts:194/209). This
// mirrors that exactly: no new binding, no new storage concept, no panel migration, and each host
// keeps its own dedup state in its own D1 -- which is the correct shape anyway, since a tenant's
// dedup window is a tenant's business.
//
// FAILURE DIRECTION, decided at design time rather than discovered (the guard's own comment, so it
// cannot be tidied away): this guard FAILS OPEN. No DB, no table it cannot create, a D1 error --
// all of them proceed with the submit and report `guarded: false` with a named `reason`. A submit
// that 500s because the dedup guard could not run is strictly worse than the defect it exists to
// fix, and an unguarded submit is exactly the behaviour that shipped before this file existed.

import type { Database } from "./platform/types.js";
import { canonicalJson, sha256Hex } from "./finish-hash.js";
import { emitStructuredEvent } from "./structured-events.js";
import type { HookSelection } from "./modules/types.js";

/** Canonical DDL. Core creates this table where it writes it, so neither panel needs a migration and
 *  the guard is live the moment a host adopts the release. */
export const FILM_SUBMIT_CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS film_submit_claims (
  claim_key TEXT PRIMARY KEY,
  film_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
)`;

/** The dedup window, in seconds. See the header for why 60 and not something else. */
export const FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS = 60;

/** Env slice the guard needs. Structural, so both hosts pass their own bag with no adapter, and
 *  `DB` is OPTIONAL here even though OrchestratorEnv declares it required -- the guard must behave
 *  on a host that hands it nothing rather than throw on property access. */
export interface FilmSubmitIdempotencyEnv {
  DB?: Database;
}

/** What identifies a submit. `entry` is inside the hashed payload, so the two entry points cannot
 *  collide on inputs that happen to look alike. */
export interface FilmSubmitIdentity {
  entry: "startFilmJob" | "startFilmFromKeyframes";
  /** The render-affecting inputs, verbatim. Hashed via canonicalJson, so key order never matters. */
  natural: Record<string, unknown>;
  /** The client's declared key (C). Present -> it REPLACES the natural key entirely. */
  idempotencyKey?: string;
}

export interface FilmSubmitClaim {
  /** The film_id of the LIVE claim this submit duplicates, or null to proceed and start a film. */
  duplicateOf: string | null;
  /** The key claimed. Null only when no guard ran at all. */
  claimKey: string | null;
  /** True iff a claim row is now recorded, so a later submit inside the window can see it. */
  guarded: boolean;
  /** Why the guard did not run. Null when `guarded`. Never silent: a degrade that says nothing is
   *  indistinguishable from a guard that worked. */
  reason: string | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Trim to a real key, or undefined. A blank header is NOT a declared intent, and treating one as a
 *  key would make every keyless caller share a single claim -- which would dedup unrelated films. */
function normalizeIdempotencyKey(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * The claim key.
 *
 * Two namespaces, `idem:` and `nat:`, and the prefix is load-bearing: a client that sends the hex
 * digest of a natural key as its idempotency header must not land on that natural key's row.
 */
export async function filmSubmitClaimKey(identity: FilmSubmitIdentity): Promise<string> {
  const declared = normalizeIdempotencyKey(identity.idempotencyKey);
  if (declared !== undefined) {
    // C: the client declared intent, so the SAME key is the SAME submit whatever the inputs. That
    // property is the whole reason C has zero false positives, and it is why the declared key
    // cannot be mixed with the natural one.
    return "idem:" + (await sha256Hex(canonicalJson({ entry: identity.entry, key: declared })));
  }
  return "nat:" + (await sha256Hex(canonicalJson({ entry: identity.entry, natural: identity.natural })));
}

/** The render-affecting inputs of `startFilmJob`. Enumerated EXPLICITLY rather than spread from the
 *  args bag: a spread silently absorbs any future field into the key, so adding an unrelated
 *  parameter would start splitting claims with nothing to notice. Every field here has a test
 *  asserting a change to it changes the key. */
export function naturalKeyForStartFilmJob(args: {
  project: string;
  bundle_key: string;
  scenes: unknown;
  motion_backend?: string;
  keyframe_backend?: string;
  keyframe_config?: Record<string, unknown>;
  motion_config?: Record<string, unknown>;
  finish_config?: Record<string, Record<string, unknown>>;
  finish_select?: HookSelection;
  speech_config?: Record<string, Record<string, unknown>>;
  film_finish_config?: Record<string, Record<string, unknown>>;
  master_config?: Record<string, Record<string, unknown>>;
  keyframes_only?: boolean;
  clips_only?: boolean;
  pretrained_loras?: Record<string, string>;
  quality_tier?: "draft" | "standard" | "final";
  audio_key?: string;
  dialogue_lines?: unknown;
  cast_loras?: Record<string, number>;
  film_titles?: unknown;
}): FilmSubmitIdentity {
  return {
    entry: "startFilmJob",
    natural: {
      project: args.project,
      bundle_key: args.bundle_key,
      scenes: args.scenes ?? null,
      motion_backend: args.motion_backend ?? null,
      keyframe_backend: args.keyframe_backend ?? null,
      keyframe_config: args.keyframe_config ?? null,
      motion_config: args.motion_config ?? null,
      finish_config: args.finish_config ?? null,
      // cf#537: render-affecting. Two submits differing ONLY in which finish modules were requested
      // are different renders; omit this and the second caller silently inherits the first's chain.
      // The `?? null` convention keeps absent, {mode:"default"} and {mode:"named",modules:[]} as three
      // distinct canonical JSON values, so the three wire states survive the fingerprint.
      finish_select: args.finish_select ?? null,
      speech_config: args.speech_config ?? null,
      film_finish_config: args.film_finish_config ?? null,
      master_config: args.master_config ?? null,
      keyframes_only: !!args.keyframes_only,
      clips_only: !!args.clips_only,
      pretrained_loras: args.pretrained_loras ?? null,
      quality_tier: args.quality_tier ?? null,
      audio_key: args.audio_key ?? null,
      dialogue_lines: args.dialogue_lines ?? null,
      cast_loras: args.cast_loras ?? null,
      film_titles: args.film_titles ?? null,
    },
  };
}

/** The render-affecting inputs of `startFilmFromKeyframes`. Same explicit-enumeration rule. */
export function naturalKeyForStartFromKeyframes(args: {
  project: string;
  bundle_key: string;
  scenes: unknown;
  keyframes: unknown;
  motion_backend?: string;
  per_shot_motion?: Record<string, string>;
  motion_config?: Record<string, unknown>;
  motion_configs?: Record<string, Record<string, unknown>>;
  finish_config?: Record<string, Record<string, unknown>>;
  finish_select?: HookSelection;
  speech_config?: Record<string, Record<string, unknown>>;
  film_finish_config?: Record<string, Record<string, unknown>>;
  master_config?: Record<string, Record<string, unknown>>;
  derive_mode: "finalized" | "cloud-finalized";
  parent_render_id?: number;
  audio_key?: string;
  dialogue_lines?: unknown;
}): FilmSubmitIdentity {
  return {
    entry: "startFilmFromKeyframes",
    natural: {
      project: args.project,
      bundle_key: args.bundle_key,
      scenes: args.scenes ?? null,
      keyframes: args.keyframes ?? null,
      motion_backend: args.motion_backend ?? null,
      per_shot_motion: args.per_shot_motion ?? null,
      motion_config: args.motion_config ?? null,
      motion_configs: args.motion_configs ?? null,
      finish_config: args.finish_config ?? null,
      // cf#537: render-affecting. Two submits differing ONLY in which finish modules were requested
      // are different renders; omit this and the second caller silently inherits the first's chain.
      // The `?? null` convention keeps absent, {mode:"default"} and {mode:"named",modules:[]} as three
      // distinct canonical JSON values, so the three wire states survive the fingerprint.
      finish_select: args.finish_select ?? null,
      speech_config: args.speech_config ?? null,
      film_finish_config: args.film_finish_config ?? null,
      master_config: args.master_config ?? null,
      derive_mode: args.derive_mode,
      parent_render_id: args.parent_render_id ?? null,
      audio_key: args.audio_key ?? null,
      dialogue_lines: args.dialogue_lines ?? null,
    },
  };
}

/**
 * Claim this submit, atomically.
 *
 * ONE statement decides everything, which is what makes it a race-free claim rather than a
 * read-then-write with a window in the middle:
 *
 *   - no row            -> the INSERT arm fires, 1 change, WE WIN.
 *   - row, EXPIRED      -> the DO UPDATE arm fires (its WHERE passes), 1 change, WE WIN and the
 *                          window resets. This is the arm the load-bearing false-positive test
 *                          rides: a deliberate re-render outside the window must NOT be deduped.
 *   - row, LIVE         -> the DO UPDATE's WHERE fails, 0 changes, we LOSE and read the incumbent.
 */
export async function claimFilmSubmit(
  env: FilmSubmitIdempotencyEnv,
  identity: FilmSubmitIdentity,
  opts: { filmId: string; windowSeconds?: number },
): Promise<FilmSubmitClaim> {
  const windowSeconds = opts.windowSeconds ?? FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS;
  const db = env.DB;
  if (!db) {
    return {
      duplicateOf: null,
      claimKey: null,
      guarded: false,
      reason:
        "the studio database is unavailable, so duplicate submits cannot be detected; this submit proceeds unguarded",
    };
  }

  let claimKey: string;
  try {
    claimKey = await filmSubmitClaimKey(identity);
  } catch (e) {
    return {
      duplicateOf: null,
      claimKey: null,
      guarded: false,
      reason: `the submit claim key could not be computed (${(e as Error).message}); this submit proceeds unguarded`,
    };
  }

  const now = nowSeconds();
  const cutoff = now - windowSeconds;
  try {
    await db.prepare(FILM_SUBMIT_CLAIMS_DDL).bind().run();
    const res = await db
      .prepare(
        `INSERT INTO film_submit_claims (claim_key, film_id, claimed_at) VALUES (?, ?, ?)
         ON CONFLICT(claim_key) DO UPDATE SET film_id = excluded.film_id, claimed_at = excluded.claimed_at
         WHERE film_submit_claims.claimed_at <= ?`,
      )
      .bind(claimKey, opts.filmId, now, cutoff)
      .run();
    const changes = (res.meta as { changes?: number } | undefined)?.changes ?? 0;
    if (changes > 0) {
      return { duplicateOf: null, claimKey, guarded: true, reason: null };
    }

    // We appear to have lost. Read the incumbent -- scoped by the SAME window, so a host whose D1
    // shim reports no `meta.changes` (0 for a WON insert) cannot make us dedup against an expired
    // row. The row we read back naming OUR OWN film id is the structural tell that we actually won
    // and the `changes` read was blind; treat it as a win rather than returning a film id for a
    // film nobody has started.
    const row = await db
      .prepare("SELECT film_id FROM film_submit_claims WHERE claim_key = ? AND claimed_at > ?")
      .bind(claimKey, cutoff)
      .first<{ film_id: string }>();
    const incumbent = row?.film_id ?? null;
    if (incumbent === null || incumbent === opts.filmId) {
      return { duplicateOf: null, claimKey, guarded: true, reason: null };
    }
    emitStructuredEvent({
      ev: "film.submit.deduplicated",
      film_id: incumbent,
      dropped_film_id: opts.filmId,
      entry: identity.entry,
      keyed_by: claimKey.startsWith("idem:") ? "idempotency-key" : "natural-key",
      window_seconds: windowSeconds,
    });
    return { duplicateOf: incumbent, claimKey, guarded: true, reason: null };
  } catch (e) {
    const reason = `the submit dedup claim failed (${(e as Error).message}); this submit proceeds unguarded`;
    console.warn(`film-submit-idempotency: ${reason}`);
    return { duplicateOf: null, claimKey, guarded: false, reason };
  }
}

/**
 * Drop a claim we own.
 *
 * Scoped by `film_id` so a release can never take a DIFFERENT submit's live claim -- without that
 * predicate, a slow loser releasing on its own failure path would unlock the winner's window.
 *
 * Never throws. A release is bookkeeping on a submit that has already been decided, and letting it
 * propagate would turn a started film into an error response -- the exact #695 shape.
 */
export async function releaseFilmSubmitClaim(
  env: FilmSubmitIdempotencyEnv,
  claimKey: string | null,
  filmId: string,
): Promise<void> {
  if (!claimKey || !env.DB) return;
  try {
    await env.DB.prepare("DELETE FROM film_submit_claims WHERE claim_key = ? AND film_id = ?")
      .bind(claimKey, filmId)
      .run();
  } catch (e) {
    console.warn(
      `film-submit-idempotency: releasing claim ${claimKey} failed (${(e as Error).message}); it will expire on its own within ${FILM_SUBMIT_IDEMPOTENCY_WINDOW_SECONDS}s`,
    );
  }
}
