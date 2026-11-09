// D1 helpers for persisted storyboard projects (v0.53.0). One row per project; holds a free-form
// prefs object and a snapshot of the last saved storyboard so the planner can resume across
// sessions and devices.
//
// Vivijure is a SINGLE-OPERATOR studio: there is no per-user scoping. Slugs are globally unique;
// every query is unscoped (the legacy identity column was removed in the identity strip; memory:
// vivijure-user-email-strip). Mirrors src/cast-db.ts shape: pure-row interface, slug allocation
// bounded at 200 attempts.

import type { DbEnv } from "./db-env.js";
import { newPublicId } from "./public-id.js";
import { normalizeProjectName } from "./storyboard-validate.js";

export interface StoryboardProject {
  // Internal autoincrement PK -- join/FK key; NEVER leaves the core (the API exposes public_id).
  id: number;
  // Unguessable public id (UUID v4); the ONLY id the API accepts on a :id route and returns as `id`.
  public_id: string;
  slug: string;
  name: string;
  prefs: Record<string, unknown>;
  last_storyboard: unknown | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: number;
  public_id: string;
  slug: string;
  name: string;
  prefs_json: string;
  last_storyboard_json: string | null;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToProject(row: ProjectRow): StoryboardProject {
  return {
    id: row.id,
    public_id: row.public_id,
    slug: row.slug,
    name: row.name,
    prefs: parseJson<Record<string, unknown>>(row.prefs_json, {}),
    last_storyboard: row.last_storyboard_json
      ? parseJson<unknown>(row.last_storyboard_json, null)
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// The client-facing project shape: `id` is the opaque public id; the internal integer PK is dropped
// so a sequential id never leaves the core (S9 F13). Every API site that returns a project maps
// through toPublicProject.
export type PublicStoryboardProject = Omit<StoryboardProject, "id" | "public_id"> & { id: string };

export function toPublicProject(row: StoryboardProject): PublicStoryboardProject {
  const { id: _internalId, public_id, ...rest } = row;
  return { ...rest, id: public_id };
}

// URL-safe slug from a display name. Empty / all-punctuation falls
// back to "project". Matches the planner-side slug rules.
export function slugifyProject(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "project";
}

export async function allocateProjectSlug(env: DbEnv, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(
      `SELECT id FROM storyboard_projects WHERE slug = ? LIMIT 1`
    )
      .bind(candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate project slug after 200 attempts (base='${base}')`);
}

// Bound the project list so it can never scan unboundedly (issue #12). Generous, so the
// newest-first list is effectively complete while the query stays capped.
const PROJECT_LIST_LIMIT = 500;

export async function listProjects(env: DbEnv): Promise<StoryboardProject[]> {
  const result = await env.DB.prepare(
    `SELECT id, public_id, slug, name, prefs_json, last_storyboard_json,
            created_at, updated_at
       FROM storyboard_projects
      ORDER BY created_at DESC
      LIMIT ?`
  )
    .bind(PROJECT_LIST_LIMIT)
    .all<ProjectRow>();
  return (result.results || []).map(rowToProject);
}

// Resolve an opaque public id to the internal integer PK (the :id route + ?project_id boundary).
// Null when no project carries that public_id -- a bare integer matches nothing, so callers 404.
export async function getProjectIdByPublicId(env: DbEnv, publicId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM storyboard_projects WHERE public_id = ? LIMIT 1`,
  )
    .bind(publicId)
    .first<{ id: number }>();
  return row ? Number(row.id) : null;
}

export async function getProjectById(env: DbEnv, id: number): Promise<StoryboardProject | null> {
  const row = await env.DB.prepare(
    `SELECT id, public_id, slug, name, prefs_json, last_storyboard_json,
            created_at, updated_at
       FROM storyboard_projects
      WHERE id = ?
      LIMIT 1`
  )
    .bind(id)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function createProject(
  env: DbEnv,
  input: { name: string; prefs?: Record<string, unknown> },
): Promise<StoryboardProject> {
  const baseSlug = slugifyProject(input.name);
  const slug = await allocateProjectSlug(env, baseSlug);
  const prefsJson = JSON.stringify(input.prefs ?? {});
  const row = await env.DB.prepare(
    `INSERT INTO storyboard_projects (public_id, slug, name, prefs_json)
     VALUES (?, ?, ?, ?)
     RETURNING id, public_id, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`
  )
    .bind(newPublicId(), slug, input.name, prefsJson)
    .first<ProjectRow>();
  if (!row) throw new Error("createProject: INSERT...RETURNING produced no row");
  return rowToProject(row);
}

export async function updateProjectMeta(
  env: DbEnv,
  id: number,
  patch: { name?: string; prefs?: Record<string, unknown> },
): Promise<StoryboardProject | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.prefs !== undefined) {
    fields.push("prefs_json = ?");
    values.push(JSON.stringify(patch.prefs));
  }
  if (fields.length === 0) {
    return getProjectById(env, id);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  const row = await env.DB.prepare(
    `UPDATE storyboard_projects SET ${fields.join(", ")}
      WHERE id = ?
     RETURNING id, public_id, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`
  )
    .bind(...values)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

// ---- board key collisions (core#518, vivijure-backend#487) ----
//
// The backend keys every stored artifact of a render by the BOARD TITLE, not the project name:
// `normalizeProjectName(title)` builds `bundles/<key>-<hex>.tar.gz`, the studio remaps the render's
// `project` to `<key>`, and the backend writes `renders/<key>/...` and `loras/<key>/...` and reads them
// back as prior state. Two projects whose titles share a key would reuse each other's keyframes and
// LoRAs. So a board is refused when another project in this tenant already holds its key.
//
// The rule is core's `normalizeProjectName`, which is the one that reaches the backend (stricter than
// the backend's own `_slug`, which leaves a key core produces unchanged; tests/project-key-contract-487).

/** The backend project key a board would render under, or null when it has no usable title (an
 *  untitled draft cannot be bundled: storyboard validation requires a title). */
export function boardKeySlug(board: unknown): string | null {
  if (typeof board !== "object" || board === null || Array.isArray(board)) return null;
  const title = (board as { title?: unknown }).title;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  return normalizeProjectName(title);
}

export interface BoardKeyHolder {
  /** The holder's public id (never the internal PK). */
  id: string;
  name: string;
  title: string;
}

/** A board refused because another project already renders under its key. A host maps it to 409. */
export class BoardKeyCollisionError extends Error {
  readonly slug: string;
  readonly existing: BoardKeyHolder;
  constructor(slug: string, existing: BoardKeyHolder) {
    super(
      `board title "${existing.title}" of project "${existing.name}" (${existing.id}) already uses the ` +
      `render key "${slug}". Two boards with one key would share each other's stored keyframes and ` +
      `LoRAs. Give this board a different title.`,
    );
    this.name = "BoardKeyCollisionError";
    this.slug = slug;
    this.existing = existing;
  }
}

/** The other project in this tenant whose saved board renders under `slug`, or null.
 *
 *  Reads every project with a saved board, not a bounded page: a cap would make "no holder" mean "not in
 *  the first N", which is the absence this check exists to rule out. Only the title is read from SQL
 *  (`json_extract`), so the cost is one short string per project. A row whose stored board is not valid
 *  JSON is skipped by `json_valid` rather than failing the save. */
export async function findBoardKeyHolder(
  env: DbEnv,
  slug: string,
  excludeId: number,
): Promise<BoardKeyHolder | null> {
  const result = await env.DB.prepare(
    `SELECT public_id, name, json_extract(last_storyboard_json, '$.title') AS title
       FROM storyboard_projects
      WHERE id != ?
        AND last_storyboard_json IS NOT NULL
        AND json_valid(last_storyboard_json)
      ORDER BY created_at ASC, id ASC`
  )
    .bind(excludeId)
    .all<{ public_id: string; name: string; title: unknown }>();
  for (const r of result.results || []) {
    if (typeof r.title !== "string" || r.title.trim().length === 0) continue;
    if (normalizeProjectName(r.title) === slug) return { id: r.public_id, name: r.name, title: r.title };
  }
  return null;
}

/** Save `storyboard` as project `id`'s last board. Throws `BoardKeyCollisionError`, writing nothing,
 *  when another project's board already uses its key (core#518). Saving a project's own board again, or
 *  retitling it, is never refused by itself. Not transactional: two concurrent first saves of one key can
 *  both pass, which a host serializing saves per tenant would close. */
export async function setLastStoryboard(
  env: DbEnv,
  id: number,
  storyboard: unknown,
): Promise<StoryboardProject | null> {
  const slug = boardKeySlug(storyboard);
  if (slug !== null) {
    const holder = await findBoardKeyHolder(env, slug, id);
    if (holder) throw new BoardKeyCollisionError(slug, holder);
  }
  const sbJson = JSON.stringify(storyboard);
  const row = await env.DB.prepare(
    `UPDATE storyboard_projects
        SET last_storyboard_json = ?, updated_at = datetime('now')
      WHERE id = ?
     RETURNING id, public_id, slug, name, prefs_json, last_storyboard_json,
               created_at, updated_at`
  )
    .bind(sbJson, id)
    .first<ProjectRow>();
  return row ? rowToProject(row) : null;
}

export async function deleteProject(env: DbEnv, id: number): Promise<StoryboardProject | null> {
  const cur = await getProjectById(env, id);
  if (!cur) return null;
  await env.DB.prepare(
    `DELETE FROM storyboard_projects WHERE id = ?`
  )
    .bind(id)
    .run();
  return cur;
}
