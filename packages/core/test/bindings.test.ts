import { describe, expect, it } from "vitest";
import { clampOrWrap, evalBinding, sampleAxis } from "../src/index.js";
import type { Binding, ParamDef } from "../src/index.js";

const plain = (min: number, max: number): ParamDef => ({
  id: "p",
  min,
  max,
  default: 0,
  wrap: false,
});
const wrapping = (min: number, max: number): ParamDef => ({
  id: "w",
  min,
  max,
  default: min,
  wrap: true,
});

function scalarBinding(params: ParamDef[], axes: number[][], values: number[]): Binding {
  return {
    target: null as never,
    property: "angle",
    params,
    axes,
    values: Float64Array.from(values),
    arity: 1,
    kind: "additive",
  };
}

describe("clampOrWrap (§6)", () => {
  it("clamps non-wrapping parameters", () => {
    const p = plain(-30, 30);
    expect(clampOrWrap(p, 45)).toBe(30);
    expect(clampOrWrap(p, -100)).toBe(-30);
    expect(clampOrWrap(p, 12)).toBe(12);
  });

  it("wraps modulo [min, max)", () => {
    const p = wrapping(0, 360);
    expect(clampOrWrap(p, 360)).toBe(0);
    expect(clampOrWrap(p, 450)).toBe(90);
    expect(clampOrWrap(p, -90)).toBe(270);
  });

  it("wraps over a non-zero-based range", () => {
    const p = wrapping(-180, 180);
    expect(clampOrWrap(p, 180)).toBe(-180);
    expect(clampOrWrap(p, 190)).toBe(-170);
  });

  it("rejects non-finite values instead of silently repairing host input", () => {
    const p = plain(-30, 30);
    expect(() => clampOrWrap(p, Number.NaN)).toThrow(/must be finite/);
    expect(() => clampOrWrap(p, Number.POSITIVE_INFINITY)).toThrow(/must be finite/);
  });
});

describe("sampleAxis / evalBinding — single axis (§7)", () => {
  it("interpolates linearly between keys", () => {
    const b = scalarBinding([plain(-30, 30)], [[-30, 0, 30]], [-22, 0, 22]);
    expect(evalBinding(b, [15])[0]).toBeCloseTo(11, 12);
    expect(evalBinding(b, [-30])[0]).toBeCloseTo(-22, 12);
    expect(evalBinding(b, [0])[0]).toBe(0);
  });

  it("holds the boundary outside the axis range (clamp, §7 rule 3)", () => {
    // Axis narrower than the param range.
    const b = scalarBinding([plain(-30, 30)], [[-10, 10]], [-1, 1]);
    expect(evalBinding(b, [25])[0]).toBe(1);
    expect(evalBinding(b, [-25])[0]).toBe(-1);
  });

  it("interpolates across the seam on a wrapping axis (§7 rule 3)", () => {
    // Param 0..360 wrap; keys at 0, 90, 180. Seam runs 180 → 360(=0).
    const p = wrapping(0, 360);
    const b = scalarBinding([p], [[0, 90, 180]], [10, 20, 30]);
    // v = 270: halfway through the 180-long seam → lerp(30, 10, 0.5) = 20.
    expect(evalBinding(b, [270])[0]).toBeCloseTo(20, 12);
    // v = 315: three-quarters → lerp(30, 10, 0.75) = 15.
    expect(evalBinding(b, [315])[0]).toBeCloseTo(15, 12);
    // Interior intervals are unchanged by wrapping.
    expect(evalBinding(b, [45])[0]).toBeCloseTo(15, 12);
  });

  it("treats a single-key axis as constant", () => {
    const b = scalarBinding([plain(0, 1)], [[0.5]], [7]);
    expect(evalBinding(b, [0])[0]).toBe(7);
    expect(evalBinding(b, [1])[0]).toBe(7);
  });

  it("preserves an authored negative-zero factor at an exact key", () => {
    const b = scalarBinding([plain(0, 1)], [[0, 1]], [-0, 1]);
    expect(Object.is(evalBinding(b, [0])[0], -0)).toBe(true);
  });
});

describe("evalBinding — multilinear grids (§7 rule 2/3)", () => {
  it("uses row-major order with the first param slowest", () => {
    const pa = plain(0, 1);
    const pb = plain(0, 10);
    // axes[0]=[0,1] (param a), axes[1]=[0,10] (param b)
    // values: [a0b0, a0b1, a1b0, a1b1]
    const b = scalarBinding(
      [pa, pb],
      [
        [0, 1],
        [0, 10],
      ],
      [0, 10, 100, 110],
    );
    expect(evalBinding(b, [0, 10])[0]).toBeCloseTo(10, 12); // a=0, b=max → a0b1
    expect(evalBinding(b, [1, 0])[0]).toBeCloseTo(100, 12); // a=max, b=0 → a1b0
    expect(evalBinding(b, [0.5, 5])[0]).toBeCloseTo(55, 12); // centre → mean of corners
  });

  it("interpolates a 3-param grid", () => {
    const p = plain(0, 1);
    const q = plain(0, 1);
    const r = plain(0, 1);
    // 2×2×2 corners: value = 4a + 2b + c encoded row-major (a slowest).
    const values = [0, 1, 2, 3, 4, 5, 6, 7];
    const b = scalarBinding(
      [p, q, r],
      [
        [0, 1],
        [0, 1],
        [0, 1],
      ],
      values,
    );
    expect(evalBinding(b, [0.5, 0.5, 0.5])[0]).toBeCloseTo(3.5, 12);
    expect(evalBinding(b, [1, 0, 1])[0]).toBeCloseTo(5, 12);
    expect(evalBinding(b, [0.25, 0.5, 0.75])[0]).toBeCloseTo(4 * 0.25 + 2 * 0.5 + 0.75, 12);
  });

  it("interpolates vector entries elementwise", () => {
    const p = plain(0, 1);
    const b: Binding = {
      target: null as never,
      property: "offset",
      params: [p],
      axes: [[0, 1]],
      values: Float64Array.of(0, 0, 10, -20),
      arity: 2,
      kind: "additive",
    };
    const out = evalBinding(b, [0.25]);
    expect(out[0]).toBeCloseTo(2.5, 12);
    expect(out[1]).toBeCloseTo(-5, 12);
  });
});

describe("sampleAxis edge cases", () => {
  it("clamps below/above on non-wrap axes", () => {
    const p = plain(-1, 1);
    expect(sampleAxis([0, 1], p, -0.5)).toEqual({ i0: 0, i1: 0, t: 0 });
    expect(sampleAxis([-1, 0], p, 0.5)).toEqual({ i0: 1, i1: 1, t: 0 });
  });

  it("wrap axis whose keys span the whole period never seams", () => {
    const p = wrapping(0, 360);
    // Keys at both ends; any wrapped v lands inside [0, 360).
    const s = sampleAxis([0, 180, 360], p, 359);
    expect(s.i0).toBe(1);
    expect(s.i1).toBe(2);
  });
});
