/// <reference types="node" />
// The DELIVERY RESOLUTION: one decided value, single-sourced, and honest about whether it was
// decided or defaulted.
//
// THE DEFECT THIS EXISTS TO PREVENT, restated because it is the reason for every odd-looking
// assertion below. Films ship at 1920x1080 today, and that is not a decision expressed anywhere.
// It is `width: input.width ?? 1920` and `height: input.height ?? 1080` defaulting INDEPENDENTLY in
// two panel modules that were never told anything. Nothing sets it; nothing could observe that
// nothing sets it, because `?? 1920` honoured and `?? 1920` substituted are byte-identical.
//
// So this file never asserts that 1920 appears. A test asserting 1920 appears passes against the
// bug. Every probe here uses a NON-DEFAULT target, and the load-bearing property is that a
// DECIDED target and a DEFAULTED one are distinguishable at the point of use -- otherwise we have
// rebuilt `?? 1920` with more steps.
//
// TWO QUANTITIES, NEVER CONFLATED. `delivery_*` is a DECISION and is what assemble and the
// film-level modules are told. A clip's `delivered_width/height` is a MEASUREMENT of what came out
// of the motion/finish chain, and its only job is choosing an upscale factor. Threading the
// measurement where the decision belongs would assemble the film at the clips' size and ship the
// opposite of the 1080p ruling.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_DELIVERY_WIDTH,
  DEFAULT_DELIVERY_HEIGHT,
  resolveDeliveryResolution,
} from "../src/film-model.js";

/** Deliberately not 1920x1080 and not a multiple of it. */
const DECIDED = { width: 1280, height: 536 };

describe("delivery resolution: decided vs defaulted must be distinguishable", () => {
  it("a film carrying an explicit target reports it, and reports it as DECIDED", () => {
    const r = resolveDeliveryResolution({ delivery_width: DECIDED.width, delivery_height: DECIDED.height });
    expect(r.width).toBe(DECIDED.width);
    expect(r.height).toBe(DECIDED.height);
    expect(r.decided).toBe(true);
  });

  it("a film carrying nothing gets the estate default AND is reported as NOT decided", () => {
    // The whole point. If `decided` did not exist, this return value would be indistinguishable
    // from the case above -- which is exactly the state the panel modules are in today.
    const r = resolveDeliveryResolution({});
    expect(r.width).toBe(DEFAULT_DELIVERY_WIDTH);
    expect(r.height).toBe(DEFAULT_DELIVERY_HEIGHT);
    expect(r.decided).toBe(false);
  });

  it("a PARTIAL target is not a decision -- both axes or neither", () => {
    // A half-supplied target is a bug upstream, not a decision. Silently completing it from the
    // default would produce a confident wrong aspect ratio, which is worse than defaulting both.
    for (const partial of [
      { delivery_width: DECIDED.width },
      { delivery_height: DECIDED.height },
      { delivery_width: DECIDED.width, delivery_height: 0 },
      { delivery_width: Number.NaN, delivery_height: DECIDED.height },
    ]) {
      const r = resolveDeliveryResolution(partial);
      expect(r.decided).toBe(false);
      expect(r.width).toBe(DEFAULT_DELIVERY_WIDTH);
      expect(r.height).toBe(DEFAULT_DELIVERY_HEIGHT);
    }
  });

  it("the default is ONE constant, not a literal repeated per consumer", () => {
    // The defect was two independent `??` defaults. Consumers must reference the constant, so
    // changing the estate default is one edit and cannot half-land.
    expect(typeof DEFAULT_DELIVERY_WIDTH).toBe("number");
    expect(typeof DEFAULT_DELIVERY_HEIGHT).toBe("number");
    expect(DEFAULT_DELIVERY_WIDTH).toBeGreaterThan(0);
    expect(DEFAULT_DELIVERY_HEIGHT).toBeGreaterThan(0);
    // Conrad's ruling, asserted as the CURRENT value rather than as a law: if someone changes the
    // estate default they must change it here too, which is the point of a single source.
    expect([DEFAULT_DELIVERY_WIDTH, DEFAULT_DELIVERY_HEIGHT]).toEqual([1920, 1080]);
  });

  it("the resolver is total: it never returns a zero or NaN geometry", () => {
    // A zero reaching the container is letterboxing into nothing. Every refusal path must land on
    // the default rather than pass a broken value through.
    for (const bad of [
      {}, { delivery_width: 0, delivery_height: 0 },
      { delivery_width: -1280, delivery_height: -536 },
      { delivery_width: Number.NaN, delivery_height: Number.NaN },
      { delivery_width: Number.POSITIVE_INFINITY, delivery_height: 536 },
    ]) {
      const r = resolveDeliveryResolution(bad);
      expect(Number.isFinite(r.width)).toBe(true);
      expect(Number.isFinite(r.height)).toBe(true);
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
  });

  it("a decided target survives verbatim -- it is never normalised toward the default", () => {
    // Non-default on BOTH axes, and deliberately an odd aspect, so a helpful `Math.round` toward
    // 16:9 or a silent clamp would show up here rather than in production.
    const odd = resolveDeliveryResolution({ delivery_width: 1001, delivery_height: 337 });
    expect(odd.width).toBe(1001);
    expect(odd.height).toBe(337);
    expect(odd.decided).toBe(true);
  });
});
