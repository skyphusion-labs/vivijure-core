// Optional temporary S3 credentials on the tenant R2 block.
//
// Rules held here: the four values still decide whether a block exists; a token alone makes no
// block; with no token the block serialises EXACTLY as before (no key, not an empty string); the
// token survives the attach and the strip, so a receiver gets it and the request no longer has it.

import { describe, it, expect } from "vitest";
import { tenantR2FromEnv, withTenantR2, takeTenantR2 } from "../src/modules/tenant-r2.js";
import type { InvokeRequest, ModuleManifest } from "../src/modules/types.js";

const fullEnv = (): Record<string, unknown> => ({
  R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  R2_S3_ACCESS_KEY_ID: "tok-1",
  R2_S3_SECRET_ACCESS_KEY: "deadbeef",
  R2_S3_BUCKET: "vivijure-tenant-hero",
});

// Byte-for-byte the serialisation of a block before session_token existed.
const PRE_CHANGE_JSON =
  '{"endpoint":"https://acct.r2.cloudflarestorage.com","access_key_id":"tok-1","secret_access_key":"deadbeef","bucket":"vivijure-tenant-hero"}';

const manifest: ModuleManifest = { name: "own-gpu", version: "0.2.0", api: "vivijure-module/2", hooks: ["motion.backend"], needs_tenant_r2: true };
const envelope = (): InvokeRequest<{ shot_id: string }> => ({
  hook: "motion.backend",
  input: { shot_id: "s1" },
  config: {},
  context: { project: "demo", job_id: "job-1" },
});

describe("tenantR2FromEnv with an optional session token", () => {
  it("no token: the block serialises exactly as before", async () => {
    const block = await tenantR2FromEnv(fullEnv());
    expect(JSON.stringify(block)).toBe(PRE_CHANGE_JSON);
    expect(block && "session_token" in block).toBe(false);
  });

  it("an EMPTY token is absent, not an empty-string field", async () => {
    const block = await tenantR2FromEnv({ ...fullEnv(), R2_S3_SESSION_TOKEN: "" });
    expect(JSON.stringify(block)).toBe(PRE_CHANGE_JSON);
  });

  it("a FAILED token read is absent, and does not throw or drop the block", async () => {
    const env = { ...fullEnv(), R2_S3_SESSION_TOKEN: { get: async () => { throw new Error("store down"); } } };
    expect(JSON.stringify(await tenantR2FromEnv(env))).toBe(PRE_CHANGE_JSON);
  });

  it("a token (plain string) rides on the block as session_token", async () => {
    const block = await tenantR2FromEnv({ ...fullEnv(), R2_S3_SESSION_TOKEN: "sess-abc" });
    expect(block?.session_token).toBe("sess-abc");
    expect(block?.access_key_id).toBe("tok-1");
  });

  it("a token from a Secrets Store handle rides on the block too", async () => {
    const block = await tenantR2FromEnv({ ...fullEnv(), R2_S3_SESSION_TOKEN: { get: async () => "sess-store" } });
    expect(block?.session_token).toBe("sess-store");
  });

  it("the four still decide: a token with any of the four missing yields NULL", async () => {
    for (const k of ["R2_S3_ENDPOINT", "R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY", "R2_S3_BUCKET"]) {
      const env: Record<string, unknown> = { ...fullEnv(), R2_S3_SESSION_TOKEN: "sess-abc" };
      delete env[k];
      expect(await tenantR2FromEnv(env), `missing ${k} should yield null`).toBeNull();
    }
  });
});

describe("the token survives attach and strip", () => {
  it("withTenantR2 carries it and takeTenantR2 returns it and removes the block", async () => {
    const block = await tenantR2FromEnv({ ...fullEnv(), R2_S3_SESSION_TOKEN: "sess-abc" });
    const req = withTenantR2(envelope(), manifest, block);
    expect(JSON.parse(JSON.stringify(req)).r2.session_token).toBe("sess-abc");
    const taken = takeTenantR2(req);
    expect(taken?.session_token).toBe("sess-abc");
    expect("r2" in req).toBe(false);
    expect(JSON.stringify(req)).not.toContain("sess-abc");
  });
});
