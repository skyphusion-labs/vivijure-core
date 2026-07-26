import { describe, expect, it } from "vitest";
import { emitTar, readTar } from "../src/tar.js";

describe("tar path safety", () => {
  it("emitTar rejects traversal entry names", () => {
    expect(() => emitTar([{ name: "../etc/passwd", content: new Uint8Array([1]) }]))
      .toThrow(/unsafe entry name/);
    expect(() => emitTar([{ name: "storyboard/../evil.yaml", content: new Uint8Array([1]) }]))
      .toThrow(/unsafe entry name/);
  });

  it("readTar rejects traversal entry names", () => {
    const safe = emitTar([{ name: "storyboard.yaml", content: new TextEncoder().encode("ok") }]);
    const tampered = new Uint8Array(safe);
    const evil = "../evil";
    for (let i = 0; i < evil.length; i++) tampered[i] = evil.charCodeAt(i);
    expect(() => readTar(tampered)).toThrow(/unsafe entry name/);
  });
});
