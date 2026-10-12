// Structured-cloneable CPU-renderer protocol shared by the page and worker.
// Keep this module side-effect free: importing protocol helpers in the page
// must never install worker globals on `window`.

import type { EvalFrame, ReadonlyFloat64Array, ReadonlyUint32Array } from "@refrain-lyre/core";

export interface WorkerTexture {
  id: string;
  width: number;
  height: number;
  data: Uint8Array;
  atlasRect?: [number, number, number, number];
}

export interface InitMessage {
  type: "init";
  width: number;
  height: number;
  textures: WorkerTexture[];
}

/** EvalFrame geometry stripped of sprite-node references. */
export interface PlainGeometry {
  /** Minimal diagnostic identity required by renderer preflight checks. */
  sprite: { id: string };
  texture: string;
  positions: ReadonlyFloat64Array;
  uvs: ReadonlyFloat64Array;
  indices: ReadonlyUint32Array;
}

export interface PlainDrawItem extends PlainGeometry {
  opacity: number;
  blend: "normal" | "additive" | "multiply";
  mask: { mode: "alpha" | "inverted"; group: number } | null;
}

export interface RenderMessage {
  type: "render";
  requestId: number;
  drawList: PlainDrawItem[];
  maskGroups: { sources: PlainGeometry[] }[];
}

export type WorkerRequest = InitMessage | RenderMessage;

export interface WorkerReadyMessage {
  type: "ready";
}

export interface WorkerSurfaceMessage {
  type: "surface";
  requestId: number;
  surface: Uint8Array;
}

export interface WorkerErrorMessage {
  type: "error";
  /** Present when a particular render request failed; absent for initialization. */
  requestId?: number;
  message: string;
}

export type WorkerResponse = WorkerReadyMessage | WorkerSurfaceMessage | WorkerErrorMessage;

export function stripFrame(frame: EvalFrame): Pick<RenderMessage, "drawList" | "maskGroups"> {
  const geom = (g: {
    sprite: { id: string };
    texture: string;
    positions: ReadonlyFloat64Array;
    uvs: ReadonlyFloat64Array;
    indices: ReadonlyUint32Array;
  }): PlainGeometry => ({
    sprite: { id: g.sprite.id },
    texture: g.texture,
    positions: g.positions,
    uvs: g.uvs,
    indices: g.indices,
  });
  return {
    drawList: frame.drawList.map((d) => ({
      ...geom(d),
      opacity: d.opacity,
      blend: d.blend,
      mask: d.mask ? { mode: d.mask.mode, group: d.mask.group } : null,
    })),
    maskGroups: frame.maskGroups.map((g) => ({ sources: g.sources.map(geom) })),
  };
}
