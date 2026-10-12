import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Buf } from "./tex.js";

/** Fixed encoder options so regeneration is byte-identical. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const png = new PNG({ width, height });
  Buffer.from(rgba).copy(png.data);
  return PNG.sync.write(png, { deflateLevel: 9, filterType: 0 });
}

export interface ModelSpec {
  id: string;
  canvas: { width: number; height: number; origin: [number, number] };
  capabilities?: string[];
  rig: unknown;
  physics?: unknown;
  variants?: unknown;
  atlas?: unknown;
  /** Expression/motion JSON docs keyed by id (paths derived). */
  expressions?: Record<string, unknown>;
  motions?: Record<string, unknown>;
  /** Straight-alpha texture buffers keyed by texture id. */
  textures: Record<string, Buf>;
  /** Extra raw files, path → bytes (e.g. a packed atlas image). */
  extraFiles?: Record<string, Buffer>;
  note?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Write an unpacked container directory (§3), replacing any previous copy. */
export function writeModel(parentDir: string, spec: ModelSpec): string {
  const dir = join(parentDir, `${spec.id}.lyre`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "textures"), { recursive: true });

  const files: Record<string, unknown> = { rig: "rig.json" };
  writeFileSync(join(dir, "rig.json"), json(spec.rig));
  if (spec.physics !== undefined) {
    files.physics = "physics.json";
    writeFileSync(join(dir, "physics.json"), json(spec.physics));
  }
  if (spec.variants !== undefined) {
    files.variants = "variants.json";
    writeFileSync(join(dir, "variants.json"), json(spec.variants));
  }
  if (spec.atlas !== undefined) {
    files.atlas = "atlas.json";
    writeFileSync(join(dir, "atlas.json"), json(spec.atlas));
  }
  if (spec.expressions && Object.keys(spec.expressions).length > 0) {
    mkdirSync(join(dir, "expressions"), { recursive: true });
    files.expressions = Object.keys(spec.expressions).map((id) => `expressions/${id}.exp.json`);
    for (const [id, doc] of Object.entries(spec.expressions)) {
      writeFileSync(join(dir, "expressions", `${id}.exp.json`), json(doc));
    }
  }
  if (spec.motions && Object.keys(spec.motions).length > 0) {
    mkdirSync(join(dir, "motions"), { recursive: true });
    files.motions = Object.keys(spec.motions).map((id) => `motions/${id}.motion.json`);
    for (const [id, doc] of Object.entries(spec.motions)) {
      writeFileSync(join(dir, "motions", `${id}.motion.json`), json(doc));
    }
  }

  const manifest = {
    lyre: "0.1",
    id: spec.id,
    canvas: spec.canvas,
    capabilities: spec.capabilities ?? ["core"],
    files,
    ...(spec.note ? { $note: spec.note } : {}),
  };
  writeFileSync(join(dir, "manifest.json"), json(manifest));

  for (const [id, b] of Object.entries(spec.textures)) {
    writeFileSync(join(dir, "textures", `${id}.png`), encodePng(b.w, b.h, b.data));
  }
  for (const [rel, bytes] of Object.entries(spec.extraFiles ?? {})) {
    writeFileSync(join(dir, rel), bytes);
  }
  return dir;
}

export function writeTimeline(dir: string, id: string, timeline: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.timeline.json`), json(timeline));
}
