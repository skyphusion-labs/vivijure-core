// The per-job tenant R2 credential on the invoke envelope (cp#270).
//
// THE THREE RULES THIS FILE EXISTS TO HOLD, all of which fail SILENTLY if broken:
//
//   1. OMIT, never null. The backend REFUSES an explicit `"r2": null` rather than reading it as
//      absent, so a producer that emits null fails every job at the far end with a message about a
//      malformed block. Serialisation is asserted, not just the object shape.
//   2. Only a module that DECLARES `needs_tenant_r2` receives it. Attaching it to a module that does
//      not need one hands a live tenant credential to a worker with no use for it.
//   3. A receiver STRIPS it. The credential must not survive past the point that consumes it, or a
//      future log line downstream serialises an object that still contains it.

import { describe, it, expect } from "vitest";
import { tenantR2FromEnv, withTenantR2, takeTenantR2, needsTenantR2 } from "../src/modules/tenant-r2.js";
import type { InvokeRequest, ModuleManifest, TenantR2Config } from "../src/modules/types.js";

const CRED: TenantR2Config = {
  endpoint: "https://acct.r2.cloudflarestorage.com",
  access_key_id: "tok-1",
  secret_access_key: "deadbeef",
  bucket: "vivijure-tenant-hero",
};

const fullEnv = (): Record<string, unknown> => ({
  R2_S3_ENDPOINT: CRED.endpoint,
  R2_S3_ACCESS_KEY_ID: CRED.access_key_id,
  R2_S3_SECRET_ACCESS_KEY: CRED.secret_access_key,
  R2_S3_BUCKET: CRED.bucket,
});

const manifest = (over: Partial<ModuleManifest> = {}): ModuleManifest => ({
  name: "own-gpu",
  version: "0.2.0",
  api: "vivijure-module/2",
  hooks: ["motion.backend"],
  ...over,
});

const envelope = (): InvokeRequest<{ shot_id: string }> => ({
  hook: "motion.backend",
  input: { shot_id: "s1" },
  config: {},
  context: { project: "demo", job_id: "job-1" },
});

describe("tenantR2FromEnv", () => {
  it("builds the block from a full studio env", async () => {
    expect(await tenantR2FromEnv(fullEnv())).toEqual(CRED);
  });

  it("resolves a Secrets Store handle as well as a plain string", async () => {
    const env = { ...fullEnv(), R2_S3_SECRET_ACCESS_KEY: { get: async () => "from-store" } };
    expect((await tenantR2FromEnv(env))?.secret_access_key).toBe("from-store");
  });

  it("returns NULL when ANY of the four is missing, rather than a partial block", async () => {
    // All-or-nothing is the whole rule. The backend FAILS a malformed block and only falls back to
    // its environment on an ABSENT one, so a partial block would break every render on a dedicated
    // endpoint that works fine today.
    for (const k of ["R2_S3_ENDPOINT", "R2_S3_ACCESS_KEY_ID", "R2_S3_SECRET_ACCESS_KEY", "R2_S3_BUCKET"]) {
      const env = fullEnv();
      delete env[k];
      expect(await tenantR2FromEnv(env), `missing ${k} should yield null`).toBeNull();
    }
  });

  it("treats an EMPTY string as missing, not as a credential", async () => {
    const env = { ...fullEnv(), R2_S3_ACCESS_KEY_ID: "" };
    expect(await tenantR2FromEnv(env)).toBeNull();
  });

  it("treats a FAILED secret read as absent rather than throwing", async () => {
    // A throw here would take down a render for a tenant on a DEDICATED endpoint, which needs no
    // block at all. Degrade to "no block", which is exactly today's behaviour.
    const env = {
      ...fullEnv(),
      R2_S3_SECRET_ACCESS_KEY: {
        get: async () => {
          throw new Error("secrets store unavailable");
        },
      },
    };
    await expect(tenantR2FromEnv(env)).resolves.toBeNull();
  });
});

describe("withTenantR2", () => {
  it("attaches the block for a module that DECLARES it needs one", () => {
    const req = withTenantR2(envelope(), manifest({ needs_tenant_r2: true }), CRED);
    expect(req.r2).toEqual(CRED);
  });

  it("does NOT attach it for a module that does not declare it", () => {
    const req = withTenantR2(envelope(), manifest(), CRED);
    expect("r2" in req).toBe(false);
  });

  it("OMITS the key rather than setting null when there is no credential", () => {
    // THE RULE THAT BREAKS THE FAR END. An explicit null is refused by the backend rather than read
    // as absent, so this is asserted on the SERIALISED form: an object property set to undefined
    // also disappears through JSON.stringify, but only by accident of the serialiser, and this must
    // hold structurally.
    const req = withTenantR2(envelope(), manifest({ needs_tenant_r2: true }), null);
    expect("r2" in req).toBe(false);
    const wire = JSON.parse(JSON.stringify(req)) as Record<string, unknown>;
    expect("r2" in wire).toBe(false);
    expect(JSON.stringify(req)).not.toContain("null");
  });

  it("CONTROL: the attached form really does serialise the block", () => {
    // Without this, an implementation that never attached anything would pass every test above.
    const wire = JSON.parse(
      JSON.stringify(withTenantR2(envelope(), manifest({ needs_tenant_r2: true }), CRED)),
    ) as { r2?: TenantR2Config };
    expect(wire.r2).toEqual(CRED);
  });

  it("does not mutate the caller's envelope", () => {
    const original = envelope();
    withTenantR2(original, manifest({ needs_tenant_r2: true }), CRED);
    expect("r2" in original).toBe(false);
  });
});

describe("takeTenantR2 (strip at the boundary)", () => {
  it("returns the block AND removes it from the request in one call", () => {
    const req = withTenantR2(envelope(), manifest({ needs_tenant_r2: true }), CRED);
    const taken = takeTenantR2(req);

    expect(taken).toEqual(CRED);
    // The credential is gone from the object every downstream code path already holds a reference
    // to. A copy-returning implementation would leave the original intact, which is precisely the
    // object that gets serialised into a log.
    expect("r2" in req).toBe(false);
    expect(JSON.stringify(req)).not.toContain(CRED.secret_access_key);
  });

  it("is safe and null-returning on a request that never carried one", () => {
    const req = envelope();
    expect(takeTenantR2(req)).toBeNull();
    expect("r2" in req).toBe(false);
  });

  it("is idempotent: a second call finds nothing left", () => {
    const req = withTenantR2(envelope(), manifest({ needs_tenant_r2: true }), CRED);
    expect(takeTenantR2(req)).toEqual(CRED);
    expect(takeTenantR2(req)).toBeNull();
  });

  it("leaves the rest of the envelope intact", () => {
    const req = withTenantR2(envelope(), manifest({ needs_tenant_r2: true }), CRED);
    takeTenantR2(req);
    expect(req.hook).toBe("motion.backend");
    expect(req.input).toEqual({ shot_id: "s1" });
    expect(req.context).toEqual({ project: "demo", job_id: "job-1" });
  });
});

describe("needsTenantR2", () => {
  it("reads the manifest declaration and defaults to false", () => {
    expect(needsTenantR2(manifest({ needs_tenant_r2: true }))).toBe(true);
    expect(needsTenantR2(manifest({ needs_tenant_r2: false }))).toBe(false);
    expect(needsTenantR2(manifest())).toBe(false);
  });
});
