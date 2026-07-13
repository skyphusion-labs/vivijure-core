import { describe, expect, it } from "vitest";
import {
  PLATFORM_ICD_VERSION,
  ObjectStoreR2Bucket,
  platformAsEnv,
  orchestratorContextFromPlatform,
  type Database,
  type ModuleTransport,
  type ObjectPresigner,
  type ObjectStore,
  type Platform,
  type SecretStore,
} from "../src/platform/index.js";

function stubStore(): ObjectStore {
  return {
    get: async () => null,
    put: async () => {},
    head: async () => null,
    delete: async () => {},
  };
}

function minimalPlatform(over: Partial<Platform> = {}): Platform {
  const modules: ModuleTransport = {
    resolve: () => null,
    listBindings: () => ["MODULE_KEYFRAME", "MODULE_LOCAL_GPU"],
  };
  return {
    db: {} as Database,
    renders: stubStore(),
    chatBucket: stubStore(),
    presigner: {} as ObjectPresigner,
    secrets: { get: async () => undefined } as SecretStore,
    modules,
    vars: { AUTH_MODE: "token", STORAGE_BACKEND: "s3" },
    ...over,
  };
}

describe("Platform ICD", () => {
  it("exports a frozen version constant", () => {
    expect(PLATFORM_ICD_VERSION).toBe(1);
  });

  it("platformAsEnv maps db, R2-shaped buckets, bindings, and vars", () => {
    const platform = minimalPlatform();
    const env = platformAsEnv(platform);
    expect(env.DB).toBe(platform.db);
    // #21: buckets are wrapped R2-shaped, NOT the raw ObjectStore (which would throw on .text()/.json()).
    expect(env.R2_RENDERS).not.toBe(platform.renders);
    expect(env.R2_RENDERS).toBeInstanceOf(ObjectStoreR2Bucket);
    expect(env.R2).toBeInstanceOf(ObjectStoreR2Bucket);
    expect(env.MODULE_KEYFRAME).toBeUndefined();
    expect(env.MODULE_LOCAL_GPU).toBeUndefined();
    expect(env.AUTH_MODE).toBe("token");
    expect(env.STORAGE_BACKEND).toBe("s3");
  });

  it("orchestratorContextFromPlatform wraps buckets and presigner", () => {
    const platform = minimalPlatform();
    const env = orchestratorContextFromPlatform(platform);
    expect(env.DB).toBe(platform.db);
    expect(env.PRESIGNER).toBe(platform.presigner);
    expect(env.R2_RENDERS).not.toBe(platform.renders);
    expect(env.R2).not.toBe(platform.chatBucket);
    expect(env.AUTH_MODE).toBe("token");
  });

  it("orchestratorContextFromPlatform merges hostBindings (Node VPC shim)", () => {
    const fetcher = { fetch: async () => new Response("ok") };
    const platform = minimalPlatform({
      hostBindings: { VIDEO_FINISH_VPC: fetcher },
    });
    const env = orchestratorContextFromPlatform(platform);
    expect(env.VIDEO_FINISH_VPC).toBe(fetcher);
  });

  it("required Platform fields are present on minimal host", () => {
    const p = minimalPlatform();
    expect(p.db).toBeDefined();
    expect(p.renders).toBeDefined();
    expect(p.chatBucket).toBeDefined();
    expect(p.presigner).toBeDefined();
    expect(p.secrets).toBeDefined();
    expect(p.modules).toBeDefined();
    expect(p.vars).toBeDefined();
  });
});
