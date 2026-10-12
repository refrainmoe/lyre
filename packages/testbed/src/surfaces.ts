// Browser-independent surface comparison and preview composition helpers.
// Renderer surfaces are premultiplied RGBA8 and may contain RGB greater than
// alpha (extended additive emission), so previews must composite explicitly.

export interface Surface {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface SurfaceComparison {
  pass: boolean;
  maxDiff: number;
  badPixels: number;
  catastrophicPixels: number;
  largestCatastrophicRegion: number;
  totalPixels: number;
}

export type PreviewBackdrop = "checker" | "dark" | "light";

export const CHANNEL_TOLERANCE = 2;
export const CATASTROPHIC_CHANNEL_TOLERANCE = 16;
export const CATASTROPHIC_REGION_PIXEL_LIMIT = 8;
const PIXEL_PASS_RATIO = 0.999;

/** Largest 8-connected catastrophic component, capped at limit + 1. */
function largestCatastrophicRegion(mask: Uint8Array, width: number): number {
  let largest = 0;
  const height = mask.length / width;
  const queue = new Int32Array(CATASTROPHIC_REGION_PIXEL_LIMIT + 1);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0) continue;
    let head = 0;
    let tail = 1;
    let count = 0;
    queue[0] = start;
    mask[start] = 0;
    while (head < tail) {
      const pixel = queue[head++]!;
      count++;
      if (count > CATASTROPHIC_REGION_PIXEL_LIMIT) return count;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] === 0) continue;
          mask[neighbor] = 0;
          queue[tail++] = neighbor;
          if (tail > CATASTROPHIC_REGION_PIXEL_LIMIT) {
            return CATASTROPHIC_REGION_PIXEL_LIMIT + 1;
          }
        }
      }
    }
    if (count > largest) largest = count;
  }
  return largest;
}

function expectedLength(surface: Surface, label: string): number {
  if (
    !Number.isSafeInteger(surface.width) ||
    !Number.isSafeInteger(surface.height) ||
    surface.width <= 0 ||
    surface.height <= 0
  ) {
    throw new Error(
      `${label} has invalid dimensions ${String(surface.width)}×${String(surface.height)}`,
    );
  }
  const length = surface.width * surface.height * 4;
  if (!Number.isSafeInteger(length) || surface.data.length !== length) {
    throw new Error(
      `${label} has ${surface.data.length} bytes; expected ${String(length)} for ${surface.width}×${surface.height} RGBA8`,
    );
  }
  return length;
}

export function compareSurfaces(a: Surface, b: Surface): SurfaceComparison {
  const length = expectedLength(a, "first surface");
  expectedLength(b, "second surface");
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`surface dimensions differ (${a.width}×${a.height} vs ${b.width}×${b.height})`);
  }

  let maxDiff = 0;
  let badPixels = 0;
  let catastrophicPixels = 0;
  const totalPixels = length / 4;
  const catastrophicMask = new Uint8Array(totalPixels);
  for (let o = 0; o < length; o += 4) {
    let bad = false;
    let catastrophic = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a.data[o + c]! - b.data[o + c]!);
      if (d > maxDiff) maxDiff = d;
      if (d > CHANNEL_TOLERANCE) bad = true;
      if (d > CATASTROPHIC_CHANNEL_TOLERANCE) catastrophic = true;
    }
    if (bad) badPixels++;
    if (catastrophic) {
      catastrophicPixels++;
      catastrophicMask[o / 4] = 1;
    }
  }
  const largestRegion = largestCatastrophicRegion(catastrophicMask, a.width);
  return {
    pass:
      badPixels / totalPixels <= 1 - PIXEL_PASS_RATIO &&
      largestRegion <= CATASTROPHIC_REGION_PIXEL_LIMIT,
    maxDiff,
    badPixels,
    catastrophicPixels,
    largestCatastrophicRegion: largestRegion,
    totalPixels,
  };
}

function backdropRgb(
  backdrop: PreviewBackdrop,
  x: number,
  y: number,
): readonly [number, number, number] {
  if (backdrop === "dark") return [30, 31, 38];
  if (backdrop === "light") return [232, 233, 237];
  return ((x >> 3) + (y >> 3)) % 2 === 0 ? [44, 45, 56] : [62, 64, 78];
}

/**
 * Composite a premultiplied surface onto an opaque preview backdrop.
 *
 * Doing this ourselves, instead of unpremultiplying into ImageData, preserves
 * extended RGB when alpha is zero: `src.rgb + backdrop * (1 - src.a)`.
 */
export function compositeSurface(
  surface: Surface,
  backdrop: PreviewBackdrop = "checker",
): Uint8ClampedArray {
  const length = expectedLength(surface, "surface");
  const out = new Uint8ClampedArray(length);
  for (let y = 0; y < surface.height; y++) {
    for (let x = 0; x < surface.width; x++) {
      const o = (y * surface.width + x) * 4;
      const a = surface.data[o + 3]!;
      const [br, bg, bb] = backdropRgb(backdrop, x, y);
      const remaining = 255 - a;
      out[o] = Math.min(255, surface.data[o]! + Math.round((br * remaining) / 255));
      out[o + 1] = Math.min(255, surface.data[o + 1]! + Math.round((bg * remaining) / 255));
      out[o + 2] = Math.min(255, surface.data[o + 2]! + Math.round((bb * remaining) / 255));
      out[o + 3] = 255;
    }
  }
  return out;
}
