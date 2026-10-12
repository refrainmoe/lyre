import { describe, expect, it } from "vitest";
import { deterministicProduct, deterministicSum } from "../src/index.js";

describe("deterministic scalar aggregation (§7)", () => {
  it("uses one canonical compensated order for additive cancellation", () => {
    const a = deterministicSum([1e12, 1e-5, -1e12]);
    const b = deterministicSum([-1e12, 1e12, 1e-5]);
    expect(a).toBe(b);
    expect(a).toBeCloseTo(1e-5, 12);
  });

  it("keeps a representable reciprocal product finite in every permutation", () => {
    const grouped = [...new Array<number>(26).fill(1e12), ...new Array<number>(26).fill(1e-12)];
    const alternating = Array.from({ length: 26 }, () => [1e12, 1e-12]).flat();
    expect(deterministicProduct(grouped)).toBe(deterministicProduct(alternating));
    expect(deterministicProduct(grouped)).toBeCloseTo(1, 12);
  });

  it("handles the finite exponent-1024 edge and signed zero canonically", () => {
    expect(deterministicProduct([Number.MAX_VALUE, 1])).toBe(Number.MAX_VALUE);
    expect(Object.is(deterministicProduct([-0, 2]), -0)).toBe(true);
    expect(Object.is(deterministicProduct([2, -0, -1]), 0)).toBe(true);
  });
});
