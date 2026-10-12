// Deterministic scalar aggregation for §7 binding combinations. JavaScript's
// ordinary left fold is neither associative nor permutation-independent: large
// cancellation can lose small deltas, while a balanced factor product can
// overflow or underflow solely because equivalent bindings were reordered.

/** Canonical order used before compensated additive accumulation. */
function compareMagnitudeDescending(a: number, b: number): number {
  const aa = Math.abs(a);
  const bb = Math.abs(b);
  if (aa > bb) return -1;
  if (aa < bb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  // Total ordering for the only numerically equal but bit-distinct values.
  if (Object.is(a, -0) && Object.is(b, 0)) return -1;
  if (Object.is(a, 0) && Object.is(b, -0)) return 1;
  return 0;
}

/**
 * Canonical Neumaier sum. Sorting makes the result independent of binding
 * document order; compensation preserves small residuals through cancellation.
 */
export function deterministicSum(values: ReadonlyArray<number>): number {
  const ordered = Array.from(values).sort(compareMagnitudeDescending);
  let sum = 0;
  let compensation = 0;
  for (const value of ordered) {
    const next = sum + value;
    if (Math.abs(sum) >= Math.abs(value)) {
      compensation += sum - next + value;
    } else {
      compensation += value - next + sum;
    }
    sum = next;
  }
  return sum + compensation;
}

const floatBits = new DataView(new ArrayBuffer(8));
const FRACTION_SCALE = 4_503_599_627_370_496; // 2^52

/** Exact base-2 decomposition of a positive finite double as m·2^e, 0.5≤m<1. */
function binaryParts(value: number): readonly [mantissa: number, exponent: number] {
  floatBits.setFloat64(0, value, false);
  const bits = floatBits.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = Number(bits & 0x000f_ffff_ffff_ffffn);
  if (exponentBits !== 0) {
    return [(1 + fraction / FRACTION_SCALE) / 2, exponentBits - 1022];
  }

  // Subnormals have value fraction·2^-1074. Find the leading bit without
  // relying on Math.log2 rounding at integers immediately below a power of 2.
  let leadingBit = 0;
  let scan = fraction;
  while (scan >= 2) {
    scan = Math.floor(scan / 2);
    leadingBit++;
  }
  return [fraction / 2 ** (leadingBit + 1), -1073 + leadingBit];
}

/**
 * Canonical, range-scaled factor product. Magnitudes are consumed largest,
 * smallest, next-largest, next-smallest, ... while a normalized mantissa and
 * integer base-2 exponent keep a representable final product from overflowing
 * or underflowing in an intermediate multiplication.
 */
export function deterministicProduct(values: ReadonlyArray<number>): number {
  let negative = false;
  let hasZero = false;
  const magnitudes: number[] = [];
  for (const value of values) {
    if (value < 0 || Object.is(value, -0)) negative = !negative;
    const magnitude = Math.abs(value);
    if (magnitude === 0) hasZero = true;
    else if (magnitude !== 1) magnitudes.push(magnitude);
  }
  if (hasZero) return negative ? -0 : 0;
  if (magnitudes.length === 0) return negative ? -1 : 1;

  magnitudes.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  let mantissa = 1;
  let exponent = 0;
  let left = 0;
  let right = magnitudes.length - 1;
  let takeLargest = true;
  while (left <= right) {
    const magnitude = takeLargest ? magnitudes[left++]! : magnitudes[right--]!;
    takeLargest = !takeLargest;
    const [partMantissa, partExponent] = binaryParts(magnitude);
    mantissa *= partMantissa;
    exponent += partExponent;
    if (mantissa < 0.5) {
      mantissa *= 2;
      exponent--;
    }
  }

  let result: number;
  if (exponent > 1024) {
    result = Number.POSITIVE_INFINITY;
  } else if (exponent === 1024) {
    // 2^1024 is not representable, but m·2^1024 may be. Reassociate through
    // the finite 2^1023 scale so values through Number.MAX_VALUE survive.
    result = mantissa * 2 * 2 ** 1023;
  } else if (exponent < -1074) {
    result = 0;
  } else {
    result = mantissa * 2 ** exponent;
  }
  return negative ? -result : result;
}
