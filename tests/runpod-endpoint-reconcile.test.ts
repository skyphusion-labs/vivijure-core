import { describe, it, expect, vi } from "vitest";
import {
  endpointWorkersMaxNeedsRestore,
  idleScaleDownGuidance,
  fetchEndpointWorkersMax,
  reconcileRunpodEndpointWorkersMax,
  RUNPOD_REST_BASE,
} from "../src/runpod-endpoint-reconcile.js";

describe("endpointWorkersMaxNeedsRestore (pure)", () => {
  it("true when live workersMax is below spec", () => {
    expect(endpointWorkersMaxNeedsRestore(0, 4)).toBe(true);
    expect(endpointWorkersMaxNeedsRestore(2, 4)).toBe(true);
  });
  it("false when live meets or exceeds spec", () => {
    expect(endpointWorkersMaxNeedsRestore(4, 4)).toBe(false);
    expect(endpointWorkersMaxNeedsRestore(6, 4)).toBe(false);
  });
  it("false when live is unknown", () => {
    expect(endpointWorkersMaxNeedsRestore(null, 4)).toBe(false);
    expect(endpointWorkersMaxNeedsRestore(undefined, 4)).toBe(false);
  });
});

describe("idleScaleDownGuidance (pure)", () => {
  it("names the endpoint and expected workersMax", () => {
    const g = idleScaleDownGuidance("ep123", 4);
    expect(g).toContain("ep123");
    expect(g).toContain("4");
    expect(g).toContain("idle scale-down");
  });
});

describe("fetchEndpointWorkersMax", () => {
  it("parses workersMax from GET /endpoints/{id}", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: "ep1", workersMax: 2, workersMin: 0 }), { status: 200 }),
    );
    const r = await fetchEndpointWorkersMax("k", "ep1", fetchImpl);
    expect(r.workersMax).toBe(2);
    expect(r.workersMin).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(`${RUNPOD_REST_BASE}/endpoints/ep1`, expect.any(Object));
  });
  it("surfaces 401 without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const r = await fetchEndpointWorkersMax("k", "ep1", fetchImpl);
    expect(r.status).toBe(401);
    expect(r.workersMax).toBeNull();
  });
});

describe("reconcileRunpodEndpointWorkersMax", () => {
  it("no-ops when live workersMax already meets spec", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ workersMax: 4 }), { status: 200 });
      }
      throw new Error("unexpected PATCH");
    });
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, action: "none" });
  });

  it("PATCHes when live workersMax is below spec (full management key)", async () => {
    const calls: { method: string; body?: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, body: init?.body as string | undefined });
      if (method === "GET") {
        return new Response(JSON.stringify({ workersMax: 0, workersMin: 0 }), { status: 200 });
      }
      if (method === "PATCH") {
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected ${method}`);
    });
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "k",
      endpointId: "ep1",
      spec: { workersMax: 4 },
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.action).toBe("restored");
      expect(r.workersMaxBefore).toBe(0);
      expect(r.workersMaxAfter).toBe(4);
    }
    expect(JSON.parse(calls[1].body!)).toEqual({ workersMax: 4, workersMin: 0 });
  });

  it("returns guidance when PATCH is 401 (scoped invoke key)", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ workersMax: 0 }), { status: 200 });
      }
      return new Response("forbidden", { status: 401 });
    });
    const r = await reconcileRunpodEndpointWorkersMax({
      apiKey: "scoped",
      endpointId: "ep1",
      spec: { workersMax: 2 },
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.guidance).toContain("ep1");
      expect(r.guidance).toContain("idle scale-down");
    }
  });
});
