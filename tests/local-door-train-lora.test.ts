import { describe, expect, it, vi } from "vitest";
import {
  localDoorConfigured,
  normalizeLocalBackendUrl,
  pollCastLoraJob,
  pollLocalDoorJob,
  submitTrainLoraJob,
} from "../src/runpod-submit.js";

describe("normalizeLocalBackendUrl", () => {
  it("accepts http(s) door URLs and strips trailing slashes", () => {
    expect(normalizeLocalBackendUrl("http://vivijure-local-16gb:8000/")).toBe(
      "http://vivijure-local-16gb:8000",
    );
    expect(normalizeLocalBackendUrl("https://door.example.com")).toBe("https://door.example.com");
  });

  it("rejects metadata hosts and userinfo", () => {
    expect(normalizeLocalBackendUrl("http://169.254.169.254/")).toBeNull();
    expect(normalizeLocalBackendUrl("http://user:pass@door.example.com")).toBeNull();
    expect(normalizeLocalBackendUrl("ftp://door.example.com")).toBeNull();
  });
});

describe("localDoorConfigured", () => {
  it("is true when LOCAL_BACKEND_URL is a valid door URL", async () => {
    await expect(
      localDoorConfigured({ LOCAL_BACKEND_URL: "http://door:8000" } as never),
    ).resolves.toBe(true);
  });

  it("is false when missing or invalid", async () => {
    await expect(localDoorConfigured({} as never)).resolves.toBe(false);
    await expect(
      localDoorConfigured({ LOCAL_BACKEND_URL: "not-a-url" } as never),
    ).resolves.toBe(false);
  });
});

describe("submitTrainLoraJob prefers local door", () => {
  it("POSTs /run on LOCAL_BACKEND_URL when the door is wired", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ id: "abc123def456abc123def456abc123de" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await submitTrainLoraJob(
      {
        LOCAL_BACKEND_URL: "http://door:8000",
        LOCAL_BACKEND_TOKEN: "tok",
      } as never,
      { project: "lora-cast-1-1", bundleKey: "bundles/lora-cast-1-1.tar.gz" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.view.jobId).toBe("abc123def456abc123def456abc123de");
      expect(result.view.status).toBe("IN_QUEUE");
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    const call = fetchImpl.mock.calls[0];
    expect(call).toBeDefined();
    const url = call![0];
    const init = call![1] as RequestInit;
    expect(url).toBe("http://door:8000/run");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      authorization: "Bearer tok",
      "content-type": "application/json",
    });
    const body = JSON.parse(String(init.body));
    expect(body.input.action).toBe("train_lora");
    expect(body.input.project).toBe("lora-cast-1-1");
    expect(body.input.bundle_key).toBe("bundles/lora-cast-1-1.tar.gz");
  });

  it("fails closed with a clear error when neither door nor RunPod EP is set", async () => {
    const result = await submitTrainLoraJob({} as never, {
      project: "p",
      bundleKey: "bundles/p.tar.gz",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/LOCAL_BACKEND_URL/);
    }
  });
});

describe("pollCastLoraJob local door", () => {
  it("polls the local door before the render EP when LOCAL_BACKEND_URL is set", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/status/")) {
        return new Response(
          JSON.stringify({
            id: "abc123def456abc123def456abc123de",
            status: "COMPLETED",
            output: { lora: { A: { lora_id: "loras/p/A/pytorch_lora_weights.safetensors" } } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await pollCastLoraJob(
      {
        LOCAL_BACKEND_URL: "http://door:8000",
        LOCAL_BACKEND_TOKEN: "tok",
      } as never,
      "abc123def456abc123def456abc123de",
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.view.status).toBe("COMPLETED");
      expect(result.view.output).toMatchObject({
        lora: { A: { lora_id: "loras/p/A/pytorch_lora_weights.safetensors" } },
      });
    }
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "http://door:8000/status/abc123def456abc123def456abc123de",
    );
  });

  it("pollLocalDoorJob maps door 404 to not-found", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }));
    const result = await pollLocalDoorJob(
      { LOCAL_BACKEND_URL: "http://door:8000" } as never,
      "abc123def456abc123def456abc123de",
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});
