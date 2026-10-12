import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@refrain-lyre/core";
import {
  ADMISSION_PERTURBATION,
  CATASTROPHIC_CHANNEL_TOLERANCE,
  CATASTROPHIC_REGION_PIXEL_LIMIT,
  compareSurfaces,
  decodeSurfacePng,
  encodeSurfacePng,
  maxTraceDeviation,
  runAdmissionPerturbation,
  runConformance,
} from "../src/conformance.js";
import { loadContainerDir } from "../src/container.js";
import { runTimelineSteps } from "../src/steps.js";
import { CONFORMANCE_TIMELINE_LIMITS, readTimeline } from "../src/timeline.js";
import { baseDocs, tempDir, writeFixture } from "./helpers.js";

interface MutableBuiltinFs {
  readdirSync: typeof import("node:fs").readdirSync;
  rmSync: typeof import("node:fs").rmSync;
  writeFileSync: typeof import("node:fs").writeFileSync;
  renameSync: typeof import("node:fs").renameSync;
  unlinkSync: typeof import("node:fs").unlinkSync;
}

const mutableBuiltinFs = createRequire(import.meta.url)("node:fs") as MutableBuiltinFs;

function physicsModel(fps = 2): string {
  const docs = baseDocs();
  docs.manifest.capabilities = ["core", "physics"];
  docs.rig.nodes = [{ id: "root", type: "group", children: [] }];
  docs.textures = {};
  docs.physics = {
    fps,
    chains: [
      {
        id: "hair",
        inputs: [],
        links: [{ length: 1, damping: 0, stiffness: 0 }],
        outputs: [],
      },
    ],
  };
  return writeFixture(docs);
}

function variantPhysicsModel(): string {
  const docs = baseDocs();
  docs.manifest.capabilities = ["core", "physics", "variants"];
  docs.rig.params = [
    { id: "main_out", min: -90, max: 90, default: 0 },
    { id: "cape_out", min: -90, max: 90, default: 0 },
  ];
  docs.rig.nodes = [
    {
      id: "root",
      type: "group",
      children: [{ id: "cape_group", type: "group", children: [] }],
    },
  ];
  docs.rig.bindings = [
    {
      target: "root",
      property: "opacity",
      params: ["main_out"],
      axes: [[-90, 90]],
      values: [0, 1],
    },
    {
      target: "cape_group",
      property: "opacity",
      params: ["cape_out"],
      axes: [[-90, 90]],
      values: [0, 1],
    },
  ];
  docs.textures = {};
  docs.physics = {
    fps: 1,
    chains: [
      {
        id: "main",
        inputs: [],
        links: [{ length: 1, damping: 0, stiffness: 0 }],
        outputs: [{ link: 0, param: "main_out", multiplier: 1, blend: "overwrite" }],
      },
      {
        id: "cape",
        inputs: [],
        links: [{ length: 1, damping: 0, stiffness: 0 }],
        outputs: [{ link: 0, param: "cape_out", multiplier: 1, blend: "overwrite" }],
      },
    ],
  };
  docs.variants = {
    slots: [
      {
        id: "cape",
        default: "none",
        options: [
          { id: "none", nodes: [] },
          { id: "on", nodes: ["cape_group"] },
        ],
      },
    ],
  };
  return writeFixture(docs);
}

function writeTimeline(corpusDir: string, id: string, timeline: Record<string, unknown>): string {
  mkdirSync(join(corpusDir, "timelines"), { recursive: true });
  const path = join(corpusDir, "timelines", `${id}.timeline.json`);
  writeFileSync(path, JSON.stringify(timeline));
  return path;
}

describe("conformance surface PNGs", () => {
  it("round-trips already-premultiplied bytes without premultiplying again", () => {
    const surface = Uint8Array.of(100, 25, 0, 128);
    expect(decodeSurfacePng(encodeSurfacePng(1, 1, surface))).toEqual({
      width: 1,
      height: 1,
      data: surface,
    });
  });

  it("rejects dimensions and byte lengths outside the surface limits", () => {
    expect(() => encodeSurfacePng(1, 1, new Uint8Array(3))).toThrow(/expected 4/);
    expect(() => encodeSurfacePng(4096, 4096, new Uint8Array())).toThrow(/total pixels/);

    const forgedHeader = Buffer.from(encodeSurfacePng(1, 1, new Uint8Array(4)));
    forgedHeader.writeUInt32BE(4096, 16);
    forgedHeader.writeUInt32BE(4096, 20);
    expect(() => decodeSurfacePng(forgedHeader)).toThrow(/total pixels/);
  });
});

describe("compareSurfaces", () => {
  it("enforces the aggregate ±2/255 pixel-ratio guard", () => {
    const expected = new Uint8Array(1_000 * 4);
    const actual = new Uint8Array(expected);
    actual[0] = 3;
    actual[4] = 3;

    const comparison = compareSurfaces(expected, actual, 1_000);
    expect(comparison.pass).toBe(false);
    expect(comparison.outOfTolerancePixels).toBe(2);
    expect(comparison.catastrophicPixels).toBe(0);
  });

  it("rejects a connected catastrophic region that the aggregate allowance permits", () => {
    const width = 100;
    const expected = new Uint8Array(width * width * 4);
    const tolerableOutlier = new Uint8Array(expected);
    tolerableOutlier[0] = CATASTROPHIC_CHANNEL_TOLERANCE;
    expect(compareSurfaces(expected, tolerableOutlier, width).pass).toBe(true);

    const isolatedRasterOutlier = new Uint8Array(expected);
    isolatedRasterOutlier[0] = CATASTROPHIC_CHANNEL_TOLERANCE + 1;
    const isolated = compareSurfaces(expected, isolatedRasterOutlier, width);
    expect(isolated.pass).toBe(true);
    expect(isolated.largestCatastrophicRegion).toBe(1);

    const catastrophic = new Uint8Array(expected);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        catastrophic[(y * width + x) * 4] = CATASTROPHIC_CHANNEL_TOLERANCE + 1;
      }
    }
    const comparison = compareSurfaces(expected, catastrophic, width);
    expect(comparison.pass).toBe(false);
    expect(comparison.outOfTolerancePixels).toBe(9);
    expect(comparison.catastrophicPixels).toBe(9);
    expect(comparison.largestCatastrophicRegion).toBe(CATASTROPHIC_REGION_PIXEL_LIMIT + 1);
  });
});

describe("maxTraceDeviation", () => {
  it("returns the maximum finite deviation for identical trace shapes", () => {
    expect(
      maxTraceDeviation(
        {
          hair: [
            [0, 1],
            [2, 3],
          ],
        },
        {
          hair: [
            [0, 1.25],
            [2, 3],
          ],
        },
      ),
    ).toBe(0.25);
  });

  it("rejects missing or extra chains and mismatched trace dimensions", () => {
    const trace = {
      hair: [
        [0, 1],
        [2, 3],
      ],
    };
    expect(maxTraceDeviation(trace, {})).toBe(Infinity);
    expect(maxTraceDeviation(trace, { ...trace, extra: [[0]] })).toBe(Infinity);
    expect(maxTraceDeviation(trace, { hair: [[0, 1]] })).toBe(Infinity);
    expect(maxTraceDeviation(trace, { hair: [[0], [2, 3]] })).toBe(Infinity);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite trace samples (%s)",
    (nonFinite) => {
      expect(maxTraceDeviation({ hair: [[nonFinite]] }, { hair: [[0]] })).toBe(Infinity);
      expect(maxTraceDeviation({ hair: [[0]] }, { hair: [[nonFinite]] })).toBe(Infinity);
    },
  );
});

describe("bounded timeline parsing", () => {
  it("rejects duplicate JSON members and timeline symlinks", () => {
    const corpusDir = tempDir();
    const timelines = join(corpusDir, "timelines");
    mkdirSync(timelines);
    const duplicate = join(timelines, "duplicate.timeline.json");
    writeFileSync(duplicate, '{"model":"a","fps":60,"fps":1,"steps":1,"captures":[]}\n');
    expect(() => readTimeline(duplicate)).toThrow(/duplicate JSON object member "fps"/);

    const external = join(tempDir(), "outside.timeline.json");
    writeFileSync(external, '{"model":"a","fps":1,"steps":1,"captures":[]}\n');
    const linked = join(timelines, "linked.timeline.json");
    symlinkSync(external, linked);
    expect(() => readTimeline(linked)).toThrow(/ELOOP|symbolic link/i);
  });

  it("counts retained captures as one RGBA surface per capture", () => {
    const docs = baseDocs();
    docs.manifest.canvas.height = 2048;
    const modelDir = writeFixture(docs);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "tall", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [0],
    });

    // 32 * 2048 * 4 is comfortably below the retained-byte limit. A second
    // accidental height factor would incorrectly reject this fixture.
    expect(32 * 2048 * 4).toBeLessThan(CONFORMANCE_TIMELINE_LIMITS.retainedCaptureBytes);
    const report = runConformance(corpusDir, { regen: true });
    expect(report.issues).toEqual([]);
    expect(existsSync(join(corpusDir, "goldens", "tall", "0.png"))).toBe(true);
  });

  it("rejects a huge-step typo before trying to load or run its model", () => {
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "huge", {
      model: "/deliberately/missing/model.lyre",
      fps: 60,
      steps: CONFORMANCE_TIMELINE_LIMITS.steps + 1,
      captures: [],
    });

    const report = runConformance(corpusDir);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain(
      `steps must be an integer in [1, ${CONFORMANCE_TIMELINE_LIMITS.steps}]`,
    );
    expect(report.issues[0]!.message).not.toContain("missing");
  });

  it.each([
    {
      name: "non-positive fps",
      patch: { fps: 0 },
      message: "fps must be positive",
    },
    {
      name: "non-array events",
      patch: { events: {} },
      message: "events must be an array",
    },
    {
      name: "out-of-range capture",
      patch: { captures: [1] },
      message: "captures[0] must be an integer in [0, 1)",
    },
    {
      name: "duplicate captures",
      patch: { captures: [0, 0] },
      message: "captures must not contain duplicate",
    },
    {
      name: "multiple event actions",
      patch: { events: [{ step: 0, set: { p: 0 }, clear: ["p"] }] },
      message: "must contain exactly one of set, clear, expression, motion, or variant",
    },
    {
      name: "ambiguous expression action",
      patch: {
        events: [{ step: 0, expression: { id: "smile", action: "activate", weight: 0.5 } }],
      },
      message: "expression must contain exactly one of weight or action",
    },
    {
      name: "ambiguous motion stop weight",
      patch: { events: [{ step: 0, motion: { id: "idle", action: "stop", weight: 1 } }] },
      message: "stop action must not contain weight",
    },
  ])("rejects $name", ({ patch, message }) => {
    const corpusDir = tempDir();
    const path = writeTimeline(corpusDir, "invalid", {
      model: "../models/fixture.lyre",
      fps: 1,
      steps: 1,
      captures: [],
      ...patch,
    });
    expect(() => readTimeline(path)).toThrow(message);
  });

  it("contains a malformed timeline failure and continues with the rest of the corpus", () => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "a_bad", {
      model: modelDir,
      fps: 1,
      steps: 1,
      events: [{ step: 1, set: { p: 0 } }],
      captures: [],
    });
    writeTimeline(corpusDir, "b_good", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });

    const report = runConformance(corpusDir, { regen: true });
    expect(report.ran).toEqual(["a_bad", "b_good"]);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.timeline).toBe("a_bad");
    expect(existsSync(join(corpusDir, "goldens", "a_bad"))).toBe(false);
    expect(existsSync(join(corpusDir, "goldens", "b_good"))).toBe(true);
  });
});

describe("runConformance physics traces", () => {
  it("admits the same perturbed trace without rendering or retaining captures", () => {
    const modelDir = physicsModel(2);
    const container = loadContainerDir(modelDir);
    let renderCount = 0;
    let readCount = 0;
    const renderer = {
      setTexture: () => {},
      render: () => {
        renderCount++;
      },
      readSurface: () => {
        readCount++;
        return new Uint8Array(32 * 32 * 4);
      },
    };
    const timeline = {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [0, 9],
      physics_trace: true,
    };

    try {
      const full = runTimelineSteps(container.model, renderer, timeline, {
        perturb: ADMISSION_PERTURBATION,
      });
      expect(renderCount).toBe(2);
      expect(readCount).toBe(2);
      expect([...full.captures.keys()]).toEqual([0, 9]);

      renderCount = 0;
      readCount = 0;
      const admitted = runAdmissionPerturbation(container.model, timeline, renderer);
      expect(renderCount).toBe(0);
      expect(readCount).toBe(0);
      expect(admitted.captures.size).toBe(0);
      expect(admitted.trace).toEqual(full.trace);
      expect(admitted.zeroVectorCount).toBe(full.zeroVectorCount);
    } finally {
      container.source.close();
    }
  });

  it("records every internal solver step when timeline and physics rates differ", () => {
    const modelDir = physicsModel(2);
    const container = loadContainerDir(modelDir);
    try {
      const result = runTimelineSteps(
        container.model,
        {
          setTexture: () => {},
          render: () => {},
          readSurface: () => new Uint8Array(32 * 32 * 4),
        },
        {
          model: modelDir,
          fps: 1,
          steps: 10,
          captures: [],
          physics_trace: true,
        },
      );
      expect(result.trace?.hair).toHaveLength(20);
    } finally {
      container.source.close();
    }
  });

  it("does not lose the final solver boundary at a non-integral outer cadence", () => {
    const modelDir = physicsModel(60);
    const container = loadContainerDir(modelDir);
    try {
      const result = runTimelineSteps(
        container.model,
        {
          setTexture: () => {},
          render: () => {},
          readSurface: () => new Uint8Array(32 * 32 * 4),
        },
        {
          model: modelDir,
          fps: 29.9,
          steps: 299,
          captures: [],
          physics_trace: true,
        },
      );
      expect(299 / 29.9).toBe(10);
      expect(result.trace?.hair).toHaveLength(600);
    } finally {
      container.source.close();
    }
  });

  it("does not round a genuinely incomplete near-boundary physics step up", () => {
    const nearBoundaryFps = 0.99999999995;
    const modelDir = physicsModel(nearBoundaryFps);
    const container = loadContainerDir(modelDir);
    try {
      const result = runTimelineSteps(
        container.model,
        {
          setTexture: () => {},
          render: () => {},
          readSurface: () => new Uint8Array(32 * 32 * 4),
        },
        {
          model: modelDir,
          fps: 1,
          steps: 10,
          captures: [],
          physics_trace: true,
        },
      );
      expect(result.trace?.hair).toHaveLength(Math.floor(10 * nearBoundaryFps));
      expect(result.trace?.hair).toHaveLength(9);
    } finally {
      container.source.close();
    }
  });

  it("rejects an excessive baseline-plus-perturbation trace before allocating it", () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "physics"];
    docs.rig.nodes = [{ id: "root", type: "group", children: [] }];
    docs.textures = {};
    docs.physics = {
      fps: 240,
      chains: Array.from({ length: 28 }, (_, chain) => ({
        id: `chain_${chain}`,
        inputs: [],
        links: Array.from({ length: 64 }, () => ({ length: 1, damping: 0, stiffness: 0 })),
        outputs: [],
      })),
    };
    const modelDir = writeFixture(docs);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "large-trace", {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [],
      physics_trace: true,
    });

    const report = runConformance(corpusDir, { regen: true });
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.message).toContain("baseline and perturbation traces would retain");
    expect(report.issues[0]!.message).toContain(
      String(CONFORMANCE_TIMELINE_LIMITS.retainedTraceScalars),
    );
    expect(existsSync(join(corpusDir, "goldens", "large-trace"))).toBe(false);
  });

  it("uses the same near-boundary count when admitting and writing a golden trace", () => {
    const nearBoundaryFps = 0.99999999995;
    const modelDir = physicsModel(nearBoundaryFps);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "near-boundary", {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [],
      physics_trace: true,
    });

    expect(runConformance(corpusDir, { regen: true }).issues).toEqual([]);
    const golden = JSON.parse(
      readFileSync(join(corpusDir, "goldens", "near-boundary", "trace.json"), "utf8"),
    ) as { chains: { hair: number[][] } };
    expect(golden.chains.hair).toHaveLength(9);
  });

  it("refuses to generate a physics trace shorter than 10 simulated seconds", () => {
    const modelDir = physicsModel(2);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "short", {
      model: modelDir,
      fps: 2,
      steps: 19,
      captures: [],
      physics_trace: true,
    });

    const report = runConformance(corpusDir, { regen: true });
    expect(report.issues.some((issue) => issue.message.includes("exactly 10"))).toBe(true);
    expect(existsSync(join(corpusDir, "goldens", "short"))).toBe(false);
  });

  it("stores and validates the model physics rate for internal-step traces", () => {
    const modelDir = physicsModel(2);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "fps", {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [],
      physics_trace: true,
    });

    expect(runConformance(corpusDir, { regen: true }).issues).toEqual([]);
    const tracePath = join(corpusDir, "goldens", "fps", "trace.json");
    const golden = JSON.parse(readFileSync(tracePath, "utf8")) as {
      fps: number;
      chains: Record<string, number[][]>;
    };
    expect(golden.fps).toBe(2);
    expect(golden.chains.hair).toHaveLength(20);
    golden.fps = 1;
    writeFileSync(tracePath, JSON.stringify(golden));

    const report = runConformance(corpusDir);
    expect(report.issues.some((issue) => issue.message.includes("model physics fps 2"))).toBe(true);
  });

  it.each([
    { traceChains: [], message: "at least one" },
    { traceChains: ["missing"], message: "unknown physics chain" },
    { traceChains: ["hair", "hair"], message: "duplicate" },
  ])("rejects invalid selective trace lists ($message)", ({ traceChains, message }) => {
    const modelDir = physicsModel(1);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "selection", {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [],
      physics_trace: true,
      trace_chains: traceChains,
    });

    const report = runConformance(corpusDir, { regen: true });
    expect(report.issues.some((issue) => issue.message.includes(message))).toBe(true);
    expect(existsSync(join(corpusDir, "goldens", "selection"))).toBe(false);
  });

  it("allows omission only while all of the chain's consumers stay excluded", () => {
    const modelDir = variantPhysicsModel();
    const acceptedCorpus = tempDir();
    writeTimeline(acceptedCorpus, "excluded", {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [],
      physics_trace: true,
      trace_chains: ["main"],
    });
    expect(runConformance(acceptedCorpus, { regen: true }).issues).toEqual([]);
    const trace = JSON.parse(
      readFileSync(join(acceptedCorpus, "goldens", "excluded", "trace.json"), "utf8"),
    ) as { chains: Record<string, number[][]> };
    expect(Object.keys(trace.chains)).toEqual(["main"]);

    const exposedCorpus = tempDir();
    writeTimeline(exposedCorpus, "exposed", {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [],
      physics_trace: true,
      trace_chains: ["main"],
      events: [{ step: 5, variant: { slot: "cape", option: "on" } }],
    });
    const report = runConformance(exposedCorpus, { regen: true });
    expect(
      report.issues.some(
        (issue) =>
          issue.message.includes('non-skippable physics chain "cape"') &&
          issue.message.includes("step 5"),
      ),
    ).toBe(true);
    expect(existsSync(join(exposedCorpus, "goldens", "exposed"))).toBe(false);
  });
});

describe("runConformance regeneration", () => {
  it("resolves sibling corpus models while reading timelines through a pinned descriptor", () => {
    const corpusDir = tempDir();
    const modelsDir = join(corpusDir, "models");
    mkdirSync(modelsDir);
    mutableBuiltinFs.renameSync(writeFixture(baseDocs()), join(modelsDir, "fixture.lyre"));
    writeTimeline(corpusDir, "live", {
      model: "../models/fixture.lyre",
      fps: 1,
      steps: 1,
      captures: [],
    });

    const report = runConformance(corpusDir, { regen: true });

    expect(report.issues).toEqual([]);
    expect(existsSync(join(corpusDir, "goldens", "live"))).toBe(true);
  });

  it.each([
    { name: "full regeneration", filter: undefined, victimId: "victim" },
    { name: "filtered regeneration", filter: "live", victimId: "live" },
  ])("pins the original corpus before discovery during $name", ({ filter, victimId }) => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });

    const replacementDir = tempDir();
    writeTimeline(replacementDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });
    const victim = join(replacementDir, "goldens", victimId, "sentinel.txt");
    mkdirSync(join(replacementDir, "goldens", victimId), { recursive: true });
    writeFileSync(victim, "must survive\n");

    const holdingDir = tempDir();
    const heldCorpus = join(holdingDir, "original-corpus");
    const originalReaddirSync = mutableBuiltinFs.readdirSync;
    let swapped = false;
    mutableBuiltinFs.readdirSync = ((path: unknown, ...args: unknown[]) => {
      const entries = Reflect.apply(originalReaddirSync, mutableBuiltinFs, [path, ...args]);
      if (!swapped) {
        swapped = true;
        mutableBuiltinFs.renameSync(corpusDir, heldCorpus);
        mutableBuiltinFs.renameSync(replacementDir, corpusDir);
      }
      return entries;
    }) as typeof originalReaddirSync;
    syncBuiltinESMExports();

    let report: ReturnType<typeof runConformance> | undefined;
    try {
      report = runConformance(corpusDir, {
        regen: true,
        ...(filter === undefined ? {} : { filter }),
      });
    } finally {
      mutableBuiltinFs.readdirSync = originalReaddirSync;
      syncBuiltinESMExports();
      if (swapped) {
        mutableBuiltinFs.renameSync(corpusDir, replacementDir);
        mutableBuiltinFs.renameSync(heldCorpus, corpusDir);
      }
    }

    expect(swapped).toBe(true);
    expect(report?.ran).toEqual([]);
    expect(report?.issues.some((issue) => issue.message.includes("corpus directory changed"))).toBe(
      true,
    );
    expect(readFileSync(join(replacementDir, "goldens", victimId, "sentinel.txt"), "utf8")).toBe(
      "must survive\n",
    );
  });

  it.each([
    { name: "full regeneration", filter: undefined },
    { name: "filtered regeneration", filter: "live" },
  ])("refuses a symlinked goldens root during $name", ({ filter }) => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });
    const externalDir = tempDir();
    const sentinel = join(externalDir, "sentinel.txt");
    writeFileSync(sentinel, "must survive\n");
    symlinkSync(externalDir, join(corpusDir, "goldens"), "dir");

    const report = runConformance(corpusDir, {
      regen: true,
      ...(filter === undefined ? {} : { filter }),
    });

    expect(report.ran).toEqual([]);
    expect(report.issues.some((issue) => issue.message.includes("symbolic link"))).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("must survive\n");
  });

  it("keeps stale cleanup anchored when goldens is swapped only inside rmSync", () => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });
    const goldensDir = join(corpusDir, "goldens");
    mkdirSync(join(goldensDir, "removed"), { recursive: true });
    writeFileSync(join(goldensDir, "removed", "old.txt"), "remove me\n");

    const externalDir = tempDir();
    const victim = join(externalDir, "removed", "sentinel.txt");
    mkdirSync(join(externalDir, "removed"));
    writeFileSync(victim, "must survive\n");

    const heldGoldens = join(corpusDir, "goldens-held");
    const originalRmSync = mutableBuiltinFs.rmSync;
    let swapped = false;
    mutableBuiltinFs.rmSync = ((path: unknown, ...args: unknown[]) => {
      if (!swapped && basename(String(path)) === "removed") {
        swapped = true;
        mutableBuiltinFs.renameSync(goldensDir, heldGoldens);
        symlinkSync(externalDir, goldensDir, "dir");
        try {
          return Reflect.apply(originalRmSync, mutableBuiltinFs, [path, ...args]);
        } finally {
          mutableBuiltinFs.unlinkSync(goldensDir);
          mutableBuiltinFs.renameSync(heldGoldens, goldensDir);
        }
      }
      return Reflect.apply(originalRmSync, mutableBuiltinFs, [path, ...args]);
    }) as typeof originalRmSync;
    syncBuiltinESMExports();

    let report: ReturnType<typeof runConformance> | undefined;
    try {
      report = runConformance(corpusDir, { regen: true });
    } finally {
      mutableBuiltinFs.rmSync = originalRmSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(report?.issues).toEqual([]);
    expect(existsSync(join(goldensDir, "removed"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("must survive\n");
  });

  it("keeps golden writes anchored when goldens is swapped only inside writeFileSync", () => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [0],
    });
    const goldensDir = join(corpusDir, "goldens");
    mkdirSync(goldensDir);

    const externalDir = tempDir();
    mkdirSync(join(externalDir, "live"));
    const externalCapture = join(externalDir, "live", "0.png");

    const heldGoldens = join(corpusDir, "goldens-held");
    const originalWriteFileSync = mutableBuiltinFs.writeFileSync;
    let swapped = false;
    mutableBuiltinFs.writeFileSync = ((path: unknown, ...args: unknown[]) => {
      if (!swapped && basename(String(path)) === "0.png") {
        swapped = true;
        mutableBuiltinFs.renameSync(goldensDir, heldGoldens);
        symlinkSync(externalDir, goldensDir, "dir");
        try {
          return Reflect.apply(originalWriteFileSync, mutableBuiltinFs, [path, ...args]);
        } finally {
          mutableBuiltinFs.unlinkSync(goldensDir);
          mutableBuiltinFs.renameSync(heldGoldens, goldensDir);
        }
      }
      return Reflect.apply(originalWriteFileSync, mutableBuiltinFs, [path, ...args]);
    }) as typeof originalWriteFileSync;
    syncBuiltinESMExports();

    let report: ReturnType<typeof runConformance> | undefined;
    try {
      report = runConformance(corpusDir, { regen: true });
    } finally {
      mutableBuiltinFs.writeFileSync = originalWriteFileSync;
      syncBuiltinESMExports();
    }

    expect(swapped).toBe(true);
    expect(report?.issues).toEqual([]);
    expect(existsSync(join(goldensDir, "live", "0.png"))).toBe(true);
    expect(existsSync(externalCapture)).toBe(false);
  });

  it("refuses a non-directory goldens root", () => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });
    const goldensPath = join(corpusDir, "goldens");
    writeFileSync(goldensPath, "not a directory\n");

    const report = runConformance(corpusDir, { regen: true });

    expect(report.ran).toEqual([]);
    expect(report.issues.some((issue) => issue.message.includes("must be a directory"))).toBe(true);
    expect(readFileSync(goldensPath, "utf8")).toBe("not a directory\n");
  });

  it("unlinks a timeline-level golden symlink without touching its target during cleanup", () => {
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "bad", {
      model: "/deliberately/missing/model.lyre",
      fps: 1,
      steps: 1,
      captures: [],
    });
    const externalDir = tempDir();
    const sentinel = join(externalDir, "sentinel.txt");
    writeFileSync(sentinel, "must survive\n");
    mkdirSync(join(corpusDir, "goldens"));
    symlinkSync(externalDir, join(corpusDir, "goldens", "bad"), "dir");

    const report = runConformance(corpusDir, { regen: true, filter: "bad" });

    expect(report.issues.some((issue) => issue.timeline === "bad")).toBe(true);
    expect(existsSync(join(corpusDir, "goldens", "bad"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("must survive\n");
  });

  it("rejects an empty corpus before cleaning existing goldens", () => {
    const corpusDir = tempDir();
    mkdirSync(join(corpusDir, "timelines"));
    const sentinel = join(corpusDir, "goldens", "keep", "sentinel.txt");
    mkdirSync(join(corpusDir, "goldens", "keep"), { recursive: true });
    writeFileSync(sentinel, "keep\n");

    const report = runConformance(corpusDir, { regen: true });

    expect(report.ran).toEqual([]);
    expect(report.issues.some((issue) => issue.message.includes("contains no"))).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
  });

  it("rejects an unmatched filter before cleaning existing goldens", () => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });
    const sentinel = join(corpusDir, "goldens", "keep", "sentinel.txt");
    mkdirSync(join(corpusDir, "goldens", "keep"), { recursive: true });
    writeFileSync(sentinel, "keep\n");

    const report = runConformance(corpusDir, { regen: true, filter: "missing" });

    expect(report.ran).toEqual([]);
    expect(report.issues.some((issue) => issue.message.includes("matched no"))).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
  });

  it.each([".timeline.json", "..timeline.json", "...timeline.json"])(
    "rejects timeline filename %s before it can target the goldens root or its parent",
    (filename) => {
      const corpusDir = tempDir();
      mkdirSync(join(corpusDir, "timelines"));
      writeFileSync(join(corpusDir, "timelines", filename), "{}\n");
      const sentinel = join(corpusDir, "goldens", "keep", "sentinel.txt");
      mkdirSync(join(corpusDir, "goldens", "keep"), { recursive: true });
      writeFileSync(sentinel, "keep\n");

      const report = runConformance(corpusDir, { regen: true });

      expect(report.ran).toEqual([]);
      expect(report.issues.some((issue) => issue.message.includes("safe path component"))).toBe(
        true,
      );
      expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
    },
  );

  it("removes orphan golden entries during a full regeneration", () => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "live", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [],
    });
    mkdirSync(join(corpusDir, "goldens", "removed"), { recursive: true });
    writeFileSync(join(corpusDir, "goldens", "removed", "trace.json"), "{}\n");

    expect(runConformance(corpusDir, { regen: true }).issues).toEqual([]);
    expect(existsSync(join(corpusDir, "goldens", "live"))).toBe(true);
    expect(existsSync(join(corpusDir, "goldens", "removed"))).toBe(false);
  });

  it("rejects oversized golden captures before reading or inflating them", () => {
    const modelDir = writeFixture(baseDocs());
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "oversized-capture", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [0],
    });
    expect(runConformance(corpusDir, { regen: true }).issues).toEqual([]);
    truncateSync(
      join(corpusDir, "goldens", "oversized-capture", "0.png"),
      LIMITS.textureFileBytes + 1,
    );

    const report = runConformance(corpusDir);
    expect(report.issues.some((issue) => issue.message.includes("exceeds the"))).toBe(true);
    expect(
      report.issues.some((issue) => issue.message.includes("golden oversized-capture/0.png")),
    ).toBe(true);
  });

  it("rejects oversized golden traces before reading or parsing them", () => {
    const modelDir = physicsModel(1);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "oversized-trace", {
      model: modelDir,
      fps: 1,
      steps: 10,
      captures: [],
      physics_trace: true,
    });
    expect(runConformance(corpusDir, { regen: true }).issues).toEqual([]);
    truncateSync(
      join(corpusDir, "goldens", "oversized-trace", "trace.json"),
      LIMITS.jsonFileBytes + 1,
    );

    const report = runConformance(corpusDir);
    expect(report.issues.some((issue) => issue.message.includes("exceeds the"))).toBe(true);
    expect(report.issues.some((issue) => issue.message.includes("golden trace"))).toBe(true);
  });

  it("reports the secondary catastrophic-region criterion", () => {
    const docs = baseDocs();
    docs.manifest.canvas.width = 100;
    docs.manifest.canvas.height = 100;
    const modelDir = writeFixture(docs);
    const corpusDir = tempDir();
    writeTimeline(corpusDir, "localized", {
      model: modelDir,
      fps: 1,
      steps: 1,
      captures: [0],
    });
    expect(runConformance(corpusDir, { regen: true }).issues).toEqual([]);

    const goldenPath = join(corpusDir, "goldens", "localized", "0.png");
    const golden = decodeSurfacePng(readFileSync(goldenPath));
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const offset = (y * golden.width + x) * 4;
        golden.data[offset] = golden.data[offset]! > 127 ? 0 : 255;
      }
    }
    writeFileSync(goldenPath, encodeSurfacePng(golden.width, golden.height, golden.data));

    const report = runConformance(corpusDir);
    expect(
      report.issues.some((issue) => issue.message.includes("largest 8-connected region 9/8")),
    ).toBe(true);
  });
});
