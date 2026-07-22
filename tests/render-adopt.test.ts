import { describe, expect, it } from "vitest";
import { handleAdoptRender, isSafeAdoptOutputKey } from "../src/render-adopt.js";
import type { Env } from "../src/platform/orchestrator-context.js";

interface Row {
  id: number;
  job_id: string;
  project: string;
  bundle_key: string;
  quality_tier: string;
  status: string;
  output_key: string | null;
  output_json: string | null;
}

function adoptRequest(body: Record<string, unknown>): Request {
  return new Request("https://studio.test/api/storyboard/renders/adopt", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function makeEnv(seed: Row[] = []) {
  const rows = new Map(seed.map((r) => [r.job_id, { ...r }]));
  const inserts: Row[] = [];
  const finishUpdates: Array<{ jobId: string; outputKey: string; outputJson: string }> = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt = {
          bind(...values: unknown[]) {
            binds = values;
            return stmt;
          },
          async first<T>() {
            if (/SELECT id, status, output_key FROM renders WHERE job_id = \?/i.test(sql)) {
              const row = rows.get(String(binds[0]));
              return (row ? { id: row.id, status: row.status, output_key: row.output_key } : null) as T | null;
            }
            return null;
          },
          async run() {
            if (/INSERT INTO renders/i.test(sql)) {
              const row: Row = {
                id: rows.size + 1,
                job_id: String(binds[1]),
                project: String(binds[2]),
                bundle_key: String(binds[3] ?? ""),
                quality_tier: String(binds[4]),
                status: String(binds[6]),
                output_key: null,
                output_json: null,
              };
              if (!rows.has(row.job_id)) {
                rows.set(row.job_id, row);
                inserts.push(row);
              }
              return { success: true, meta: { changes: 1 } };
            }
            if (/UPDATE renders SET output_key = \?/i.test(sql)) {
              const outputKey = String(binds[0]);
              const outputJson = String(binds[1]);
              const jobId = String(binds[4]);
              const row = rows.get(jobId);
              if (row) {
                row.output_key = outputKey;
                row.output_json = outputJson;
                row.status = "COMPLETED";
              }
              finishUpdates.push({ jobId, outputKey, outputJson });
              return { success: true, meta: { changes: row ? 1 : 0 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        };
        return stmt;
      },
    },
  } as unknown as Env;
  return { env, rows, inserts, finishUpdates };
}

async function responseJson(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json()) as Record<string, unknown>;
}

describe("render adoption hardening (#76)", () => {
  it("validates adopted output keys as safe keys under renders/<jobId>/", () => {
    expect(isSafeAdoptOutputKey("job-1", "renders/job-1/film.mp4")).toBe(true);
    expect(isSafeAdoptOutputKey("job-1", "renders/other/film.mp4")).toBe(false);
    expect(isSafeAdoptOutputKey("job-1", "../renders/job-1/film.mp4")).toBe(false);
    expect(isSafeAdoptOutputKey("job-1", "renders/job-1/")).toBe(false);
  });

  it("rejects an unsafe outputKey before inserting", async () => {
    const { env, rows, finishUpdates } = makeEnv();
    const resp = await handleAdoptRender(adoptRequest({
      jobId: "job-1",
      outputKey: "renders/job-1/../evil.mp4",
    }), env);

    expect(resp.status).toBe(400);
    expect(await responseJson(resp)).toEqual({
      error: "outputKey must be a safe relative key under renders/<jobId>/",
    });
    expect(rows.size).toBe(0);
    expect(finishUpdates).toEqual([]);
  });

  it("rejects an outputKey outside the job's render prefix", async () => {
    const { env, rows, finishUpdates } = makeEnv();
    const resp = await handleAdoptRender(adoptRequest({
      jobId: "victim-job",
      outputKey: "renders/other-job/film.mp4",
    }), env);

    expect(resp.status).toBe(400);
    expect(rows.size).toBe(0);
    expect(finishUpdates).toEqual([]);
  });

  it("inserts and completes a new adopted render with a safe output key", async () => {
    const { env, rows, inserts, finishUpdates } = makeEnv();
    const resp = await handleAdoptRender(adoptRequest({
      jobId: "job-new",
      bundleKey: "bundles/demo/storyboard.tar.gz",
      outputKey: "renders/job-new/film.mp4",
      seconds: 8,
      hasAudio: true,
    }), env);

    expect(resp.status).toBe(200);
    expect(await responseJson(resp)).toMatchObject({
      ok: true,
      jobId: "job-new",
      adopted: true,
      completed: true,
    });
    expect(inserts).toHaveLength(1);
    expect(finishUpdates).toHaveLength(1);
    expect(rows.get("job-new")?.status).toBe("COMPLETED");
    expect(rows.get("job-new")?.output_key).toBe("renders/job-new/film.mp4");
    expect(JSON.parse(rows.get("job-new")?.output_json ?? "{}")).toEqual({
      output_key: "renders/job-new/film.mp4",
      seconds: 8,
      has_audio: true,
    });
  });

  it("refuses to complete an existing non-terminal render by guessed jobId", async () => {
    const { env, rows, finishUpdates } = makeEnv([{
      id: 1,
      job_id: "job-active",
      project: "demo",
      bundle_key: "",
      quality_tier: "final",
      status: "SUBMITTED",
      output_key: null,
      output_json: null,
    }]);

    const resp = await handleAdoptRender(adoptRequest({
      jobId: "job-active",
      outputKey: "renders/job-active/attacker.mp4",
    }), env);

    expect(resp.status).toBe(409);
    expect(await responseJson(resp)).toEqual({
      error: "jobId already exists; adopt will not update an existing render",
    });
    expect(rows.get("job-active")?.status).toBe("SUBMITTED");
    expect(rows.get("job-active")?.output_key).toBeNull();
    expect(finishUpdates).toEqual([]);
  });

  it("refuses to overwrite an existing terminal render's output key", async () => {
    const { env, rows, finishUpdates } = makeEnv([{
      id: 1,
      job_id: "job-done",
      project: "demo",
      bundle_key: "",
      quality_tier: "final",
      status: "COMPLETED",
      output_key: "renders/job-done/original.mp4",
      output_json: JSON.stringify({ output_key: "renders/job-done/original.mp4" }),
    }]);

    const resp = await handleAdoptRender(adoptRequest({
      jobId: "job-done",
      outputKey: "renders/job-done/attacker.mp4",
    }), env);

    expect(resp.status).toBe(409);
    expect(rows.get("job-done")?.status).toBe("COMPLETED");
    expect(rows.get("job-done")?.output_key).toBe("renders/job-done/original.mp4");
    expect(finishUpdates).toEqual([]);
  });

  it("keeps exact completed retries idempotent without another finish update", async () => {
    const { env, finishUpdates } = makeEnv([{
      id: 1,
      job_id: "job-done",
      project: "demo",
      bundle_key: "",
      quality_tier: "final",
      status: "COMPLETED",
      output_key: "renders/job-done/film.mp4",
      output_json: JSON.stringify({ output_key: "renders/job-done/film.mp4" }),
    }]);

    const resp = await handleAdoptRender(adoptRequest({
      jobId: "job-done",
      outputKey: "renders/job-done/film.mp4",
    }), env);

    expect(resp.status).toBe(200);
    expect(await responseJson(resp)).toMatchObject({ deduped: true, completed: true });
    expect(finishUpdates).toEqual([]);
  });
});
