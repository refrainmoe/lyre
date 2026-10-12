// Deformer math: rotator (§8.2) and warp (§5.5), applied to xy-pair buffers
// in place. Deformation flows down the tree; callers apply nearest ancestor
// first, root last (§8.1 step 4).

export interface RotatorState {
  /** Rest pivot (§8.2). */
  cx: number;
  cy: number;
  /** Additive pivot translation (`pivot_offset`). */
  tx: number;
  ty: number;
  /** Effective angle, degrees, positive clockwise under +y down (§4). */
  angle: number;
  /** Effective uniform scale. */
  scale: number;
}

/**
 * §8.2: f(p) = c₀ + t + s·R(θ)·(p − c₀). Thus the rest pivot c₀ maps to
 * c₀ + t, and `pivot_offset` translates the whole subtree even when θ = 0
 * and s = 1. With +y down and θ clockwise-positive, R(θ) =
 * [cos −sin; sin cos] in (x, y).
 */
export function applyRotator(state: RotatorState, points: Float64Array): void {
  // Preserve the pure-translation case directly. Reassociating it through a
  // distant pivot (`c + t + (p - c)`) can erase low bits of `p`, so an empty
  // rest rotator would otherwise move valid geometry.
  if (state.angle === 0 && state.scale === 1) {
    for (let i = 0; i < points.length; i += 2) {
      points[i] = points[i]! + state.tx;
      points[i + 1] = points[i + 1]! + state.ty;
    }
    return;
  }
  const rad = (state.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const s = state.scale;
  for (let i = 0; i < points.length; i += 2) {
    const dx = points[i]! - state.cx;
    const dy = points[i + 1]! - state.cy;
    points[i] = state.cx + state.tx + s * (cos * dx - sin * dy);
    points[i + 1] = state.cy + state.ty + s * (sin * dx + cos * dy);
  }
}

export interface WarpState {
  rect: readonly [number, number, number, number];
  cols: number;
  rows: number;
  /** Displaced control points (rest grid + deltas), xy pairs, row-major. */
  points: Float64Array;
  /**
   * Accumulated control-point deltas, when they are available directly.
   *
   * Keeping these separately avoids a lossy `rest + delta - rest`
   * round-trip when a small authored displacement is attached to a large
   * rest coordinate. `points` remains part of the public low-level shape for
   * callers that only have displaced control points; runtimes should supply
   * `deltas` so §5.5's displacement form is evaluated literally.
   */
  deltas?: Float64Array;
}

/** Rest control-point grid of a warp, xy pairs row-major from top-left (§5.5). */
export function warpRestPoints(
  rect: readonly [number, number, number, number],
  cols: number,
  rows: number,
): Float64Array {
  const [rx, ry, rw, rh] = rect;
  const nx = cols + 1;
  const ny = rows + 1;
  const out = new Float64Array(nx * ny * 2);
  for (let row = 0; row < ny; row++) {
    for (let col = 0; col < nx; col++) {
      const i = row * nx + col;
      out[2 * i] = rx + (col / cols) * rw;
      out[2 * i + 1] = ry + (row / rows) * rh;
    }
  }
  return out;
}

/**
 * §5.5 mapping: bilinear interpolation of the four displaced control points of
 * the containing cell. Outside rect, the fractional cell index selects the
 * clamped (edge/corner) cell and that cell's bilinear function is evaluated at
 * the point's actual local coordinates — extrapolation, not clamping the point.
 */
export function applyWarp(state: WarpState, points: Float64Array): void {
  const [rx, ry, rw, rh] = state.rect;
  const cols = state.cols;
  const rows = state.rows;
  const nx = cols + 1;
  const cp = state.points;
  const directDeltas = state.deltas;
  for (let i = 0; i < points.length; i += 2) {
    const px = points[i]!;
    const py = points[i + 1]!;
    const fx = ((px - rx) / rw) * cols;
    const fy = ((py - ry) / rh) * rows;
    // Clamp the *cell index*; local coordinates stay unclamped (extrapolation).
    let cx = Math.floor(fx);
    let cy = Math.floor(fy);
    if (cx < 0) cx = 0;
    else if (cx > cols - 1) cx = cols - 1;
    if (cy < 0) cy = 0;
    else if (cy > rows - 1) cy = rows - 1;
    const u = fx - cx;
    const v = fy - cy;
    const i00 = 2 * (cy * nx + cx);
    const i10 = i00 + 2;
    const i01 = i00 + 2 * nx;
    const i11 = i01 + 2;
    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;

    // Evaluate the mathematically equivalent displacement form. Besides using
    // smaller intermediates for ordinary rigs, this preserves a rest warp as
    // the exact identity instead of nudging mesh vertices by a few ULPs. Those
    // nudges can otherwise create isolated raster cracks on shared diagonals.
    const x0 = rx + (cx / cols) * rw;
    const x1 = rx + ((cx + 1) / cols) * rw;
    const y0 = ry + (cy / rows) * rh;
    const y1 = ry + ((cy + 1) / rows) * rh;
    // Do not multiply an exact zero displacement by a potentially infinite
    // extrapolation weight. Positive warp dimensions may be subnormal, so a
    // finite point far outside the rect can overflow its normalized cell
    // coordinate; a rest warp must nevertheless remain the exact identity.
    let displacedX = 0;
    let delta = directDeltas?.[i00] ?? cp[i00]! - x0;
    if (delta !== 0) displacedX += w00 * delta;
    delta = directDeltas?.[i10] ?? cp[i10]! - x1;
    if (delta !== 0) displacedX += w10 * delta;
    delta = directDeltas?.[i01] ?? cp[i01]! - x0;
    if (delta !== 0) displacedX += w01 * delta;
    delta = directDeltas?.[i11] ?? cp[i11]! - x1;
    if (delta !== 0) displacedX += w11 * delta;

    let displacedY = 0;
    delta = directDeltas?.[i00 + 1] ?? cp[i00 + 1]! - y0;
    if (delta !== 0) displacedY += w00 * delta;
    delta = directDeltas?.[i10 + 1] ?? cp[i10 + 1]! - y0;
    if (delta !== 0) displacedY += w10 * delta;
    delta = directDeltas?.[i01 + 1] ?? cp[i01 + 1]! - y1;
    if (delta !== 0) displacedY += w01 * delta;
    delta = directDeltas?.[i11 + 1] ?? cp[i11 + 1]! - y1;
    if (delta !== 0) displacedY += w11 * delta;

    points[i] = px + displacedX;
    points[i + 1] = py + displacedY;
  }
}
