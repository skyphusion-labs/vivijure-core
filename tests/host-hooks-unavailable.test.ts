// host.hooks_unavailable (vivijure-cf#98): a host declaring which hooks it cannot actually serve.
//
// The defect this closes: a module being INSTALLED and its hook being SERVICEABLE are different
// facts, and the wire payload only ever carried the first. A hosted tenant provisioned without the
// AI binding still got a fully populated planning-model picker in which every option 500s -- the
// broken-button class. No frontend work could fix it, because the fact was not on the wire.
//
// The projection is GENERIC on purpose. The frontend renders any listed hook that appears here as
// unavailable with its reason printed verbatim, so a future unserviceable hook needs no new UI.

import { describe, expect, it } from "vitest";
import { modulesResponse } from "../src/modules/registry.js";
import { HOOK_NAMES } from "../src/modules/types.js";

const RENDER = { backend: "none" } as never;

describe("host.hooks_unavailable", () => {
  it("is carried through verbatim, reason string untouched", () => {
    const reason = "AI Gateway is not configured on this host, so storyboard planning is unavailable here. Ask whoever runs this studio to enable it.";
    const res = modulesResponse([], RENDER, { dispatch: false, hooks_unavailable: { "plan.enhance": reason } });
    // Verbatim: the UI prints this to a user, so a host that rewrites or truncates it would be
    // putting words in the operator's mouth.
    expect(res.host?.hooks_unavailable?.["plan.enhance"]).toBe(reason);
  });

  it("is OMITTED when a host serves everything -- absence means available", () => {
    const res = modulesResponse([], RENDER, { dispatch: true });
    expect(res.host?.hooks_unavailable).toBeUndefined();
  });

  it("an EMPTY object is a valid 'everything is serviceable' statement", () => {
    // Distinct from omission on the wire, identical in meaning. Both must be safe for the renderer,
    // because a host that computes the map and finds nothing wrong will send {}.
    const res = modulesResponse([], RENDER, { dispatch: true, hooks_unavailable: {} });
    expect(res.host?.hooks_unavailable).toEqual({});
  });

  it("does not disturb the other host capabilities", () => {
    const res = modulesResponse([], RENDER, {
      dispatch: true,
      readonly: true,
      render: { available: false },
      assistant: { model: "oss", note: "n" },
      hooks_unavailable: { "plan.enhance": "r" },
    });
    expect(res.host).toMatchObject({
      dispatch: true,
      readonly: true,
      render: { available: false },
      assistant: { model: "oss", note: "n" },
      hooks_unavailable: { "plan.enhance": "r" },
    });
  });

  it("keys are hook names the catalog actually knows about", () => {
    // Not enforced at runtime (a host may know about a hook this core does not), but a typo'd key is
    // silently ignored by a generic renderer, so the SHIPPED first entry is pinned here.
    expect(HOOK_NAMES).toContain("plan.enhance");
  });

  it("MODULE_API is unchanged -- host is additive by contract", () => {
    const before = modulesResponse([], RENDER, { dispatch: true }).api;
    const after = modulesResponse([], RENDER, { dispatch: true, hooks_unavailable: { "plan.enhance": "r" } }).api;
    expect(after).toBe(before);
  });
});
