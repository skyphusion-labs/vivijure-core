import { describe, it, expect } from "vitest";
import { summarizeFilm, type FilmJob } from "../src/film-model.js";

// cf#365: assemble-stage content length was already on the job doc (film_output_seconds at the
// deterministic concat key) and the delivered length at film_key, but FilmSummary / poll_film
// exposed neither. Without both numbers a predicted-vs-delivered delta cannot be decomposed.

function baseJob(over: Partial<FilmJob> = {}): FilmJob {
  return {
    film_id: "film-365",
    project: "p",
    bundle_key: "bundles/x.tar.gz",
    scenes: [{ shot_id: "s1", prompt: "p", seconds: 4 }],
    phase: "done",
    created_at: 0,
    ...over,
  } as FilmJob;
}

describe("summarizeFilm content duration surface (cf#365)", () => {
  it("exposes assemble_ms from the deterministic film.mp4 key and output_ms from film_key", () => {
    const assembleKey = "renders/film-365/film.mp4";
    const cardedKey = "renders/film-365/film-ff1.mp4";
    const s = summarizeFilm(baseJob({
      film_key: cardedKey,
      film_output_seconds: {
        [assembleKey]: 8.0,      // pre-card assemble
        [cardedKey]: 10.571333,  // delivered after title card / finish
      },
    }), null);
    expect(s.assemble_ms).toBe(8000);
    expect(s.output_ms).toBe(10571);
    expect(s.film_key).toBe(cardedKey);
  });

  it("when no film.finish ran, assemble_ms and output_ms are the same artifact", () => {
    const key = "renders/film-365/film.mp4";
    const s = summarizeFilm(baseJob({
      film_key: key,
      film_output_seconds: { [key]: 12.0 },
    }), null);
    expect(s.assemble_ms).toBe(12000);
    expect(s.output_ms).toBe(12000);
  });

  it("omits both when film_output_seconds is absent (NOT MEASURED, never zero)", () => {
    const s = summarizeFilm(baseJob({ film_key: "renders/film-365/film.mp4" }), null);
    expect(s.assemble_ms).toBeUndefined();
    expect(s.output_ms).toBeUndefined();
  });

  it("omits output_ms when film_key is unset even if assemble was measured", () => {
    const s = summarizeFilm(baseJob({
      phase: "assemble",
      film_output_seconds: { "renders/film-365/film.mp4": 8 },
    }), null);
    expect(s.assemble_ms).toBe(8000);
    expect(s.output_ms).toBeUndefined();
  });

  it("rejects non-positive durations (honest absence, not a zero bill)", () => {
    const key = "renders/film-365/film.mp4";
    const s = summarizeFilm(baseJob({
      film_key: key,
      film_output_seconds: { [key]: 0 },
    }), null);
    expect(s.assemble_ms).toBeUndefined();
    expect(s.output_ms).toBeUndefined();
  });
});
