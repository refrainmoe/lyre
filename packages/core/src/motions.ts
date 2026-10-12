import type { MotionDef, MotionTrack } from "./types/model.js";

/**
 * §10.2: CSS-style cubic bezier easing in normalized segment space. Control
 * points (0,0), (x1,y1), (x2,y2), (1,1); x1, x2 ∈ [0,1] so x(u) is monotonic.
 * Solves x(u) = s to within 1e-4 (Newton with bisection fallback) and returns
 * y at that u.
 */
export function cubicBezierEase(cp: readonly [number, number, number, number], s: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  const [x1, y1, x2, y2] = cp;

  const sample = (u: number, a: number, b: number): number => {
    // Cubic bezier through (0, a·?, …): B(u) = 3(1−u)²u·a + 3(1−u)u²·b + u³.
    const inv = 1 - u;
    return 3 * inv * inv * u * a + 3 * inv * u * u * b + u * u * u;
  };
  const sampleDx = (u: number): number => {
    const inv = 1 - u;
    return 3 * inv * inv * x1 + 6 * inv * u * (x2 - x1) + 3 * u * u * (1 - x2);
  };

  const EPS = 1e-4;
  // Newton's method from u = s.
  let u = s;
  for (let i = 0; i < 8; i++) {
    const x = sample(u, x1, x2) - s;
    if (Math.abs(x) < EPS) return sample(u, y1, y2);
    const dx = sampleDx(u);
    if (Math.abs(dx) < 1e-6) break; // flat tangent — bisect instead
    u -= x / dx;
    if (u <= 0 || u >= 1) break; // left the bracket — bisect instead
  }
  // Bisection fallback (x(u) is monotonic non-decreasing in u).
  let lo = 0;
  let hi = 1;
  u = s;
  for (let i = 0; i < 64; i++) {
    const x = sample(u, x1, x2);
    if (Math.abs(x - s) < EPS) break;
    if (x < s) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return sample(u, y1, y2);
}

/**
 * Sample one track at local time t (already loop-wrapped). Before the first
 * key the first key's value holds; after the last, the last key's value.
 * A key's ease describes the segment ending at that key (§10.2).
 */
export function sampleTrack(track: MotionTrack, t: number): number {
  const keys = track.keys;
  const first = keys[0]!;
  if (t <= first.t) return first.v;
  const last = keys[keys.length - 1]!;
  if (t > last.t) return last.v;

  // Find the first key whose time is >= t. Motion documents can carry up to
  // the aggregate key ceiling, so a per-sample linear scan would multiply
  // badly with fixed-step physics input sampling.
  let lo = 1;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = lo + ((hi - lo) >> 1);
    if (t <= keys[mid]!.t) hi = mid;
    else lo = mid + 1;
  }
  const k = keys[lo]!;
  const prev = keys[lo - 1]!;
  const span = k.t - prev.t;
  const s = span === 0 ? 1 : (t - prev.t) / span;
  switch (k.ease.type) {
    case "step":
      return t < k.t ? prev.v : k.v;
    case "linear":
      return prev.v * (1 - s) + k.v * s;
    case "bezier": {
      const eased = cubicBezierEase(k.ease.cp, s);
      return prev.v * (1 - eased) + k.v * eased;
    }
  }
}

/** Local playback time of a motion: loop wraps t modulo duration (§10.2). */
export function motionLocalTime(def: MotionDef, t: number): number {
  if (def.loop) {
    const m = t % def.duration;
    return m < 0 ? m + def.duration : m;
  }
  return t > def.duration ? def.duration : t;
}
