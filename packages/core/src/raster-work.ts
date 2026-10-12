import { RUNTIME_LIMITS } from "./limits.js";
import type { DeformedGeometry, EvalFrame } from "./types/frame.js";
import type { ReadonlyFloat64Array } from "./types/model.js";

/**
 * Preflight the candidate-pixel work a renderer will perform for one frame.
 *
 * A unit is one triangle setup plus one candidate pixel in that triangle's
 * clipped integer bounding box. Mask-source work is counted each time the
 * draw order switches to a different mask group, matching both reference
 * renderers. The complete frame is checked before any model-surface mutation.
 */
export function assertRasterWorkWithinLimit(
  frame: EvalFrame,
  width: number,
  height: number,
  limit: number = RUNTIME_LIMITS.rasterSampleTestsPerFrame,
): number {
  if (frame.canvas.width !== width || frame.canvas.height !== height) {
    throw new RangeError(
      `frame canvas ${frame.canvas.width}×${frame.canvas.height} does not match renderer surface ${width}×${height}`,
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`raster work limit must be a positive safe integer`);
  }

  let work = 0;
  const add = (units: number): void => {
    if (!Number.isSafeInteger(units) || units < 0 || units > limit - work) {
      const normativeSuffix =
        limit === RUNTIME_LIMITS.rasterSampleTestsPerFrame
          ? ` (${RUNTIME_LIMITS.rasterSampleTestsPerFrame} normative per-frame maximum)`
          : "";
      throw new RangeError(`frame exceeds ${limit} raster candidate tests${normativeSuffix}`);
    }
    work += units;
  };

  const inspect = (geometry: DeformedGeometry): void => {
    const { positions, uvs, indices } = geometry;
    if (positions.length % 2 !== 0 || uvs.length !== positions.length || indices.length % 3 !== 0) {
      throw new RangeError(`geometry for sprite "${geometry.sprite.id}" has inconsistent buffers`);
    }
    // Both renderers revisit these scalars for each draw/mask reconstruction,
    // including geometry with no triangles. Charge that validation scan.
    add(positions.length + uvs.length);
    for (const value of positions) {
      if (!Number.isFinite(value)) {
        throw new RangeError(
          `geometry for sprite "${geometry.sprite.id}" has a non-finite position`,
        );
      }
    }
    for (const value of uvs) {
      if (!Number.isFinite(value)) {
        throw new RangeError(`geometry for sprite "${geometry.sprite.id}" has a non-finite uv`);
      }
    }

    const pointCount = positions.length / 2;
    for (let t = 0; t < indices.length; t += 3) {
      add(1); // triangle setup, including degenerate/off-canvas triangles
      const i0 = indices[t]!;
      let i1 = indices[t + 1]!;
      let i2 = indices[t + 2]!;
      if (i0 >= pointCount || i1 >= pointCount || i2 >= pointCount) {
        throw new RangeError(
          `geometry for sprite "${geometry.sprite.id}" indexes outside positions`,
        );
      }
      const ax = positions[2 * i0]!;
      const ay = positions[2 * i0 + 1]!;
      let bx = positions[2 * i1]!;
      let by = positions[2 * i1 + 1]!;
      let cx = positions[2 * i2]!;
      let cy = positions[2 * i2 + 1]!;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!Number.isFinite(area)) {
        throw new RangeError(
          `geometry for sprite "${geometry.sprite.id}" overflows its triangle area`,
        );
      }
      if (area === 0) continue;
      if (area < 0) {
        [i1, i2] = [i2, i1];
        [bx, cx] = [cx, bx];
        [by, cy] = [cy, by];
      }
      const absArea = Math.abs(area);

      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
      if (minX <= maxX && minY <= maxY) {
        add((maxX - minX + 1) * (maxY - minY + 1));
        assertFiniteTriangleRaster(
          geometry.sprite.id,
          positions,
          uvs,
          i0,
          i1,
          i2,
          absArea,
          minX,
          maxX,
          minY,
          maxY,
        );
      }
    }
  };

  let activeMaskGroup = -1;
  for (const item of frame.drawList) {
    if (!Number.isFinite(item.opacity) || item.opacity < 0 || item.opacity > 1) {
      throw new RangeError(`draw opacity for sprite "${item.sprite.id}" must be within 0..1`);
    }
    if (item.blend !== "normal" && item.blend !== "additive" && item.blend !== "multiply") {
      throw new RangeError(`draw blend for sprite "${item.sprite.id}" is invalid`);
    }
    if (item.mask && item.mask.mode !== "alpha" && item.mask.mode !== "inverted") {
      throw new RangeError(`draw mask mode for sprite "${item.sprite.id}" is invalid`);
    }
    if (item.opacity === 0) continue;
    if (item.mask) {
      if (
        !Number.isInteger(item.mask.group) ||
        item.mask.group < 0 ||
        item.mask.group >= frame.maskGroups.length
      ) {
        throw new RangeError(`draw item for sprite "${item.sprite.id}" has an invalid mask group`);
      }
      if (item.mask.group !== activeMaskGroup) {
        // Both reference renderers clear their reusable full-canvas coverage
        // target before reconstructing a newly active group.
        add(width * height);
        for (const source of frame.maskGroups[item.mask.group]!.sources) inspect(source);
        activeMaskGroup = item.mask.group;
      }
    }
    inspect(item);
  }
  return work;
}

type EdgeCorners = readonly [number, number, number, number];

/** The exact edge-function operation order used by both reference rasterizers. */
function orient2d(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/** Top-left coverage rule shared with the reference rasterizers (§8.3.1). */
function covers(w: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (w > 0) return true;
  if (w < 0) return false;
  return ay === by ? bx > ax : by < ay;
}

/**
 * Evaluate an edge at the four pixel-center corners of a clipped candidate
 * box. For fixed finite endpoints the written IEEE-754 expression is monotone
 * in each pixel coordinate (with direction depending on the edge). Therefore
 * finite values at all four corners prove every edge evaluation in the box is
 * finite; an overflowing product or subtraction would reach an extremum at a
 * corner. The corners themselves are real candidate pixels, so rejecting a
 * non-finite corner is not a conservative false positive.
 */
function edgeCorners(
  spriteId: string,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): EdgeCorners {
  const x0 = minX + 0.5;
  const x1 = maxX + 0.5;
  const y0 = minY + 0.5;
  const y1 = maxY + 0.5;
  const values = [
    orient2d(ax, ay, bx, by, x0, y0),
    orient2d(ax, ay, bx, by, x1, y0),
    orient2d(ax, ay, bx, by, x0, y1),
    orient2d(ax, ay, bx, by, x1, y1),
  ] as const;
  if (!values.every(Number.isFinite)) {
    throw new RangeError(`raster edge arithmetic for sprite "${spriteId}" is non-finite`);
  }
  return values;
}

function maximumCoveredWeight(corners: EdgeCorners): number {
  return Math.max(0, corners[0], corners[1], corners[2], corners[3]);
}

/**
 * Prove the three weighted terms and their left-associated sum finite for one
 * affine coordinate. IEEE division and multiplication are monotone over these
 * non-negative bounds, so the calculated values bound the operations the
 * rasterizer will perform at every covered pixel.
 */
function coordinateNeedsScan(
  lambdaBounds: readonly [number, number, number],
  a: number,
  b: number,
  c: number,
): boolean {
  let sumBound = 0;
  for (const [lambda, value] of [
    [lambdaBounds[0], a],
    [lambdaBounds[1], b],
    [lambdaBounds[2], c],
  ] as const) {
    const termBound = lambda * Math.abs(value);
    if (!Number.isFinite(termBound)) return true;
    sumBound += termBound;
    if (!Number.isFinite(sumBound)) return true;
  }
  return false;
}

function assertFiniteTriangleRaster(
  spriteId: string,
  positions: ReadonlyFloat64Array,
  uvs: ReadonlyFloat64Array,
  i0: number,
  i1: number,
  i2: number,
  absArea: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): void {
  const ax = positions[2 * i0]!;
  const ay = positions[2 * i0 + 1]!;
  const bx = positions[2 * i1]!;
  const by = positions[2 * i1 + 1]!;
  const cx = positions[2 * i2]!;
  const cy = positions[2 * i2 + 1]!;
  const edge0 = edgeCorners(spriteId, bx, by, cx, cy, minX, maxX, minY, maxY);
  const edge1 = edgeCorners(spriteId, cx, cy, ax, ay, minX, maxX, minY, maxY);
  const edge2 = edgeCorners(spriteId, ax, ay, bx, by, minX, maxX, minY, maxY);
  const lambdaBounds = [
    maximumCoveredWeight(edge0) / absArea,
    maximumCoveredWeight(edge1) / absArea,
    maximumCoveredWeight(edge2) / absArea,
  ] as const;

  const needsScan =
    !lambdaBounds.every(Number.isFinite) ||
    coordinateNeedsScan(lambdaBounds, uvs[2 * i0]!, uvs[2 * i1]!, uvs[2 * i2]!) ||
    coordinateNeedsScan(lambdaBounds, uvs[2 * i0 + 1]!, uvs[2 * i1 + 1]!, uvs[2 * i2 + 1]!);
  if (!needsScan) return;

  // Only numerically extreme triangles take this path. The enclosing frame
  // work preflight already bounds this loop by the raster candidate ceiling.
  // Inspect the exact operation order before the renderer clears its target.
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = orient2d(bx, by, cx, cy, px, py);
      const w1 = orient2d(cx, cy, ax, ay, px, py);
      const w2 = orient2d(ax, ay, bx, by, px, py);
      if (!Number.isFinite(w0) || !Number.isFinite(w1) || !Number.isFinite(w2)) {
        throw new RangeError(`raster edge arithmetic for sprite "${spriteId}" is non-finite`);
      }
      if (!covers(w0, bx, by, cx, cy)) continue;
      if (!covers(w1, cx, cy, ax, ay)) continue;
      if (!covers(w2, ax, ay, bx, by)) continue;

      const l0 = w0 / absArea;
      const l1 = w1 / absArea;
      const l2 = w2 / absArea;
      const u0 = l0 * uvs[2 * i0]!;
      const u1 = l1 * uvs[2 * i1]!;
      const u01 = u0 + u1;
      const u2 = l2 * uvs[2 * i2]!;
      const u = u01 + u2;
      const v0 = l0 * uvs[2 * i0 + 1]!;
      const v1 = l1 * uvs[2 * i1 + 1]!;
      const v01 = v0 + v1;
      const v2 = l2 * uvs[2 * i2 + 1]!;
      const v = v01 + v2;
      if (
        !Number.isFinite(l0) ||
        !Number.isFinite(l1) ||
        !Number.isFinite(l2) ||
        !Number.isFinite(u0) ||
        !Number.isFinite(u1) ||
        !Number.isFinite(u01) ||
        !Number.isFinite(u2) ||
        !Number.isFinite(u) ||
        !Number.isFinite(v0) ||
        !Number.isFinite(v1) ||
        !Number.isFinite(v01) ||
        !Number.isFinite(v2) ||
        !Number.isFinite(v)
      ) {
        throw new RangeError(`affine UV arithmetic for sprite "${spriteId}" is non-finite`);
      }
    }
  }
}
