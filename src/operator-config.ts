// operator-config: the persistent, INSTANCE-scoped store for config_schema fields marked
// `scope: "install"` (the operator-set-once knobs, e.g. notify-email's recipient address).
//
// The identity strip (#292) zeroed user_email, so this is NOT per-user: it is per-INSTALL, keyed on
// (module_name, field_key) in the operator_module_config D1 table (migration 0005). The operator sets
// these on the studio settings page (GET/PATCH /api/modules/:name/config); the core persists them
// here and INJECTS them into the module invoke at hook time, so a field like notify_email actually
// reaches the module at render.complete. Per-render fields (scope omitted / "render") are untouched
// by this store -- they still flow through the per-render config path.
//
// The pure helpers (install-subschema projection, clamp-on-write) are vitest-testable without a D1
// binding; the two query functions are verified live (matches the user-prefs / renders-db split).

import type { Env } from "./platform/orchestrator-context.js";
import type { ConfigSchema } from "./modules/types.js";
import { validateConfig } from "./modules/registry.js";
import { runPreparedWrites } from "./renders-db.js";

/** Project a module's config_schema down to ONLY its install-scope fields. A field with no `scope`
 *  (or scope "render") is a per-render knob and is excluded -- so this store never owns render config. */
export function installSubschema(schema: ConfigSchema | undefined): ConfigSchema {
  const out: ConfigSchema = {};
  if (!schema) return out;
  for (const [key, field] of Object.entries(schema)) {
    if (field.scope === "install") out[key] = field;
  }
  return out;
}

/** Does this module expose any install-scope config at all? */
export function hasInstallConfig(schema: ConfigSchema | undefined): boolean {
  return Object.keys(installSubschema(schema)).length > 0;
}

/** The set of writable install field keys for a module (what PATCH is allowed to set). */
export function installFieldKeys(schema: ConfigSchema | undefined): string[] {
  return Object.keys(installSubschema(schema));
}

/** Keys present in `patch` that are not install-scope for this schema (unknown names or render-scope
 *  fields). Order follows `Object.keys(patch)`. Empty when patch is undefined/empty or every key is
 *  writable. Hosts that want a strict operator PATCH should 400 when this is non-empty rather than
 *  silently accepting a no-op (vivijure-cf#387). */
export function droppedInstallKeys(
  schema: ConfigSchema | undefined,
  patch: Record<string, unknown> | undefined,
): string[] {
  if (!patch) return [];
  const allowed = new Set(installFieldKeys(schema));
  return Object.keys(patch).filter((k) => !allowed.has(k));
}

/** Clamp an incoming patch to the module's install subschema, dropping unknown / render-scope keys.
 *  Reuses the SAME validateConfig clamp the invoke path uses, so a stored value can never violate the
 *  contract. Returns the full install-config (every install field, missing ones at their default).
 *  For operator-facing writes that must refuse silent discards, use `clampInstallPatchDetailed`. */
export function clampInstallPatch(
  schema: ConfigSchema | undefined,
  current: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return clampInstallPatchDetailed(schema, current, patch).next;
}

/** Like `clampInstallPatch`, but also returns the keys that were present in the patch and discarded
 *  (unknown or render-scope). Invoke-time clamping stays forgiving via `clampInstallPatch`; operator
 *  PATCH handlers should inspect `dropped` and refuse the write when non-empty. */
export function clampInstallPatchDetailed(
  schema: ConfigSchema | undefined,
  current: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): { next: Record<string, unknown>; dropped: string[] } {
  const sub = installSubschema(schema);
  const merged = { ...current, ...(patch ?? {}) };
  return {
    next: validateConfig(sub, merged),
    dropped: droppedInstallKeys(schema, patch),
  };
}

// --------------------------------------------------------------------------- D1 (verified live)

/** Read the raw stored install values for a module (field_key -> decoded scalar). No schema applied;
 *  callers pass through validateConfig / the subschema to get a contract-clean, default-filled view. */
async function readStored(env: Env, moduleName: string): Promise<Record<string, unknown>> {
  const rs = await env.DB.prepare(
    "SELECT field_key, value_json FROM operator_module_config WHERE module_name = ?",
  )
    .bind(moduleName)
    .all<{ field_key: string; value_json: string }>();
  const out: Record<string, unknown> = {};
  for (const row of rs.results ?? []) {
    try {
      out[row.field_key] = JSON.parse(row.value_json);
    } catch {
      // a corrupt row is ignored; the field falls back to its schema default downstream.
    }
  }
  return out;
}

/** The module's install-config as the INVOKE path consumes it: every install field present, missing
 *  ones at their schema default, clamped to the contract. Empty schema -> {} (a clean no-op). */
export async function loadInstallConfig(
  env: Env,
  moduleName: string,
  schema: ConfigSchema | undefined,
): Promise<Record<string, unknown>> {
  const sub = installSubschema(schema);
  if (Object.keys(sub).length === 0) return {};
  const stored = await readStored(env, moduleName);
  return validateConfig(sub, stored);
}

/** Persist an operator PATCH: clamp to the install subschema (unknown / render keys dropped), then
 *  upsert each field. Returns the resulting full install-config view.
 *
 *  Does NOT refuse unknown keys -- that is the host route's job (call `droppedInstallKeys` or
 *  `clampInstallPatchDetailed` first and 400). Keeping this function forgiving means invoke-time
 *  reloads and empty patches stay no-ops without inventing a second write path. */
export async function setInstallConfig(
  env: Env,
  moduleName: string,
  schema: ConfigSchema | undefined,
  patch: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const sub = installSubschema(schema);
  const current = await readStored(env, moduleName);
  const { next } = clampInstallPatchDetailed(schema, current, patch);
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare(
    `INSERT INTO operator_module_config (module_name, field_key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(module_name, field_key) DO UPDATE SET
       value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  const writes = Object.keys(sub).map((key) =>
    stmt.bind(moduleName, key, JSON.stringify(next[key]), now),
  );
  // Database.batch is optional (LOCAL SQLite omits it). The non-null assertion used
  // to throw on any host without batch (core#221). Same guard the scatter submit
  // already uses: one round trip when batch exists, one per statement when it does not.
  await runPreparedWrites(env, writes, "operator-config.set");
  return next;
}
