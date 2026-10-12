// Minimal deterministic software 2D painter producing straight-alpha RGBA
// buffers for corpus textures. No native dependencies, no randomness, no
// timestamps: regeneration is byte-identical.

export interface Buf {
  w: number;
  h: number;
  /** Straight (non-premultiplied) RGBA8. */
  data: Uint8Array;
}

export type RGBA = readonly [number, number, number, number];

export function buf(w: number, h: number): Buf {
  return { w, h, data: new Uint8Array(w * h * 4) };
}

/** Source-over in straight alpha (painter working space, not §8.3). */
function blendPixel(b: Buf, x: number, y: number, c: RGBA, coverage = 1): void {
  if (x < 0 || y < 0 || x >= b.w || y >= b.h) return;
  const a = (c[3] / 255) * coverage;
  if (a <= 0) return;
  const o = (y * b.w + x) * 4;
  const da = b.data[o + 3]! / 255;
  const outA = a + da * (1 - a);
  if (outA === 0) return;
  for (let i = 0; i < 3; i++) {
    const src = c[i]!;
    const dst = b.data[o + i]!;
    b.data[o + i] = Math.round((src * a + dst * da * (1 - a)) / outA);
  }
  b.data[o + 3] = Math.round(outA * 255);
}

export function fillRect(b: Buf, x: number, y: number, w: number, h: number, c: RGBA): void {
  for (let yy = Math.max(0, y); yy < Math.min(b.h, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(b.w, x + w); xx++) {
      blendPixel(b, xx, yy, c);
    }
  }
}

/**
 * Filled ellipse centred at (cx, cy); `soft` is the antialias/falloff band in
 * pixels (alpha ramps linearly to 0 across it).
 */
export function fillEllipse(
  b: Buf,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  c: RGBA,
  soft = 1,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - soft));
  const x1 = Math.min(b.w - 1, Math.ceil(cx + rx + soft));
  const y0 = Math.max(0, Math.floor(cy - ry - soft));
  const y1 = Math.min(b.h - 1, Math.ceil(cy + ry + soft));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy); // 1 at the rim
      // Distance from rim in pixels, approximated along the radial direction.
      const rim = (d - 1) * Math.min(rx, ry);
      const cov = rim <= -soft ? 1 : rim >= 0 ? 0 : -rim / soft;
      if (cov > 0) blendPixel(b, x, y, c, cov);
    }
  }
}

/** Radial gradient: `inner` at the centre fading to `outer` at radius r. */
export function radial(b: Buf, cx: number, cy: number, r: number, inner: RGBA, outer: RGBA): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(b.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(b.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const t = Math.min(1, Math.sqrt(dx * dx + dy * dy) / r);
      const c: RGBA = [
        Math.round(inner[0] + (outer[0] - inner[0]) * t),
        Math.round(inner[1] + (outer[1] - inner[1]) * t),
        Math.round(inner[2] + (outer[2] - inner[2]) * t),
        Math.round(inner[3] + (outer[3] - inner[3]) * t),
      ];
      blendPixel(b, x, y, c);
    }
  }
}

/** Two-color checkerboard (opaque), cell size in pixels. */
export function checker(b: Buf, cell: number, a: RGBA, c: RGBA): void {
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      blendPixel(b, x, y, on ? a : c);
    }
  }
}

/** Horizontal gradient left→right across the whole buffer. */
export function hGradient(b: Buf, left: RGBA, right: RGBA): void {
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const t = b.w === 1 ? 0 : x / (b.w - 1);
      blendPixel(b, x, y, [
        Math.round(left[0] + (right[0] - left[0]) * t),
        Math.round(left[1] + (right[1] - left[1]) * t),
        Math.round(left[2] + (right[2] - left[2]) * t),
        Math.round(left[3] + (right[3] - left[3]) * t),
      ]);
    }
  }
}

/** Elliptical ring: coverage where the radial distance is within `thick` px of the rim. */
export function strokeEllipse(
  b: Buf,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  thick: number,
  c: RGBA,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - thick));
  const x1 = Math.min(b.w - 1, Math.ceil(cx + rx + thick));
  const y0 = Math.max(0, Math.floor(cy - ry - thick));
  const y1 = Math.min(b.h - 1, Math.ceil(cy + ry + thick));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const rim = (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry);
      const d = Math.abs(rim) - thick / 2;
      const cov = d <= -0.5 ? 1 : d >= 0.5 ? 0 : 0.5 - d;
      if (cov > 0) blendPixel(b, x, y, c, cov);
    }
  }
}

export function solid(w: number, h: number, c: RGBA): Buf {
  const b = buf(w, h);
  fillRect(b, 0, 0, w, h, c);
  return b;
}
