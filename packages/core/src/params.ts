import type { ParamDef } from "./types/model.js";

/** Positive modulo: result in [0, n) for n > 0. */
export function posMod(a: number, n: number): number {
  const m = a % n;
  return m < 0 ? m + n : m;
}

/**
 * §6: clamp a parameter value to [min, max], or wrap modulo [min, max) when
 * the parameter declares `wrap: true`. Applied once, after all value sources
 * (§6.1 stage 6).
 */
export function clampOrWrap(def: ParamDef, v: number): number {
  if (!Number.isFinite(v)) {
    throw new RangeError(`parameter "${def.id}" value must be finite`);
  }
  if (def.wrap) {
    const range = def.max - def.min;
    if (range <= 0) return def.min;
    return def.min + posMod(v - def.min, range);
  }
  return v < def.min ? def.min : v > def.max ? def.max : v;
}
