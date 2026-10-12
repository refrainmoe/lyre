// @refrain-lyre/render-soft — CPU reference rasterizer for the §8.3
// extended-premultiplied model surface.
//
// This renderer defines the conformance goldens (§12): float64 premultiplied
// accumulation, quantized to RGBA8 once at readSurface(); pixel-center
// sampling with a top-left fill rule (shared mesh edges rasterize exactly
// once); bilinear filtering of premultiplied texels, clamped to the crop
// interior when sampling from an atlas (§3.2); §8.4 mask coverage from raw
// texture alpha over deformed geometry.

import type {
  DeformedGeometry,
  EvalFrame,
  MaskGroup,
  PremultipliedImage,
  SurfaceRenderer,
} from "@refrain-lyre/core";
import { assertRasterWorkWithinLimit, LIMITS } from "@refrain-lyre/core";

interface StoredTexture {
  source: PremultipliedImage;
  image: PremultipliedImage;
  /** Crop rect inside `image` (atlas); defaults to the whole image. */
  rect: readonly [number, number, number, number];
}

interface StoredImage {
  image: PremultipliedImage;
  refs: number;
}

export class SoftRenderer implements SurfaceRenderer {
  private surfaceWidth: number;
  private surfaceHeight: number;
  /** Premultiplied RGBA, 0..1 floats. */
  private surface: Float64Array;
  private maskCoverage: Float64Array | null = null;
  private textures = new Map<string, StoredTexture>();
  private imageRefs = new Map<PremultipliedImage, StoredImage>();
  private texturePixels = 0;

  constructor(width: number, height: number) {
    requireSurfaceDimensions(width, height);
    this.surfaceWidth = width;
    this.surfaceHeight = height;
    this.surface = new Float64Array(width * height * 4);
  }

  get width(): number {
    return this.surfaceWidth;
  }

  get height(): number {
    return this.surfaceHeight;
  }

  /** Resize the target while retaining the already validated texture set. */
  resize(width: number, height: number): void {
    requireSurfaceDimensions(width, height);
    if (width === this.width && height === this.height) return;
    // Allocate before publishing the new dimensions. If allocation fails,
    // the renderer remains a coherent instance with its previous target.
    const surface = new Float64Array(width * height * 4);
    this.surfaceWidth = width;
    this.surfaceHeight = height;
    this.surface = surface;
    this.maskCoverage = null;
  }

  setTexture(
    id: string,
    image: PremultipliedImage,
    atlasRect?: readonly [number, number, number, number],
  ): void {
    let resource = this.imageRefs.get(image);
    const validatedImage = resource?.image ?? image;
    requireTexture(validatedImage, atlasRect);
    // Snapshot every allocation-bearing part of the registration before
    // changing reference counts or replacing the old map entry.
    const rect = snapshotAtlasRect(validatedImage.width, validatedImage.height, atlasRect);
    const existing = this.textures.get(id);
    if (existing?.source === image) {
      this.textures.set(id, {
        source: image,
        image: existing.image,
        rect,
      });
      return;
    }
    const releasedPixels =
      existing && this.imageRefs.get(existing.source)?.refs === 1
        ? existing.image.width * existing.image.height
        : 0;
    const addedPixels = resource ? 0 : image.width * image.height;
    if (this.texturePixels - releasedPixels + addedPixels > LIMITS.totalTexturePixels) {
      throw new RangeError(`textures exceed ${LIMITS.totalTexturePixels} aggregate decoded pixels`);
    }
    // Snapshot a new resource before replacing the texture. Publish the new
    // entry before releasing the old reference, and undo the new accounting
    // if Map insertion itself fails, so replacement is transactional even at
    // allocation boundaries.
    const pendingResource = resource
      ? null
      : {
          image: {
            width: image.width,
            height: image.height,
            data: new Uint8Array(image.data),
          },
          refs: 0,
        };
    const nextResource = resource ?? pendingResource!;
    const registration: StoredTexture = {
      source: image,
      image: nextResource.image,
      rect,
    };
    let insertedResource = false;
    if (!resource) {
      resource = nextResource;
      this.imageRefs.set(image, resource);
      this.texturePixels += image.width * image.height;
      insertedResource = true;
    }
    resource.refs++;
    try {
      this.textures.set(id, registration);
    } catch (error) {
      resource.refs--;
      if (insertedResource) {
        this.imageRefs.delete(image);
        this.texturePixels -= image.width * image.height;
      }
      throw error;
    }
    if (existing) this.releaseImage(existing.source);
  }

  render(frame: EvalFrame): void {
    assertRasterWorkWithinLimit(frame, this.width, this.height);
    this.preflightTextures(frame);
    // A mask surface is the only lazy frame-sized allocation. Perform it
    // before clearing the previously completed frame so allocation failure is
    // atomic from the caller's point of view.
    const needsCoverage = frame.drawList.some((item) => item.opacity !== 0 && item.mask !== null);
    const coverageData = needsCoverage ? this.getMaskCoverage() : null;
    this.surface.fill(0);
    // Keep at most one full-canvas mask buffer resident. Models may carry many
    // distinct source sets; caching one surface per set turns the node ceiling
    // into an avoidable multi-gigabyte allocation.
    let coverageGroup = -1;
    for (const item of frame.drawList) {
      if (item.opacity === 0) continue; // src ≡ 0 is a no-op in every mode
      let mask: { data: Float64Array; inverted: boolean } | null = null;
      if (item.mask) {
        if (coverageGroup !== item.mask.group || coverageData === null) {
          // `needsCoverage` above guarantees this for every non-zero masked
          // item; retain the guard so a malformed hand-built frame cannot
          // turn a future refactor into a partial render.
          if (coverageData === null) throw new Error(`mask coverage was not preallocated`);
          this.buildCoverage(frame.maskGroups[item.mask.group]!, coverageData);
          coverageGroup = item.mask.group;
        }
        mask = { data: coverageData, inverted: item.mask.mode === "inverted" };
      }
      const texture = this.textures.get(item.texture);
      if (!texture) throw new Error(`texture "${item.texture}" not loaded`);
      this.drawGeometry(item, texture, item.opacity, item.blend, mask);
    }
  }

  readSurface(): Uint8Array {
    // Single quantization: round-half-up to RGBA8.
    const out = new Uint8Array(this.surface.length);
    for (let i = 0; i < this.surface.length; i++) {
      const v = Math.round(this.surface[i]! * 255);
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return out;
  }

  /** The float surface itself (for tests and diff tooling). */
  surfaceFloat(): Float64Array {
    return this.surface;
  }

  // ---------------------------------------------------------------------

  private buildCoverage(group: MaskGroup, cov: Float64Array): void {
    cov.fill(0);
    for (const source of group.sources) {
      const texture = this.textures.get(source.texture);
      if (!texture) throw new Error(`mask source texture "${source.texture}" not loaded`);
      // §8.4: deformed geometry and raw texture alpha only; opacity ignored.
      this.rasterize(
        source,
        (px, alpha) => {
          cov[px] = 1 - (1 - cov[px]!) * (1 - alpha);
        },
        texture,
        /*alphaOnly*/ true,
      );
    }
  }

  private getMaskCoverage(): Float64Array {
    this.maskCoverage ??= new Float64Array(this.width * this.height);
    return this.maskCoverage;
  }

  private preflightTextures(frame: EvalFrame): void {
    let activeMaskGroup = -1;
    for (const item of frame.drawList) {
      if (item.opacity === 0) continue;
      if (!this.textures.has(item.texture)) {
        throw new Error(`texture "${item.texture}" not loaded`);
      }
      if (item.mask && item.mask.group !== activeMaskGroup) {
        for (const source of frame.maskGroups[item.mask.group]!.sources) {
          if (!this.textures.has(source.texture)) {
            throw new Error(`mask source texture "${source.texture}" not loaded`);
          }
        }
        activeMaskGroup = item.mask.group;
      }
    }
  }

  private releaseImage(source: PremultipliedImage): void {
    const resource = this.imageRefs.get(source);
    if (resource === undefined) return;
    if (resource.refs > 1) {
      resource.refs--;
      return;
    }
    this.imageRefs.delete(source);
    this.texturePixels -= resource.image.width * resource.image.height;
  }

  private drawGeometry(
    geom: DeformedGeometry,
    texture: StoredTexture,
    opacity: number,
    blend: "normal" | "additive" | "multiply",
    mask: { data: Float64Array; inverted: boolean } | null,
  ): void {
    const surf = this.surface;
    this.rasterize(
      geom,
      (px, a, r, g, b) => {
        // src is the premultiplied sample tinted by effective opacity (§8.3).
        let sr = r * opacity;
        let sg = g * opacity;
        let sb = b * opacity;
        let sa = a * opacity;
        if (mask) {
          const m = mask.inverted ? 1 - mask.data[px]! : mask.data[px]!;
          sr *= m;
          sg *= m;
          sb *= m;
          sa *= m;
        }
        const o = px * 4;
        if (blend === "normal") {
          const inv = 1 - sa;
          surf[o] = sr + surf[o]! * inv;
          surf[o + 1] = sg + surf[o + 1]! * inv;
          surf[o + 2] = sb + surf[o + 2]! * inv;
          surf[o + 3] = sa + surf[o + 3]! * inv;
        } else if (blend === "additive") {
          surf[o] = surf[o]! + sr;
          surf[o + 1] = surf[o + 1]! + sg;
          surf[o + 2] = surf[o + 2]! + sb;
          // out.a = dst.a
        } else {
          // multiply: out.rgb = dst.rgb · (src.rgb + (1 − src.a))
          const inv = 1 - sa;
          surf[o] = surf[o]! * (sr + inv);
          surf[o + 1] = surf[o + 1]! * (sg + inv);
          surf[o + 2] = surf[o + 2]! * (sb + inv);
        }
      },
      texture,
      false,
    );
  }

  /**
   * Rasterize every triangle of `geom`, invoking `emit(pixelIndex, a, r, g, b)`
   * with the bilinear premultiplied sample (0..1 floats) at each covered
   * pixel center. Coverage uses a top-left fill rule so triangles sharing an
   * edge emit each pixel exactly once.
   */
  private rasterize(
    geom: DeformedGeometry,
    emit: (px: number, a: number, r: number, g: number, b: number) => void,
    texture: StoredTexture,
    alphaOnly: boolean,
  ): void {
    const { positions, uvs, indices } = geom;
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t]!;
      let i1 = indices[t + 1]!;
      let i2 = indices[t + 2]!;
      // Positive-area winding (deformation may flip triangles; never cull).
      const area = orient2d(
        positions[2 * i0]!,
        positions[2 * i0 + 1]!,
        positions[2 * i1]!,
        positions[2 * i1 + 1]!,
        positions[2 * i2]!,
        positions[2 * i2 + 1]!,
      );
      if (area === 0) continue;
      if (area < 0) {
        const tmp = i1;
        i1 = i2;
        i2 = tmp;
      }
      const ax = positions[2 * i0]!;
      const ay = positions[2 * i0 + 1]!;
      const bx = positions[2 * i1]!;
      const by = positions[2 * i1 + 1]!;
      const cx = positions[2 * i2]!;
      const cy = positions[2 * i2 + 1]!;
      const absArea = Math.abs(area);

      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(this.width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(this.height - 1, Math.ceil(Math.max(ay, by, cy)));

      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          // Edge functions; wN is the weight of the vertex opposite edge N.
          const w0 = orient2d(bx, by, cx, cy, px, py);
          const w1 = orient2d(cx, cy, ax, ay, px, py);
          const w2 = orient2d(ax, ay, bx, by, px, py);
          if (!covers(w0, bx, by, cx, cy)) continue;
          if (!covers(w1, cx, cy, ax, ay)) continue;
          if (!covers(w2, ax, ay, bx, by)) continue;
          const l0 = w0 / absArea;
          const l1 = w1 / absArea;
          const l2 = w2 / absArea;
          const u = l0 * uvs[2 * i0]! + l1 * uvs[2 * i1]! + l2 * uvs[2 * i2]!;
          const v = l0 * uvs[2 * i0 + 1]! + l1 * uvs[2 * i1 + 1]! + l2 * uvs[2 * i2 + 1]!;
          const s = sampleBilinear(texture, u, v, alphaOnly);
          emit(y * this.width + x, s[3], s[0], s[1], s[2]);
        }
      }
    }
  }
}

function requireSurfaceDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.canvasDimension ||
    height > LIMITS.canvasDimension ||
    width * height > LIMITS.canvasPixels
  ) {
    throw new RangeError(
      `surface dimensions must fit ${LIMITS.canvasDimension}px per axis and ${LIMITS.canvasPixels} total pixels`,
    );
  }
}

function requireTexture(
  image: PremultipliedImage,
  atlasRect?: readonly [number, number, number, number],
): void {
  const { width, height, data } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.textureDimension ||
    height > LIMITS.textureDimension ||
    width * height > LIMITS.texturePixels
  ) {
    throw new RangeError(
      `texture dimensions must fit ${LIMITS.textureDimension}px per axis and ${LIMITS.texturePixels} total pixels`,
    );
  }
  if (!(data instanceof Uint8Array)) {
    throw new RangeError(`premultiplied texture data must be a Uint8Array`);
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(
      `premultiplied texture data has ${data.length} bytes; expected ${width * height * 4}`,
    );
  }
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (data[i]! > alpha || data[i + 1]! > alpha || data[i + 2]! > alpha) {
      throw new RangeError(`premultiplied texture RGB channels must not exceed alpha`);
    }
  }
  if (atlasRect) {
    const [x, y, w, h] = atlasRect;
    if (
      !atlasRect.every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      w < 1 ||
      h < 1 ||
      x + w > width ||
      y + h > height
    ) {
      throw new RangeError(`atlas crop must be a positive integer rectangle inside the texture`);
    }
  }
}

function snapshotAtlasRect(
  width: number,
  height: number,
  atlasRect?: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  return atlasRect
    ? [atlasRect[0], atlasRect[1], atlasRect[2], atlasRect[3]]
    : [0, 0, width, height];
}

function orient2d(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/**
 * Top-left fill rule under +y-down, positive-area winding: a pixel exactly on
 * an edge counts as covered when the edge is a top edge (horizontal, pointing
 * +x, interior below) or a left edge (pointing −y / up, interior to its right).
 */
function covers(w: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (w > 0) return true;
  if (w < 0) return false;
  return ay === by ? bx > ax : by < ay;
}

const scratch: [number, number, number, number] = [0, 0, 0, 0];

/** Bilinear sample of premultiplied texels, clamped to the crop interior (§3.2). */
function sampleBilinear(
  texture: StoredTexture,
  u: number,
  v: number,
  alphaOnly: boolean,
): [number, number, number, number] {
  const [rx, ry, rw, rh] = texture.rect;
  const img = texture.image;
  // Index clamping makes every finite out-of-range coordinate sample the
  // nearest crop edge. Clamp first so u*rw cannot overflow before that rule
  // takes effect.
  const boundedU = u < 0 ? 0 : u > 1 ? 1 : u;
  const boundedV = v < 0 ? 0 : v > 1 ? 1 : v;
  // Texel centers at integer + 0.5; clamp indices to the rect interior.
  const tx = rx + boundedU * rw - 0.5;
  const ty = ry + boundedV * rh - 0.5;
  const x0f = Math.floor(tx);
  const y0f = Math.floor(ty);
  const fx = tx - x0f;
  const fy = ty - y0f;
  const lastX = rx + rw - 1;
  const lastY = ry + rh - 1;
  const x0 = clampInt(x0f, rx, lastX);
  const x1 = clampInt(x0f + 1, rx, lastX);
  const y0 = clampInt(y0f, ry, lastY);
  const y1 = clampInt(y0f + 1, ry, lastY);

  const d = img.data;
  const stride = img.width * 4;
  const o00 = y0 * stride + x0 * 4;
  const o10 = y0 * stride + x1 * 4;
  const o01 = y1 * stride + x0 * 4;
  const o11 = y1 * stride + x1 * 4;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;

  scratch[3] =
    (w00 * d[o00 + 3]! + w10 * d[o10 + 3]! + w01 * d[o01 + 3]! + w11 * d[o11 + 3]!) / 255;
  if (alphaOnly) {
    scratch[0] = 0;
    scratch[1] = 0;
    scratch[2] = 0;
  } else {
    scratch[0] = (w00 * d[o00]! + w10 * d[o10]! + w01 * d[o01]! + w11 * d[o11]!) / 255;
    scratch[1] =
      (w00 * d[o00 + 1]! + w10 * d[o10 + 1]! + w01 * d[o01 + 1]! + w11 * d[o11 + 1]!) / 255;
    scratch[2] =
      (w00 * d[o00 + 2]! + w10 * d[o10 + 2]! + w01 * d[o01 + 2]! + w11 * d[o11 + 2]!) / 255;
  }
  return scratch;
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createSoftRenderer(width: number, height: number): SoftRenderer {
  return new SoftRenderer(width, height);
}
