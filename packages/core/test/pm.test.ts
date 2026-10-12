import { describe, expect, it } from "vitest";
import { premultiplyStraightRGBA8 } from "../src/index.js";

describe("premultiplyStraightRGBA8", () => {
  it("rejects a trailing partial RGBA pixel", () => {
    expect(() => premultiplyStraightRGBA8(Uint8Array.of(1, 2, 3))).toThrow(/multiple of 4/);
    expect(() => premultiplyStraightRGBA8(Uint8ClampedArray.of(1, 2, 3, 4, 5))).toThrow(
      /multiple of 4/,
    );
  });
});
