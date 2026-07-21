import { describe, expect, it } from "vitest";
import {
  finishChainForShot,
  finishOrderLegacyDialogue,
  finishOrderReorderDialogue,
  resolveFinishChainForShot,
} from "../src/film-orchestrator.js";
import { MODULE_API, type RegisteredModule } from "../src/modules/types.js";

const mod = (name: string, order: number, consumesAudio: boolean): RegisteredModule => ({
  name,
  version: "0.0.0",
  api: MODULE_API,
  hooks: ["finish"],
  ui: { order },
  finish_consumes_audio: consumesAudio,
  binding: `MODULE_${name.toUpperCase().replace(/-/g, "_")}`,
});

const rife = mod("finish-rife", 10, false);
const lipsync = mod("finish-lipsync", 15, true);
const upscale = mod("finish-upscale", 20, false);
const serving = [rife, lipsync, upscale];

describe("finishOrderLegacyDialogue (explicit legacy flag)", () => {
  it("defaults false when finish-order config is absent", () => {
    expect(finishOrderLegacyDialogue(undefined)).toBe(false);
    expect(finishOrderLegacyDialogue({})).toBe(false);
  });

  it("honors dialogue_legacy or legacy under finish-order", () => {
    expect(finishOrderLegacyDialogue({ "finish-order": { dialogue_legacy: true } })).toBe(true);
    expect(finishOrderLegacyDialogue({ "finish-order": { legacy: true } })).toBe(true);
    expect(finishOrderLegacyDialogue({ "finish-order": { dialogue_legacy: false } })).toBe(false);
  });
});

describe("finishOrderReorderDialogue (opt-in #584)", () => {
  it("defaults false when finish-order config is absent", () => {
    expect(finishOrderReorderDialogue(undefined)).toBe(false);
    expect(finishOrderReorderDialogue({})).toBe(false);
  });

  it("honors dialogue_reorder or reorder under finish-order", () => {
    expect(finishOrderReorderDialogue({ "finish-order": { dialogue_reorder: true } })).toBe(true);
    expect(finishOrderReorderDialogue({ "finish-order": { reorder: true } })).toBe(true);
    expect(finishOrderReorderDialogue({ "finish-order": { dialogue_reorder: false } })).toBe(false);
  });
});

describe("resolveFinishChainForShot (cf#29 default = legacy)", () => {
  it("dialogue shot: legacy ui.order by default", () => {
    const ordered = resolveFinishChainForShot(serving, true, {});
    expect(ordered.map((m) => m.name)).toEqual(["finish-rife", "finish-lipsync", "finish-upscale"]);
  });

  it("dialogue shot: #584 order when finish-order.dialogue_reorder is true", () => {
    const ordered = resolveFinishChainForShot(serving, true, {
      "finish-order": { dialogue_reorder: true },
    });
    expect(ordered.map((m) => m.name)).toEqual(["finish-lipsync", "finish-rife", "finish-upscale"]);
  });

  it("dialogue shot: legacy ui.order when finish-order.dialogue_legacy is true", () => {
    const ordered = resolveFinishChainForShot(serving, true, {
      "finish-order": { dialogue_legacy: true },
    });
    expect(ordered.map((m) => m.name)).toEqual(["finish-rife", "finish-lipsync", "finish-upscale"]);
  });

  it("non-dialogue shot: unchanged even with reorder flag", () => {
    const ordered = resolveFinishChainForShot(serving, false, {
      "finish-order": { dialogue_reorder: true },
    });
    expect(ordered.map((m) => m.name)).toEqual(finishChainForShot(serving, false).map((m) => m.name));
  });
});
