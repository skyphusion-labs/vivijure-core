import { describe, it, expect } from "vitest";
import { filmJobToPollView } from "../src/film-render-bridge.js";
import { scatterJobToPollView } from "../src/scatter-orchestrator.js";
import type { FilmJob } from "../src/film-model.js";
import type { ScatterJob } from "../src/scatter-orchestrator-types.js";

// fc#1662 follow-up: a film that ships WITHOUT its title card or subtitles is `done`, carries no
// error, and is indistinguishable in render history from a film that shipped complete.
//
// The chain records exactly what is needed -- `film_finish.degraded` is set "when cards were
// requested but could not be applied", and the type's own comment says it exists to prevent "a
// silent green". It was simply never carried onto the poll view, and the poll view is what becomes
// the render row (`updateRenderFromView` -> `output_json`). So the estate cannot COUNT how often a
// film ships decarded, which makes every fix for fc#1662 a trade against an unmeasurable incidence.
//
// THE STATE LADDER, and the reason it is four states rather than a boolean:
//
//   key absent        this row predates the change -- NOT MEASURED
//   film_finish null  the chain did not run (no film.finish module installed, nothing to card)
//   degraded null     the chain ran and applied everything asked of it
//   degraded "..."    the chain ran and SHIPPED UNCARDED, with the reason
//
// Absence must never render as a value: collapsing "no cards were requested" into "cards applied
// cleanly" would rebuild the defect one field over, which is the whole subject of this sprint.

const doneFilm = (over: Partial<FilmJob> = {}): FilmJob =>
  ({
    film_id: "film-abc",
    project: "p",
    phase: "done",
    created_at: Date.now() - 1000,
    film_key: "renders/film-abc/film-ff0.mp4",
    scenes: [],
    finish_shots: [],
    ...over,
  }) as unknown as FilmJob;

const doneScatter = (over: Partial<ScatterJob> = {}): ScatterJob =>
  ({
    scatter_id: "scatter-abc",
    project: "p",
    phase: "done",
    created_at: Date.now() - 1000,
    film_key: "renders/scatter-abc/film.mp4",
    bundle_key: "bundles/scatter-abc.tar.gz",
    shard_film_ids: ["shard-a"],
    shard_shots: [["shot_01"]],
    expected_shot_ids: ["shot_01"],
    scenes: [],
    ...over,
  }) as unknown as ScatterJob;

const DEGRADED = {
  applied: [] as string[],
  adopted: [] as string[],
  errors: ["film-titles: video-finish container job not found (restarted); resubmit (after 3 attempts)"],
  degraded: "film-titles: video-finish container job not found (restarted); resubmit (after 3 attempts)",
};

const CLEAN = { applied: ["film-titles"], adopted: [] as string[], errors: [] as string[] };

describe("fc#1662: a decarded film must be countable from the render row", () => {
  it("CONTROL: the job doc already holds the degradation -- only the surfacing is missing", () => {
    // Not in doubt, but it anchors everything below: if this ever stops being true the rest of this
    // file is asserting about a field nobody writes, which is the failure mode next door
    // (`finish_elapsed_ms` has a writer and is NULL on every row because nothing produces a value).
    const job = doneFilm({ film_finish: DEGRADED } as Partial<FilmJob>);
    expect((job as unknown as { film_finish: { degraded: string } }).film_finish.degraded).toMatch(/not found/);
  });

  it("a DEGRADED film surfaces the reason on the view (single-film path)", () => {
    const v = filmJobToPollView(doneFilm({ film_finish: DEGRADED } as Partial<FilmJob>), null);
    expect(v.status).toBe("COMPLETED");
    const ff = (v.output as Record<string, unknown>).film_finish as { degraded: string | null };
    expect(ff).toBeTruthy();
    expect(ff.degraded).toMatch(/not found/);
  });

  it("a DEGRADED film surfaces the reason on the view (scatter path)", () => {
    const v = scatterJobToPollView(doneScatter({ film_finish: DEGRADED } as Partial<ScatterJob>));
    expect(v.status).toBe("COMPLETED");
    const ff = (v.output as Record<string, unknown>).film_finish as { degraded: string | null };
    expect(ff).toBeTruthy();
    expect(ff.degraded).toMatch(/not found/);
  });

  it("a CLEAN run reports degraded null and the steps it ran, never an absent field", () => {
    const v = filmJobToPollView(doneFilm({ film_finish: CLEAN } as Partial<FilmJob>), null);
    const ff = (v.output as Record<string, unknown>).film_finish as {
      degraded: string | null; applied: string[]; adopted: string[];
    };
    expect(ff.degraded).toBeNull();
    expect(ff.applied).toEqual(["film-titles"]);
    expect(ff.adopted).toEqual([]);
  });

  it("ADOPTED steps are reported, because they count the wasted re-encodes fc#1662 causes", () => {
    const v = filmJobToPollView(
      doneFilm({ film_finish: { applied: [], adopted: ["film-titles"], errors: [] } } as Partial<FilmJob>),
      null,
    );
    const ff = (v.output as Record<string, unknown>).film_finish as { adopted: string[] };
    expect(ff.adopted).toEqual(["film-titles"]);
  });

  it("a chain that never ran reports null, which is NOT the same as running cleanly", () => {
    const v = filmJobToPollView(doneFilm(), null);
    const out = v.output as Record<string, unknown>;
    // The KEY is present (this row was measured) and its value is null (nothing to card). A reader
    // can tell that apart from a clean run, and from a row written before this change.
    expect("film_finish" in out).toBe(true);
    expect(out.film_finish).toBeNull();
  });

  it("CONTROL: the four states are mutually distinguishable, which is the point of the shape", () => {
    const notMeasured = { } as Record<string, unknown>;                                   // pre-change row
    const didNotRun = filmJobToPollView(doneFilm(), null).output as Record<string, unknown>;
    const ranClean = filmJobToPollView(doneFilm({ film_finish: CLEAN } as Partial<FilmJob>), null).output as Record<string, unknown>;
    const ranDegraded = filmJobToPollView(doneFilm({ film_finish: DEGRADED } as Partial<FilmJob>), null).output as Record<string, unknown>;

    const classify = (o: Record<string, unknown>): string => {
      if (!("film_finish" in o)) return "not-measured";
      const ff = o.film_finish as { degraded: string | null } | null;
      if (ff === null) return "did-not-run";
      return ff.degraded === null ? "ran-clean" : "ran-degraded";
    };
    const seen = [classify(notMeasured), classify(didNotRun), classify(ranClean), classify(ranDegraded)];
    expect(seen).toEqual(["not-measured", "did-not-run", "ran-clean", "ran-degraded"]);
    expect(new Set(seen).size).toBe(4); // no two states collapse
  });
});
