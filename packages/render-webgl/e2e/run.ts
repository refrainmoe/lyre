// WebGL conformance harness (§12): bundles the browser entry with
// esbuild, launches headless Chromium (SwiftShader), replays every corpus
// timeline through @refrain-lyre/render-webgl in the page, and compares the captured
// surfaces against the committed CPU goldens at ±2/255 on ≥99.9% of pixels,
// plus the §12 connected-region guard for catastrophic channel errors.
// Focused float-precision probes and then m01 run first to validate the
// SwiftShader blending assumptions before anything else builds on them.

import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  CHANNEL_TOLERANCE,
  CATASTROPHIC_CHANNEL_TOLERANCE,
  CATASTROPHIC_REGION_PIXEL_LIMIT,
  TRACE_TOLERANCE,
  compareSurfaces,
  decodeSurfacePng,
  encodeSurfacePng,
  loadContainerDir,
  maxTraceDeviation,
  readTimeline,
} from "@refrain-lyre/validate";

// LYRE_E2E_DUMP=dir writes actual/golden/diff PNGs for failing captures.
const dumpDir = process.env.LYRE_E2E_DUMP;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const corpus = join(root, "conformance");
const filter = process.argv[2];

async function main(): Promise<number> {
  const bundle = await build({
    entryPoints: [join(here, "browser-entry.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
  });
  const script = bundle.outputFiles[0]!.text;

  const browser = await chromium.launch({
    headless: true,
    // SwiftShader software GL — deterministic, GPU-free (CI-safe).
    args: ["--use-angle=swiftshader", "--disable-gpu-compositing"],
  });
  const page = await browser.newPage();
  await page.setContent("<!doctype html><title>lyre webgl harness</title>");
  await page.addScriptTag({ content: script });

  const info = await page.evaluate(() => window.lyreWebglInfo());
  console.log(`WebGL2: ${info.renderer} / ${info.vendor}`);

  const probes = await page.evaluate(() => window.lyreRunPrecisionProbes());
  const sameBytes = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  const precisionFixtures = [
    {
      name: "9,998 low-intensity additive draws → multiply",
      result: probes.additiveMultiply,
      expected: [196, 0, 0, 0],
    },
    {
      name: "256-source 1/255-alpha mask union",
      result: probes.maskUnion,
      expected: [162, 162, 162, 162],
    },
    {
      name: "float32 conversion preserves the side above a half-pixel center",
      result: probes.halfPixelAbove,
      expected: [0, 0, 255, 255],
    },
    {
      name: "float32 conversion preserves the side below a half-pixel center",
      result: probes.halfPixelBelow,
      expected: [0, 255, 255, 255],
    },
    {
      name: "large finite UV clamps before crop multiplication",
      result: probes.largeUv,
      expected: [0, 255, 0, 255],
    },
    {
      name: "mutated texture source reuses stored dimensions",
      result: probes.mutableTextureReuse,
      expected: [255, 0, 0, 255],
    },
    {
      name: "initial atlas crop snapshots caller-owned tuple",
      result: probes.atlasRectInitialSnapshot,
      expected: [255, 0, 0, 255],
    },
    {
      name: "same-source atlas crop snapshots replacement tuple",
      result: probes.atlasRectReuseSnapshot,
      expected: [0, 255, 0, 255],
    },
    {
      name: "hostile WebGL2 pixel-transfer state",
      result: probes.hostilePixelTransfer,
      expected: [11, 22, 33, 255],
    },
    {
      name: "hostile sampler and multisample state during masked render",
      result: probes.hostileSamplerRender,
      expected: [255, 255, 255, 255],
    },
    {
      name: "hostile default-framebuffer state during present",
      result: probes.hostilePresent,
      expected: [255, 255, 255, 255],
    },
    {
      name: "disposed renderer rejects use before mutating shared state",
      result: probes.disposedStatePreservation,
      expected: [64, 128, 192, 255],
    },
  ];
  for (const fixture of precisionFixtures) {
    if (!sameBytes(fixture.result.cpu, fixture.expected)) {
      await browser.close();
      throw new Error(
        `${fixture.name} probe fixture changed: CPU ${JSON.stringify(fixture.result.cpu)}, expected ${JSON.stringify(fixture.expected)}`,
      );
    }
    if (!sameBytes(fixture.result.webgl, fixture.result.cpu)) {
      console.log(
        `FAIL ${fixture.name}: WebGL ${JSON.stringify(fixture.result.webgl)}, CPU ${JSON.stringify(fixture.result.cpu)}`,
      );
      await browser.close();
      return 1;
    }
    console.log(`PASS ${fixture.name} (${JSON.stringify(fixture.result.webgl)})`);
  }
  if (
    !probes.guardChecks.transformFeedback ||
    !probes.guardChecks.activeQueries ||
    probes.guardChecks.timerQuery === false ||
    !probes.guardChecks.disposed ||
    !probes.guardChecks.contextLoss ||
    !probes.guardChecks.sharedState
  ) {
    await browser.close();
    throw new Error("shared-context guard probe did not complete");
  }
  console.log("PASS active transform-feedback preflight preserves host state");
  console.log("PASS active host-query preflight preserves host query state");
  console.log(
    probes.guardChecks.timerQuery
      ? "PASS active EXT_disjoint_timer_query_webgl2 query preflight preserves host state"
      : "SKIP EXT_disjoint_timer_query_webgl2 unavailable",
  );
  console.log("PASS disposed renderer lifecycle guards are idempotent and fail-fast");
  console.log("PASS lost WebGL contexts fail explicitly across the public API");
  console.log("PASS public WebGL operations restore caller-owned shared-context state");

  const timelines = readdirSync(join(corpus, "timelines"))
    .filter((f) => f.endsWith(".timeline.json"))
    .filter((f) => !filter || f.includes(filter))
    .sort(); // lexicographic → m01 first (R16)

  let failures = 0;
  for (const file of timelines) {
    const id = basename(file, ".timeline.json");
    const path = join(corpus, "timelines", file);
    const { timeline, modelDir } = readTimeline(path);
    const container = loadContainerDir(modelDir);

    const textures = [];
    for (const [texId, img] of container.textures) {
      const atlasRect = timeline.use_atlas ? container.model.atlas?.rects.get(texId) : undefined;
      const image = atlasRect && container.atlasImage ? container.atlasImage : img;
      textures.push({
        id: texId,
        width: image.width,
        height: image.height,
        data: Buffer.from(image.data).toString("base64"),
        ...(atlasRect ? { atlasRect: [...atlasRect] } : {}),
      });
    }

    const result = await page.evaluate(
      ({ raw, textures, timeline }) =>
        window.lyreRunTimeline({
          raw,
          textures,
          timeline,
        } as Parameters<typeof window.lyreRunTimeline>[0]),
      { raw: container.raw as never, textures, timeline },
    );

    const issues: string[] = [];
    for (const [stepStr, b64] of Object.entries(result.captures)) {
      const goldenPath = join(corpus, "goldens", id, `${stepStr}.png`);
      if (!existsSync(goldenPath)) {
        issues.push(`missing golden ${id}/${stepStr}.png`);
        continue;
      }
      const golden = decodeSurfacePng(readFileSync(goldenPath));
      const actual = new Uint8Array(Buffer.from(b64, "base64"));
      const cmp = compareSurfaces(golden.data, actual, golden.width);
      if (!cmp.pass) {
        issues.push(
          `capture ${stepStr}: ${cmp.outOfTolerancePixels}/${cmp.totalPixels} px out of ±${CHANNEL_TOLERANCE}/255; ${cmp.catastrophicPixels} px exceed ±${CATASTROPHIC_CHANNEL_TOLERANCE}/255, largest 8-connected region ${cmp.largestCatastrophicRegion}/${CATASTROPHIC_REGION_PIXEL_LIMIT} px (max diff ${cmp.maxChannelDiff})`,
        );
        if (dumpDir) {
          mkdirSync(dumpDir, { recursive: true });
          const diff = new Uint8Array(golden.data.length);
          for (let i = 0; i < diff.length; i += 4) {
            let d = 0;
            for (let c = 0; c < 4; c++)
              d = Math.max(d, Math.abs(golden.data[i + c]! - actual[i + c]!));
            const v = d > CHANNEL_TOLERANCE ? Math.min(255, d * 8) : 0;
            diff[i] = v;
            diff[i + 3] = v > 0 ? 255 : 0;
          }
          writeFileSync(
            join(dumpDir, `${id}-${stepStr}-actual.png`),
            encodeSurfacePng(golden.width, golden.height, actual),
          );
          writeFileSync(
            join(dumpDir, `${id}-${stepStr}-golden.png`),
            encodeSurfacePng(golden.width, golden.height, golden.data),
          );
          writeFileSync(
            join(dumpDir, `${id}-${stepStr}-diff.png`),
            encodeSurfacePng(golden.width, golden.height, diff),
          );
        }
      }
    }
    if (result.trace) {
      const goldenTracePath = join(corpus, "goldens", id, "trace.json");
      if (existsSync(goldenTracePath)) {
        const golden = JSON.parse(readFileSync(goldenTracePath, "utf8")) as {
          chains: Record<string, number[][]>;
        };
        const dev = maxTraceDeviation(golden.chains, result.trace);
        if (dev > TRACE_TOLERANCE) {
          issues.push(`browser physics trace deviates ${dev.toFixed(6)}° (> ±${TRACE_TOLERANCE}°)`);
        }
      }
    }

    if (issues.length > 0) {
      failures++;
      console.log(`FAIL ${id}`);
      for (const issue of issues) console.log(`     ${issue}`);
      if (id.startsWith("m01")) {
        // R16: if SwiftShader blending itself is off, everything else is noise.
        console.log("m01 failed — aborting: SwiftShader blending assumption does not hold");
        break;
      }
    } else {
      console.log(`PASS ${id} (${Object.keys(result.captures).length} captures)`);
    }
  }

  await browser.close();
  console.log(
    failures === 0
      ? `webgl conformance: all ${timelines.length} timeline(s) passed`
      : `webgl conformance: ${failures}/${timelines.length} timeline(s) FAILED`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(await main());
