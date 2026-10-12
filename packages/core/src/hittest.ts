import { RUNTIME_LIMITS } from "./limits.js";
import type { ReadonlyFloat64Array, ReadonlyUint32Array } from "./types/model.js";

/**
 * §11: hit-testing is point-in-deformed-triangle; texture alpha is ignored,
 * so transparent texels still hit. Coordinates are canvas-space, the same
 * space as DeformedGeometry.positions.
 */
export function hitTestGeometry(
  positions: ReadonlyFloat64Array,
  indices: ReadonlyUint32Array,
  x: number,
  y: number,
): boolean {
  return hitTestGeometryWithBudget(positions, indices, x, y, { count: 0 });
}

interface HitTestBudget {
  count: number;
}

/**
 * Package-internal variant used by Runtime.hitTest so every draw item shares
 * one §16 exact-predicate budget for the host query.
 */
export function hitTestGeometryWithBudget(
  positions: ReadonlyFloat64Array,
  indices: ReadonlyUint32Array,
  x: number,
  y: number,
  exactWork: HitTestBudget,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!;
    const ib = indices[t + 1]!;
    const ic = indices[t + 2]!;
    if (ia === ib || ib === ic || ic === ia) continue;
    const a = ia * 2;
    const b = ib * 2;
    const c = ic * 2;
    if (
      pointInTriangle(
        x,
        y,
        positions[a]!,
        positions[a + 1]!,
        positions[b]!,
        positions[b + 1]!,
        positions[c]!,
        positions[c + 1]!,
        exactWork,
      )
    ) {
      return true;
    }
  }
  return false;
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  exactWork: { count: number },
): boolean {
  if (
    !Number.isFinite(ax) ||
    !Number.isFinite(ay) ||
    !Number.isFinite(bx) ||
    !Number.isFinite(by) ||
    !Number.isFinite(cx) ||
    !Number.isFinite(cy)
  ) {
    return false;
  }
  if ((ax === bx && ay === by) || (bx === cx && by === cy) || (cx === ax && cy === ay)) {
    return false;
  }
  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minY = Math.min(ay, by, cy);
  const maxY = Math.max(ay, by, cy);
  if (px < minX || px > maxX || py < minY || py > maxY) return false;

  const area = orientSign(ax, ay, bx, by, cx, cy, exactWork);
  if (area === 0) return false;
  const d1 = orientSign(ax, ay, bx, by, px, py, exactWork);
  const d2 = orientSign(bx, by, cx, cy, px, py, exactWork);
  const d3 = orientSign(cx, cy, ax, ay, px, py, exactWork);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const orientBits = new DataView(new ArrayBuffer(8));
const ORIENT_ERR_BOUND = 3.3306690738754716e-16;

/** Robust sign of (b-a)×(p-a), with exact BigInt fallback near degeneracy. */
function orientSign(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
  exactWork: { count: number },
): -1 | 0 | 1 {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  if ((abx === 0 && apx === 0) || (aby === 0 && apy === 0)) return 0;

  const left = abx * apy;
  const right = aby * apx;
  const determinant = left - right;
  const magnitude = Math.abs(left) + Math.abs(right);
  if (
    Number.isFinite(determinant) &&
    Number.isFinite(magnitude) &&
    Math.abs(determinant) > ORIENT_ERR_BOUND * magnitude
  ) {
    return determinant < 0 ? -1 : 1;
  }
  if (++exactWork.count > RUNTIME_LIMITS.hitTestExactPredicatesPerQuery) {
    throw new RangeError(
      `hit-test query exceeds ${RUNTIME_LIMITS.hitTestExactPredicatesPerQuery} exact orientation predicates (§16)`,
    );
  }
  return exactOrientSign(ax, ay, bx, by, px, py);
}

interface ExactFloat {
  mantissa: bigint;
  exponent: number;
}

function exactFloat(value: number): ExactFloat {
  orientBits.setFloat64(0, value, false);
  const bits = orientBits.getBigUint64(0, false);
  const negative = bits >> 63n !== 0n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000f_ffff_ffff_ffffn;
  const mantissa = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
  return {
    mantissa: negative ? -mantissa : mantissa,
    exponent: exponentBits === 0 ? -1074 : exponentBits - 1075,
  };
}

function exactSubtract(a: ExactFloat, b: ExactFloat): ExactFloat {
  const exponent = Math.min(a.exponent, b.exponent);
  return {
    mantissa:
      (a.mantissa << BigInt(a.exponent - exponent)) - (b.mantissa << BigInt(b.exponent - exponent)),
    exponent,
  };
}

function exactMultiply(a: ExactFloat, b: ExactFloat): ExactFloat {
  return {
    mantissa: a.mantissa * b.mantissa,
    exponent: a.exponent + b.exponent,
  };
}

function exactOrientSign(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): -1 | 0 | 1 {
  const abx = exactSubtract(exactFloat(bx), exactFloat(ax));
  const aby = exactSubtract(exactFloat(by), exactFloat(ay));
  const apx = exactSubtract(exactFloat(px), exactFloat(ax));
  const apy = exactSubtract(exactFloat(py), exactFloat(ay));
  const determinant = exactSubtract(exactMultiply(abx, apy), exactMultiply(aby, apx)).mantissa;
  return determinant < 0n ? -1 : determinant > 0n ? 1 : 0;
}
