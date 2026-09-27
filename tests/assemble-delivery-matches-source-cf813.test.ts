/// <reference types="node" />
// cf#813 FINDING 1: the assemble target must MATCH THE SOURCE, not a constant.
//
// The seam used to call resolveDeliveryResolution(job) and nothing else. Since nothing in either
// repo ever sets delivery_width / delivery_height, that is 1920x1080 on every film in production,
// applied unconditionally with no source-equals-target short circuit. Most installed motion doors
// default BELOW it, so the normal case was an upscale carrying no information; a door configured
// above it was destructively downscaled.
//
// THE RULE HAS TWO HALVES AND A RULE PROVEN IN ONE DIRECTION IS HALF A RULE, so both are pinned:
// never upscale, and never downscale.
//
// The mixed case cannot honour both, because the concat is `-c copy` and needs one geometry. That
// makes it a CHOICE, and the choice is asserted here rather than left to fall out of whatever the
// constant happened to be.

import { describe, expect, it } from "vitest";
import { selectDeliveryFromMeasured, DEFAULT_DELIVERY_WIDTH, DEFAULT_DELIVERY_HEIGHT } from "../src/film-model.js";
import { resolveAssembleDelivery } from "../src/film-orchestrator.js";

// Real door geometries, deliberately not round multiples of the default on either axis, so a
// fabricated 1920x1080 is visible rather than blending into an expected value.
const P720 = { width: 1280, height: 720 };
const P1080 = { width: 1920, height: 1080 };
const P4K = { width: 3840, height: 2160 };
const VERT = { width: 1080, height: 1920 };
const DRAFT = { width: 864, height: 496 };

describe("selectDeliveryFromMeasured: the pure rule", () => {
  it("NEVER UPSCALE: a 720p film delivers at 720p", () => {
    const d = selectDeliveryFromMeasured([P720, P720, P720]);
    expect(d).toEqual({ width: 1280, height: 720, decided: true, basis: "measured-source" });
    // The whole point: it is NOT the old constant.
    expect(d.width).not.toBe(DEFAULT_DELIVERY_WIDTH);
  });

  it("NEVER DOWNSCALE: a 4k film is not destroyed to hit the constant", () => {
    const d = selectDeliveryFromMeasured([P4K, P4K]);
    expect(d).toEqual({ width: 3840, height: 2160, decided: true, basis: "measured-source" });
  });

  it("a genuinely 1080p film still delivers 1080p, but as a MEASUREMENT not a default", () => {
    // Same numbers as the old constant, different basis. Without `basis` these two states are
    // indistinguishable, which is exactly the condition this issue is about.
    const d = selectDeliveryFromMeasured([P1080, P1080]);
    expect(d.width).toBe(1920);
    expect(d.height).toBe(1080);
    expect(d.basis).toBe("measured-source");
    expect(d.decided).toBe(true);
  });

  it("ASPECT RATIO falls out of the same rule: a vertical film targets a vertical frame", () => {
    // The second axis of the same defect. pad= used to pillarbox a 9:16 clip into a landscape
    // frame; matching the source means the frame is 9:16 and there is nothing to pillarbox.
    const d = selectDeliveryFromMeasured([VERT, VERT]);
    expect(d).toEqual({ width: 1080, height: 1920, decided: true, basis: "measured-source" });
  });

  it("MIXED: takes the largest-area geometry and labels it as mixed", () => {
    const d = selectDeliveryFromMeasured([P720, P1080, DRAFT]);
    expect(d).toEqual({ width: 1920, height: 1080, decided: true, basis: "measured-source-mixed" });
  });

  it("MIXED never invents a geometry no clip has -- the componentwise-max trap", () => {
    // THE case that makes this rule non-obvious. max(width) and max(height) taken independently
    // over a landscape and a portrait clip give 1920x1920: an aspect ratio nothing rendered, which
    // would pillarbox AND letterbox every clip in the film. A real pair cannot do that.
    const d = selectDeliveryFromMeasured([P1080, VERT]);
    expect(d.width * d.height).toBe(1920 * 1080);
    expect([`${d.width}x${d.height}`]).toContain(
      d.width > d.height ? "1920x1080" : "1080x1920",
    );
    // The explicit negative: never the invented square.
    expect(`${d.width}x${d.height}`).not.toBe("1920x1920");
    // And the chosen pair is one a real clip actually had.
    expect([P1080, VERT].some((m) => m.width === d.width && m.height === d.height)).toBe(true);
  });

  it("ties resolve deterministically, so input order cannot change the film", () => {
    const a = selectDeliveryFromMeasured([P1080, VERT]);
    const b = selectDeliveryFromMeasured([VERT, P1080]);
    expect(a).toEqual(b);
  });

  it("a MISS is a default and says so, rather than being reported as a measurement", () => {
    const d = selectDeliveryFromMeasured([]);
    expect(d).toEqual({
      width: DEFAULT_DELIVERY_WIDTH,
      height: DEFAULT_DELIVERY_HEIGHT,
      decided: false,
      basis: "default-unmeasured",
    });
  });

  it("unusable rows are filtered, and ALL-unusable lands on the default", () => {
    const withJunk = selectDeliveryFromMeasured([
      { width: 0, height: 720 }, { width: -1, height: -1 },
      { width: Number.NaN, height: 720 }, P720,
    ]);
    expect(withJunk).toEqual({ width: 1280, height: 720, decided: true, basis: "measured-source" });

    const allJunk = selectDeliveryFromMeasured([{ width: 0, height: 0 }, { width: Number.NaN, height: 5 }]);
    expect(allJunk.basis).toBe("default-unmeasured");
    expect(allJunk.decided).toBe(false);
  });
});

/** An env whose clip-doc GET returns exactly what a case wants. `undefined` => no object at all. */
function envWith(doc: unknown) {
  return {
    R2_RENDERS: {
      get: async () => (doc === undefined ? null : { text: async () => JSON.stringify(doc) }),
    },
  } as unknown as Parameters<typeof resolveAssembleDelivery>[0];
}
const job = (o: Record<string, unknown>) => o as unknown as Parameters<typeof resolveAssembleDelivery>[1];
const doc = (shots: unknown[]) => ({ job_id: "cj1", shots });
const shot = (id: string, m: { width: number; height: number }) =>
  ({ shot_id: id, status: "done", delivered_width: m.width, delivered_height: m.height });

describe("resolveAssembleDelivery: precedence at the seam", () => {
  it("POSITIVE CONTROL: the harness really reaches the lookup", async () => {
    // Without this, every assertion below could pass vacuously on a lookup that never ran and
    // silently returned the default -- which is the same 1920x1080 the defect produced. A sibling
    // test file records losing four of six assertions to exactly that.
    const d = await resolveAssembleDelivery(envWith(doc([shot("a", DRAFT)])), job({ clip_job_id: "cj1" }));
    expect(d.basis).toBe("measured-source");
    expect(d).toMatchObject({ width: 864, height: 496 });
  });

  it("an explicit operator target WINS over the measurement", async () => {
    // A measurement must never silently override a decision.
    const d = await resolveAssembleDelivery(
      envWith(doc([shot("a", P720)])),
      job({ clip_job_id: "cj1", delivery_width: 3840, delivery_height: 2160 }),
    );
    expect(d).toEqual({ width: 3840, height: 2160, decided: true, basis: "operator-override" });
  });

  it("ACCEPTANCE, direction 1: a 720p-source film assembles at 720p (no upscale)", async () => {
    const d = await resolveAssembleDelivery(
      envWith(doc([shot("a", P720), shot("b", P720)])),
      job({ clip_job_id: "cj1" }),
    );
    expect(d.width).toBe(1280);
    expect(d.height).toBe(720);
  });

  it("ACCEPTANCE, direction 2: a 4k-source film is NOT downscaled", async () => {
    const d = await resolveAssembleDelivery(
      envWith(doc([shot("a", P4K), shot("b", P4K)])),
      job({ clip_job_id: "cj1" }),
    );
    expect(d.width).toBe(3840);
    expect(d.height).toBe(2160);
  });

  it("no clip_job_id, no doc, and an unreadable doc all land on the labelled default", async () => {
    for (const [name, env, j] of [
      ["no clip_job_id", envWith(doc([shot("a", P720)])), job({})],
      ["no document", envWith(undefined), job({ clip_job_id: "cj1" })],
      ["no measured shots", envWith(doc([{ shot_id: "a", status: "done" }])), job({ clip_job_id: "cj1" })],
    ] as const) {
      const d = await resolveAssembleDelivery(env, j);
      expect(d.basis, name).toBe("default-unmeasured");
      expect(d.decided, name).toBe(false);
      expect(d.width, name).toBe(DEFAULT_DELIVERY_WIDTH);
    }
  });
});
