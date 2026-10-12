// Corpus generator entry point: writes the conformance models (m01–m16) to
// conformance/models/ and their scripted timelines to conformance/timelines/.
// Everything is deterministic — rerunning produces byte-identical output.
// Goldens are generated separately via
// `lyre-validate conformance conformance --regen`.

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "@refrain-lyre/core";
import { createSoftRenderer } from "@refrain-lyre/render-soft";
import { loadContainerDir, runTimeline } from "@refrain-lyre/validate";
import { ALL_MODELS, m16_atlasImage, type GenOut } from "./models.js";
import { encodePng, writeModel, writeTimeline } from "./write.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const modelsDir = join(root, "conformance", "models");
const timelinesDir = join(root, "conformance", "timelines");

// Clear derived directories so renamed/removed corpus entries don't linger.
rmSync(modelsDir, { recursive: true, force: true });
rmSync(timelinesDir, { recursive: true, force: true });
mkdirSync(modelsDir, { recursive: true });
mkdirSync(timelinesDir, { recursive: true });

function emit(out: GenOut, parentDir: string, modelRelPath: string): string {
  const dir = writeModel(parentDir, out.spec);
  for (const [id, timeline] of Object.entries(out.timelines)) {
    writeTimeline(timelinesDir, id, { model: modelRelPath, ...timeline });
  }
  return dir;
}

/** A model whose rest pose rasterizes to nothing is almost certainly broken. */
function checkRestPoseVisible(dir: string): void {
  const { model, textures } = loadContainerDir(dir);
  const rt = createRuntime(model);
  const renderer = createSoftRenderer(model.canvas.width, model.canvas.height);
  for (const [id, img] of textures) renderer.setTexture(id, img);
  renderer.render(rt.evaluate());
  const surface = renderer.readSurface();
  for (let o = 3; o < surface.length; o += 4) {
    if (surface[o]! > 0) return;
  }
  throw new Error(`${dir}: rest pose renders fully transparent`);
}

const written: string[] = [];
for (const gen of ALL_MODELS) {
  const out = gen();
  if (out.spec.id === "m16_atlas") {
    const atlas = m16_atlasImage();
    out.spec.extraFiles = { "atlas.png": encodePng(atlas.w, atlas.h, atlas.data) };
  }
  const dir = emit(out, modelsDir, `../models/${out.spec.id}.lyre`);
  checkRestPoseVisible(dir);
  written.push(out.spec.id);
}

// Self-check (§3.2): rendering through the atlas must be indistinguishable
// from per-file textures — in the soft renderer they are byte-identical.
{
  const files = runTimeline(join(timelinesDir, "m16_files.timeline.json"));
  const atlas = runTimeline(join(timelinesDir, "m16_atlas.timeline.json"));
  for (const [step, surface] of files.captures) {
    const other = atlas.captures.get(step);
    if (!other || Buffer.compare(Buffer.from(surface), Buffer.from(other)) !== 0) {
      throw new Error(`m16: atlas capture at step ${step} differs from per-file capture`);
    }
  }
}

// Self-check (§9): the m14 physics scenario must actually move — a constant
// trace would make the cross-implementation comparison vacuous.
{
  const result = runTimeline(join(timelinesDir, "m14_physics.timeline.json"));
  const moves = Object.values(result.trace ?? {}).some((steps) =>
    steps.some((angles) => angles.some((a) => Math.abs(a) > 0.5)),
  );
  if (!moves) throw new Error("m14: physics trace never leaves rest — scenario is vacuous");
}

// Self-check (§10.3 rule 5): m15's golden must be skip-agnostic — only ch_main is
// traced (ch_cape feeds an excluded subtree, so runtimes may skip it).
{
  const result = runTimeline(join(timelinesDir, "m15_physics_variant_skip.timeline.json"));
  const traced = Object.keys(result.trace ?? {});
  if (traced.length !== 1 || traced[0] !== "ch_main") {
    throw new Error(`m15: expected only ch_main in trace, got [${traced.join(", ")}]`);
  }
  const mainTrace = result.trace?.ch_main;
  if (!mainTrace || mainTrace.length !== 600) {
    throw new Error(
      `m15: 30 fps outer script must preserve 600 internal 60 fps samples, got ${mainTrace?.length ?? 0}`,
    );
  }
}

process.stdout.write(`generated ${written.length} models: ${written.join(", ")}\n`);
