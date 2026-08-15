// cf#475 -- WHICH backend served a cast-LoRA train, asserted on the REAL submitters.
//
// This half is in its own file on purpose. The recording suite
// (cast-train-job-log-cf475.test.ts) replaces the submitters with mocks, and a tag assertion made
// against a mock asserts the mock. Here nothing is mocked but the transport: the routing decision,
// the endpoint resolution and the tagging are all the shipped code.
//
// WHY THE TAG EXISTS AT ALL: three backends can serve a cast train and only two are RunPod spend on
// our account, so the recorder has to be told which, by the code that chose, not by a second read of
// the bindings somewhere downstream.

import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/platform/orchestrator-context.js";
import {
  pollCastLoraJob,
  submitTrainLoraJob,
  submitTrainWanLoraJob,
} from "../src/runpod-submit.js";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

const ARGS = { project: "p", bundleKey: "bundles/p.tar.gz" };

describe("cf#475 submit tagging", () => {
  it("a Wan cast train is tagged runpod-wan-train", async () => {
    const res = await submitTrainWanLoraJob(
      { RUNPOD_WAN_TRAIN_ENDPOINT_ID: "wan-ep", RUNPOD_API_KEY: "k" } as unknown as Env,
      ARGS,
      { fetchImpl: jsonFetch({ id: "job-w", status: "IN_QUEUE" }) },
    );
    expect(res.ok).toBe(true);
    expect(res.backend).toBe("runpod-wan-train");
  });

  it("a cloud SDXL cast train is tagged runpod-render", async () => {
    const res = await submitTrainLoraJob(
      { RUNPOD_ENDPOINT_ID: "render-ep", RUNPOD_API_KEY: "k" } as unknown as Env,
      ARGS,
      { fetchImpl: jsonFetch({ id: "job-s", status: "IN_QUEUE" }) },
    );
    expect(res.ok).toBe(true);
    expect(res.backend).toBe("runpod-render");
  });

  it("a homelab local-door train is tagged local-door, NOT a RunPod backend", async () => {
    const res = await submitTrainLoraJob(
      {
        LOCAL_BACKEND_URL: "https://door.test",
        RUNPOD_ENDPOINT_ID: "render-ep",
        RUNPOD_API_KEY: "k",
      } as unknown as Env,
      ARGS,
      { fetchImpl: jsonFetch({ id: "job-l" }) },
    );
    expect(res.ok).toBe(true);
    expect(res.backend).toBe("local-door");
  });
});

describe("cf#475 poll tagging follows the fallthrough", () => {
  it("the Wan endpoint answering tags the result runpod-wan-train", async () => {
    const res = await pollCastLoraJob(
      { RUNPOD_WAN_TRAIN_ENDPOINT_ID: "wan-ep", RUNPOD_API_KEY: "k" } as unknown as Env,
      "job-w",
      { fetchImpl: jsonFetch({ id: "job-w", status: "COMPLETED" }) },
    );
    expect(res.ok).toBe(true);
    expect(res.backend).toBe("runpod-wan-train");
  });

  it("a 404 on the Wan endpoint falls through, and the render endpoint's answer is tagged runpod-render", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ error: "not found" }), { status: 404 })
        : new Response(JSON.stringify({ id: "job-s", status: "COMPLETED" }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await pollCastLoraJob(
      {
        RUNPOD_WAN_TRAIN_ENDPOINT_ID: "wan-ep",
        RUNPOD_ENDPOINT_ID: "render-ep",
        RUNPOD_API_KEY: "k",
      } as unknown as Env,
      "job-s",
      { fetchImpl },
    );
    expect(res.ok).toBe(true);
    expect(res.backend).toBe("runpod-render");
  });
});
