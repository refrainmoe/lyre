import type {
  BlendMode,
  MaskMode,
  ReadonlyFloat64Array,
  ReadonlyUint32Array,
  SpriteNode,
} from "./model.js";

/** Deformed sprite geometry in canvas space (+y down, origin at canvas top-left). */
export interface DeformedGeometry {
  readonly sprite: SpriteNode;
  /** Texture id (per-file lookup, or atlas rect key). */
  readonly texture: string;
  /** xy pairs, canvas pixels. */
  readonly positions: ReadonlyFloat64Array;
  /** Normalized texture coordinates over the sprite's crop, xy pairs. */
  readonly uvs: ReadonlyFloat64Array;
  readonly indices: ReadonlyUint32Array;
}

/** One distinct set of mask sources; consumers combine per §8.4. */
export interface MaskGroup {
  /**
   * Deformed geometry of each active source. Mask value at a pixel is the
   * coverage union 1 − ∏(1 − aᵢ) over raw texture alpha — source opacity
   * never contributes (§8.4).
   */
  readonly sources: ReadonlyArray<DeformedGeometry>;
}

export interface DrawItem extends DeformedGeometry {
  /** Effective opacity: node value (clamped once, §7) × ancestor product (§8.1.5). */
  readonly opacity: number;
  readonly blend: BlendMode;
  /** Effective z after single rounding, with half-ties toward +∞ (§8.1.6). */
  readonly effectiveZ: number;
  readonly mask: { readonly mode: MaskMode; readonly group: number } | null;
}

/**
 * Output of §8.1 steps 1–6; a renderer performs step 7. Frames and their
 * nested geometry buffers are borrowed, read-only views. A caller that needs
 * mutable or longer-lived storage must copy it rather than mutate the frame.
 */
export interface EvalFrame {
  readonly canvas: { readonly width: number; readonly height: number };
  /** Sprites in final draw order (back to front). */
  readonly drawList: ReadonlyArray<DrawItem>;
  readonly maskGroups: ReadonlyArray<MaskGroup>;
}

export interface PremultipliedImage {
  width: number;
  height: number;
  /** RGBA8, premultiplied alpha, row-major, +y down. */
  data: Uint8Array;
}

/**
 * Contract shared by @refrain-lyre/render-soft and @refrain-lyre/render-webgl: rasterize an
 * EvalFrame into the canonical extended-premultiplied model surface (§8.3).
 */
export interface SurfaceRenderer {
  setTexture(
    id: string,
    image: PremultipliedImage,
    atlasRect?: readonly [number, number, number, number],
  ): void;
  render(frame: EvalFrame): void;
  /**
   * Clamped RGBA8 premultiplied dump for §12 conformance/debugging. This is
   * not the extended host handoff; concrete backends expose their float
   * surface/texture separately so emissive RGB above 1 or at alpha 0 survives.
   */
  readSurface(): Uint8Array;
}
