// Renders the README preview of the Soraya example: its looping `idle`
// motion, rendered frame by frame with the CPU reference rasterizer, cropped
// to the character, box-downscaled in premultiplied space, and composited
// onto a page background.
//
// Output: docs/media/soraya-idle.mp4 (committed), one 16-second loop of the
// idle motion.
//
// The render is deterministic (fixed fps, fixed loop length, no randomness),
// and the MP4 is encoded as H.264 by a full ffmpeg build (libx264 and the
// rawvideo demuxer; Playwright's trimmed ffmpeg has neither).
//
//   pnpm --filter @refrain-lyre/gen preview:soraya [path/to/ffmpeg]

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "@refrain-lyre/core";
import { createSoftRenderer, type SoftRenderer } from "@refrain-lyre/render-soft";
import { loadContainerDir } from "@refrain-lyre/validate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const modelDir = join(root, "examples", "soraya.lyre");
const outDir = join(root, "docs", "media");

const LOOP_SECONDS = 16; // the idle motion's duration; the video is one loop
const VIDEO_FPS = 25;
const VIDEO_SCALE = 2; // 2048 → 1024 canvas pixels before cropping
const BBOX_SCALE = 4; // 2048 → 512 for the bounding-box pass
const BBOX_SAMPLES = 100; // frames sampled across the loop to find the crop
const PAD = 24; // canvas pixels (at scale 1) around the character's union bbox
const BACKGROUNDS = {
  light: [255, 255, 255],
  dark: [13, 17, 23],
} as const;
const VIDEO_BACKGROUND: keyof typeof BACKGROUNDS = "dark";

function findFfmpeg(explicit: string | undefined): string {
  const candidate = explicit ?? "ffmpeg";
  const probe = spawnSync(candidate, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(
      `cannot run ${candidate}; install ffmpeg or pass its path as the first argument`,
    );
  }
  if (!/\blibx264\b/.test(probe.stdout)) {
    // Playwright's bundled ffmpeg, for example, has neither H.264 nor a raw
    // video demuxer; a distribution ffmpeg does.
    throw new Error(`${candidate} lacks the libx264 encoder; use a full ffmpeg build`);
  }
  return candidate;
}

/** Box-downscale a premultiplied RGBA8 surface by an integer factor. */
function downscale(src: Uint8Array, width: number, height: number, scale: number): Uint8Array {
  const w = width / scale;
  const h = height / scale;
  const out = new Uint8Array(w * h * 4);
  const norm = 1 / (scale * scale);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < scale; dy++) {
        let i = ((y * scale + dy) * width + x * scale) * 4;
        for (let dx = 0; dx < scale; dx++, i += 4) {
          r += src[i]!;
          g += src[i + 1]!;
          b += src[i + 2]!;
          a += src[i + 3]!;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r * norm);
      out[o + 1] = Math.round(g * norm);
      out[o + 2] = Math.round(b * norm);
      out[o + 3] = Math.round(a * norm);
    }
  }
  return out;
}

/** Composite a premultiplied RGBA8 crop over a page color: out = src + bg·(1−a). */
function composite(
  frame: Uint8Array,
  stride: number,
  crop: readonly [number, number, number, number],
  bg: readonly [number, number, number],
  alpha: boolean,
): Buffer {
  const [x0, y0, w, h] = crop;
  const channels = alpha ? 4 : 3;
  const out = Buffer.alloc(w * h * channels);
  let o = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * stride + x) * 4;
      const inv = (255 - frame[i + 3]!) / 255;
      out[o++] = Math.round(frame[i]! + bg[0] * inv);
      out[o++] = Math.round(frame[i + 1]! + bg[1] * inv);
      out[o++] = Math.round(frame[i + 2]! + bg[2] * inv);
      if (alpha) out[o++] = 255;
    }
  }
  return out;
}

interface Scene {
  width: number;
  height: number;
  renderer: SoftRenderer;
  play(): ReturnType<typeof createRuntime>;
}

/** Canvas-space union bounding box of visible pixels across sampled frames. */
function findCrop(scene: Scene): [number, number, number, number] {
  const scale = BBOX_SCALE;
  const w = scene.width / scale;
  const h = scene.height / scale;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  const runtime = scene.play();
  for (let index = 0; index < BBOX_SAMPLES; index++) {
    scene.renderer.render(runtime.evaluate());
    const small = downscale(scene.renderer.readSurface(), scene.width, scene.height, scale);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (small[(y * w + x) * 4 + 3]! > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    runtime.update(LOOP_SECONDS / BBOX_SAMPLES);
  }
  if (maxX < 0) throw new Error("the model rendered no visible pixels");
  // Back to canvas pixels, padded, snapped to the coarsest scale so every
  // output size gets whole pixels and even dimensions.
  const snap = BBOX_SCALE * 2;
  const x0 = Math.max(0, Math.floor((minX * scale - PAD) / snap) * snap);
  const y0 = Math.max(0, Math.floor((minY * scale - PAD) / snap) * snap);
  const x1 = Math.min(scene.width, Math.ceil(((maxX + 1) * scale + PAD) / snap) * snap);
  const y1 = Math.min(scene.height, Math.ceil(((maxY + 1) * scale + PAD) / snap) * snap);
  return [x0, y0, x1 - x0, y1 - y0];
}

function scaledCrop(
  crop: readonly [number, number, number, number],
  scale: number,
): [number, number, number, number] {
  return [crop[0] / scale, crop[1] / scale, crop[2] / scale, crop[3] / scale];
}

async function writeVideo(
  scene: Scene,
  crop: readonly [number, number, number, number],
  ffmpeg: string,
): Promise<void> {
  const c = scaledCrop(crop, VIDEO_SCALE);
  const frameCount = VIDEO_FPS * LOOP_SECONDS;
  const outPath = join(outDir, "soraya-idle.mp4");
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${String(c[2])}x${String(c[3])}`,
      "-r",
      String(VIDEO_FPS),
      "-i",
      "pipe:0",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outPath,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const exit = once(child, "exit");
  // If ffmpeg rejects its arguments it closes stdin early; report its exit
  // code (its stderr is inherited) instead of dying on the resulting EPIPE.
  let pipeBroken = false;
  child.stdin.on("error", () => {
    pipeBroken = true;
  });
  const runtime = scene.play();
  for (let index = 0; index < frameCount && !pipeBroken; index++) {
    scene.renderer.render(runtime.evaluate());
    const small = downscale(scene.renderer.readSurface(), scene.width, scene.height, VIDEO_SCALE);
    const rgb = composite(
      small,
      scene.width / VIDEO_SCALE,
      c,
      BACKGROUNDS[VIDEO_BACKGROUND],
      false,
    );
    if (!child.stdin.write(rgb) && !pipeBroken) {
      await Promise.race([once(child.stdin, "drain"), exit]);
    }
    runtime.update(1 / VIDEO_FPS);
    if ((index + 1) % VIDEO_FPS === 0) {
      process.stdout.write(`encoded ${String(index + 1)}/${String(frameCount)} frames\n`);
    }
  }
  child.stdin.end();
  const [code] = (await exit) as [number | null];
  if (code !== 0 || pipeBroken) throw new Error(`ffmpeg exited with ${String(code)}`);
  process.stdout.write(
    `wrote ${outPath} (${String(c[2])}×${String(c[3])}, ${String(frameCount)} frames at ${String(VIDEO_FPS)} fps)\n`,
  );
}

async function main(): Promise<void> {
  const ffmpeg = findFfmpeg(process.argv[2]);
  const container = loadContainerDir(modelDir);
  try {
    const { width, height } = container.model.canvas;
    const renderer = createSoftRenderer(width, height);
    for (const [id, image] of container.textures) renderer.setTexture(id, image);
    const scene: Scene = {
      width,
      height,
      renderer,
      play() {
        const runtime = createRuntime(container.model);
        runtime.playMotion("idle");
        return runtime;
      },
    };
    mkdirSync(outDir, { recursive: true });
    const crop = findCrop(scene);
    process.stdout.write(`crop ${crop.join(",")} (canvas pixels)\n`);
    await writeVideo(scene, crop, ffmpeg);
  } finally {
    container.source.close();
  }
}

await main();
