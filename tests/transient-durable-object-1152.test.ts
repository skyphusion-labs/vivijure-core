import { describe, expect, it } from "vitest";
import { classifyTransientFailure } from "../src/render-orchestrator.js";

// vivijure-cf#1152, measured on film-b3d3fc8b: this text failed a film with paid clips.
describe("a Durable Object disconnect", () => {
  it("is transient", () => {
    expect(classifyTransientFailure(
      "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
    )).toBe("transient");
  });
  it("CONTROL: a bad input stays deterministic", () => {
    expect(classifyTransientFailure("provider rejected: wrong resolution")).toBe("deterministic");
  });
});
