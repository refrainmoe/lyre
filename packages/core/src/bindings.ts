import type { BindableProperty, Binding, ParamDef, PropertyClass } from "./types/model.js";
import { posMod } from "./params.js";

/** §7 rule 5: additive properties sum; factor properties (opacity, scale) multiply. */
export function propertyClass(property: BindableProperty): PropertyClass {
  return property === "opacity" || property === "scale" ? "factor" : "additive";
}

/** Scalars per value entry for each property; grid/verts arity depends on the mesh. */
export function scalarProperties(): ReadonlySet<BindableProperty> {
  return SCALAR_PROPS;
}
const SCALAR_PROPS: ReadonlySet<BindableProperty> = new Set(["angle", "opacity", "scale", "z"]);
const VEC2_PROPS: ReadonlySet<BindableProperty> = new Set(["offset", "pivot_offset"]);

export function isScalarProperty(p: BindableProperty): boolean {
  return SCALAR_PROPS.has(p);
}
export function isVec2Property(p: BindableProperty): boolean {
  return VEC2_PROPS.has(p);
}

interface AxisSample {
  /** Lower/upper key indices bracketing the value. */
  i0: number;
  i1: number;
  /** Interpolation fraction in [0, 1] between i0 and i1. */
  t: number;
}

/**
 * Locate a (clamped-or-wrapped) parameter value on a strictly-increasing axis
 * (§7 rule 3). Outside the axis range the boundary key is held — except on a
 * wrapping parameter's axis, where the interval past the last key wraps
 * around to the first key, interpolating across the seam.
 */
export function sampleAxis(axis: ReadonlyArray<number>, def: ParamDef, v: number): AxisSample {
  const n = axis.length;
  const first = axis[0]!;
  const last = axis[n - 1]!;
  if (n === 1) return { i0: 0, i1: 0, t: 0 };

  if (v >= first && v <= last) {
    // Find the containing interval (n ≤ 33, linear scan is fine and branch-simple).
    let i = 1;
    while (i < n - 1 && v > axis[i]!) i++;
    const a = axis[i - 1]!;
    const b = axis[i]!;
    const t = b === a ? 0 : (v - a) / (b - a);
    return { i0: i - 1, i1: i, t };
  }

  if (!def.wrap) {
    // Clamp: hold the boundary value.
    return v < first ? { i0: 0, i1: 0, t: 0 } : { i0: n - 1, i1: n - 1, t: 0 };
  }

  // Wrap seam: v lies in the interval from the last key forward (through
  // max→min) to the first key. Distance travelled from the last key, wrapped
  // into the parameter's period, over the seam length.
  const range = def.max - def.min;
  const seam = range - (last - first);
  if (seam <= 0) {
    // Keys span the whole period; v cannot lie strictly outside. Defensive hold.
    return { i0: n - 1, i1: n - 1, t: 0 };
  }
  const d = posMod(v - last, range);
  return { i0: n - 1, i1: 0, t: d / seam };
}

/**
 * Evaluate one binding at the given (already clamped/wrapped) parameter
 * values via multilinear interpolation (§7 rule 3), writing the entry-shaped
 * result into `out` (length = binding.arity).
 */
export function evalBinding(binding: Binding, paramValues: ReadonlyArray<number>): Float64Array {
  const k = binding.params.length;
  const samples: AxisSample[] = new Array(k);
  for (let a = 0; a < k; a++) {
    samples[a] = sampleAxis(binding.axes[a]!, binding.params[a]!, paramValues[a]!);
  }

  // Row-major with the first parameter as the slowest-varying index (§7 rule 2).
  const strides: number[] = new Array(k);
  let stride = 1;
  for (let a = k - 1; a >= 0; a--) {
    strides[a] = stride;
    stride *= binding.axes[a]!.length;
  }

  const out = new Float64Array(binding.arity);
  const corners = 1 << k;
  let hasContribution = false;
  for (let c = 0; c < corners; c++) {
    let w = 1;
    let index = 0;
    for (let a = 0; a < k; a++) {
      const s = samples[a]!;
      if (c & (1 << a)) {
        w *= s.t;
        index += s.i1 * strides[a]!;
      } else {
        w *= 1 - s.t;
        index += s.i0 * strides[a]!;
      }
    }
    if (w === 0) continue;
    const entryOffset = index * binding.arity;
    for (let i = 0; i < out.length; i++) {
      // Assign the first weighted corner directly. Starting every component
      // with +0 would erase an authored -0 factor before §7's canonical
      // product has a chance to retain its sign parity.
      const term = w * binding.values[entryOffset + i]!;
      const next = hasContribution ? out[i]! + term : term;
      if (!Number.isFinite(next)) {
        throw new RangeError(
          `binding for "${binding.target.id}.${binding.property}" overflowed during interpolation`,
        );
      }
      out[i] = next;
    }
    hasContribution = true;
  }
  return out;
}
