// §12 validator over targeted bad-model fixtures: each mutation of the
// minimal valid model must be caught with its specific error code.

import { describe, expect, it } from "vitest";
import { loadModel, RUNTIME_LIMITS } from "@refrain-lyre/core";
import { loadContainerDir } from "../src/container.js";
import { lintModel } from "../src/lints.js";
import { referenceComposite, restPoseRender } from "../src/restpose.js";
import { validateSchemas } from "../src/schema.js";
import { validateModelPath } from "../src/validate.js";
import { baseDocs, pngBuffer, writeFixture, tempDir, type FixtureDocs } from "./helpers.js";

async function run(docs: FixtureDocs) {
  return validateModelPath(writeFixture(docs));
}

function codes(report: Awaited<ReturnType<typeof validateModelPath>>, level?: string): string[] {
  return report.issues.filter((i) => !level || i.level === level).map((i) => i.code);
}

describe("valid fixture", () => {
  it("passes with no issues and reports stats", async () => {
    const report = await run(baseDocs());
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.stats).not.toBeNull();
    expect(report.stats!.nodes).toBe(2);
    expect(report.stats!.textureDimension).toBe(16);
    expect(report.stats!.canvasDimension).toBe(32);
  });

  it("reports JSON maxima from manifest-listed documents regardless of extension", async () => {
    const docs = baseDocs();
    docs.manifest.files.rig = "rig.data";
    docs.extraFiles = { "opaque.json": Buffer.alloc(1_000) };
    const dir = writeFixture(docs);
    const { readFileSync } = await import("node:fs");
    const manifestBytes = readFileSync(`${dir}/manifest.json`).byteLength;
    const rigBytes = readFileSync(`${dir}/rig.data`).byteLength;

    const report = await validateModelPath(dir);
    expect(report.ok).toBe(true);
    expect(report.stats?.jsonFileBytes).toBe(Math.max(manifestBytes, rigBytes));
    expect(report.stats?.jsonDocumentsBytes).toBe(manifestBytes + rigBytes);
  });
});

describe("container errors", () => {
  it("missing manifest", async () => {
    const report = await validateModelPath(tempDir());
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("container");
  });

  it("malformed JSON", async () => {
    const docs = baseDocs();
    const dir = writeFixture(docs);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dir}/rig.json`, "{ nope");
    const report = await validateModelPath(dir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("container");
  });

  it("rejects duplicate JSON object members before last-wins parsing", async () => {
    const dir = writeFixture(baseDocs());
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      `${dir}/rig.json`,
      '{"params":[],"nodes":[{"id":"root","type":"group"}],"bindings":[],"$note":1,"\\u0024note":2}',
    );
    const report = await validateModelPath(dir);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("container");
    expect(
      report.issues.some((issue) => issue.message.includes("duplicate JSON object member")),
    ).toBe(true);
  });

  it("manifest path traversal is rejected (§16)", async () => {
    const docs = baseDocs();
    docs.manifest.files.rig = "../rig.json";
    const report = await run(docs);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("container");
  });

  it("rejects malformed and duplicate manifest file-index entries", async () => {
    const malformed = baseDocs();
    malformed.manifest.files.rig = 42;
    expect(codes(await run(malformed))).toContain("container");

    const duplicate = baseDocs();
    duplicate.manifest.files.expressions = ["expressions/a.exp.json", "expressions/a.exp.json"];
    expect(codes(await run(duplicate))).toContain("container");
  });
});

describe("loader errors (§3.1, §16)", () => {
  it("unsupported MAJOR version", async () => {
    const docs = baseDocs();
    docs.manifest.lyre = "2.0";
    const report = await run(docs);
    expect(codes(report, "error")).toContain("unsupported_spec_version");
  });

  it("unknown capability", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "holograms"];
    const report = await run(docs);
    expect(codes(report, "error")).toContain("unsupported_capability");
  });

  it("bad id", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children[0].id = "Bad Id!";
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_id");
  });

  it("duplicate id", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children.push({ id: "s", type: "sprite", rect: [0, 0, 8, 8], z: 20 });
    const report = await run(docs);
    expect(codes(report, "error")).toContain("duplicate_id");
  });

  it("unknown node type", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children.push({ id: "b", type: "bone", rect: [0, 0, 8, 8] });
    const report = await run(docs);
    expect(codes(report, "error")).toContain("unknown_node_type");
  });

  it("sprite with children", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children[0].children = [{ id: "c", type: "sprite", rect: [0, 0, 4, 4] }];
    const report = await run(docs);
    expect(codes(report, "error")).toContain("sprite_children");
  });

  it("warp grid over the §16 ceiling", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children = [
      {
        id: "w",
        type: "warp",
        rect: [0, 0, 16, 16],
        cols: 65,
        rows: 2,
        children: [{ id: "s", type: "sprite", rect: [0, 0, 16, 16], z: 10 }],
      },
    ];
    const report = await run(docs);
    expect(codes(report, "error")).toContain("limit_exceeded");
  });

  it("param with min > max", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 1, max: -1, default: 0 }];
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_param");
  });

  it("binding to a missing target", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.bindings = [
      { target: "ghost", property: "opacity", params: ["p"], axes: [[0, 1]], values: [1, 1] },
    ];
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_reference");
  });

  it("binding values with the wrong length", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.bindings = [
      { target: "s", property: "opacity", params: ["p"], axes: [[0, 1]], values: [1, 1, 1] },
    ];
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_binding");
  });

  it("recursive mask chain", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children = [
      {
        id: "a",
        type: "sprite",
        rect: [0, 0, 16, 16],
        z: 10,
        mask: { mode: "alpha", sources: ["b"] },
      },
      {
        id: "b",
        type: "sprite",
        rect: [0, 0, 16, 16],
        z: 20,
        mask: { mode: "alpha", sources: ["a"] },
      },
    ];
    docs.textures = { a: pngBuffer(16, 16), b: pngBuffer(16, 16) };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("recursive_mask");
  });

  it("variant slot whose default option is missing", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "variants"];
    docs.variants = {
      slots: [{ id: "hat", default: "ghost", options: [{ id: "none", nodes: [] }] }],
    };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_variants");
  });

  it("physics output link out of range", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "physics"];
    docs.rig.params = [{ id: "sway", min: -90, max: 90, default: 0 }];
    docs.physics = {
      fps: 60,
      chains: [
        {
          id: "c",
          inputs: [{ param: "sway", type: "x", weight: 1 }],
          links: [{ length: 10, damping: 0.1, stiffness: 0.1 }],
          outputs: [{ link: 5, param: "sway", multiplier: 1, blend: "overwrite" }],
        },
      ],
    };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_reference");
  });

  it("physics link with damping out of range", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "physics"];
    docs.rig.params = [{ id: "sway", min: -90, max: 90, default: 0 }];
    docs.physics = {
      fps: 60,
      chains: [
        {
          id: "c",
          inputs: [{ param: "sway", type: "x", weight: 1 }],
          links: [{ length: 10, damping: 1.5, stiffness: 0.1 }],
          outputs: [{ link: 0, param: "sway", multiplier: 1, blend: "overwrite" }],
        },
      ],
    };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_physics");
  });

  it("motion bezier control point x outside [0,1]", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "motion"];
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.motions = {
      m: {
        id: "m",
        duration: 1,
        loop: false,
        tracks: [
          {
            param: "p",
            keys: [
              { t: 0, v: 0 },
              { t: 1, v: 1, ease: "bezier", cp: [1.5, 0, 0.5, 1] },
            ],
          },
        ],
      },
    };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_motion");
  });

  it("expression with an unknown blend", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.expressions = {
      e: { id: "e", fade_in: 0, fade_out: 0, params: [{ id: "p", value: 1, blend: "screen" }] },
    };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_expression");
  });
});

describe("texture and atlas errors", () => {
  it("missing texture file", async () => {
    const docs = baseDocs();
    docs.textures = {};
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_texture");
  });

  it("texture over the §16 dimension ceiling", async () => {
    const docs = baseDocs();
    docs.textures = { s: pngBuffer(8193, 1) };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_texture");
  });

  it("reports a shared corrupt texture only once", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children.push({
      id: "t",
      type: "sprite",
      rect: [0, 0, 16, 16],
      z: 20,
      texture: "s",
    });
    docs.textures = { s: Buffer.from("not a png") };
    const report = await run(docs);
    expect(report.issues.filter((issue) => issue.code === "bad_texture")).toHaveLength(1);
  });

  it("atlas rect outside the atlas image", async () => {
    const docs = baseDocs();
    docs.atlas = { image: "atlas.png", rects: { s: [20, 20, 16, 16] } };
    docs.extraFiles = { "atlas.png": pngBuffer(24, 24) };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_atlas");
  });

  it("rejects atlas crops that disagree with their per-file texture", async () => {
    const wrongSize = baseDocs();
    wrongSize.atlas = { image: "atlas.png", rects: { s: [0, 0, 8, 16] } };
    wrongSize.extraFiles = { "atlas.png": pngBuffer(16, 16) };
    expect(codes(await run(wrongSize), "error")).toContain("bad_atlas");

    const wrongPixels = baseDocs();
    wrongPixels.atlas = { image: "atlas.png", rects: { s: [0, 0, 16, 16] } };
    wrongPixels.extraFiles = { "atlas.png": pngBuffer(16, 16, [0, 0, 255, 255]) };
    expect(codes(await run(wrongPixels), "error")).toContain("bad_atlas");
  });

  it("public container loading rejects invalid atlas bounds, sizes, and pixels", () => {
    const outside = baseDocs();
    outside.atlas = { image: "atlas.png", rects: { s: [20, 20, 16, 16] } };
    outside.extraFiles = { "atlas.png": pngBuffer(24, 24) };
    expect(() => loadContainerDir(writeFixture(outside))).toThrow(/falls outside/);

    const wrongSize = baseDocs();
    wrongSize.atlas = { image: "atlas.png", rects: { s: [0, 0, 8, 16] } };
    wrongSize.extraFiles = { "atlas.png": pngBuffer(16, 16) };
    expect(() => loadContainerDir(writeFixture(wrongSize))).toThrow(/is 8×16/);

    const wrongPixels = baseDocs();
    wrongPixels.atlas = { image: "atlas.png", rects: { s: [0, 0, 16, 16] } };
    wrongPixels.extraFiles = { "atlas.png": pngBuffer(16, 16, [0, 0, 255, 255]) };
    expect(() => loadContainerDir(writeFixture(wrongPixels))).toThrow(/premultiplied pixels/);
  });

  it("checks referenced atlas crops before capped unused-rect warnings", async () => {
    const docs = baseDocs();
    const rects = Object.fromEntries(
      Array.from({ length: 257 }, (_, i) => [`unused_${i}`, [0, 0, 1, 1]]),
    );
    rects.s = [0, 0, 16, 16];
    docs.atlas = { image: "atlas.png", rects };
    docs.extraFiles = { "atlas.png": pngBuffer(16, 16, [0, 0, 255, 255]) };

    const report = await run(docs);
    expect(codes(report, "error")).toContain("bad_atlas");
    expect(report.ok).toBe(false);
  });
});

describe("schema validation", () => {
  it("flags structural schema violations", async () => {
    const docs = baseDocs();
    docs.manifest.author = 42;
    const report = await run(docs);
    expect(codes(report, "error")).toContain("schema");
  });

  it("bounds schema diagnostics across many invalid documents", () => {
    const docs = baseDocs();
    const motions: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      motions[`motions/m${i.toString().padStart(3, "0")}.motion.json`] = null;
    }
    const issues = validateSchemas(
      {
        manifest: docs.manifest,
        rig: docs.rig,
        motions,
      },
      { manifest: "manifest.json", rig: "rig.json" },
    );
    expect(issues.filter((issue) => issue.code === "schema")).toHaveLength(256);
    expect(issues.filter((issue) => issue.code === "schema_analysis_truncated")).toHaveLength(1);
    expect(issues.at(-1)?.message).toContain("additional schema errors were omitted");
  });

  it("screens recursive rig depth before AJV can overflow its stack", () => {
    const docs = baseDocs();
    const root = { id: "deep_0", type: "group", children: [] as unknown[] };
    let current = root;
    for (let i = 1; i < 20_000; i++) {
      const child = { id: `deep_${i}`, type: "group", children: [] as unknown[] };
      current.children.push(child);
      current = child;
    }
    const issues = validateSchemas(
      {
        manifest: docs.manifest,
        rig: { params: [], nodes: [root], bindings: [] },
      },
      { manifest: "manifest.json", rig: "rig.json" },
    );
    expect(issues.some((issue) => issue.code === "schema_analysis_truncated")).toBe(true);
    expect(issues.find((issue) => issue.code === "schema_analysis_truncated")?.message).toContain(
      "node depth exceeds",
    );
  });
});

describe("rest-pose check (§12)", () => {
  it("flags geometry displaced at defaults", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.bindings = [
      {
        target: "s",
        property: "offset",
        params: ["p"],
        axes: [[0, 1]],
        values: [
          [8, 8],
          [0, 0],
        ],
      },
    ];
    const report = await run(docs);
    expect(codes(report, "error")).toContain("rest_pose");
  });

  it("accepts rest-invisible layers via opacity factor bindings (blink idiom)", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "open", min: 0, max: 1, default: 1 }];
    docs.rig.nodes[0].children.push({
      id: "lid",
      type: "sprite",
      rect: [0, 0, 16, 16],
      z: 20,
      texture: "s",
    });
    docs.rig.bindings = [
      { target: "lid", property: "opacity", params: ["open"], axes: [[0, 1]], values: [1, 0] },
    ];
    const report = await run(docs);
    expect(report.ok).toBe(true);
    expect(codes(report, "error")).toEqual([]);
  });

  it("applies wrap semantics to a default exactly at the maximum", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "spin", min: 0, max: 360, default: 360, wrap: true }];
    docs.rig.bindings = [
      {
        target: "s",
        property: "opacity",
        params: ["spin"],
        axes: [[0, 180]],
        values: [1, 0],
      },
    ];

    const report = await run(docs);
    expect(report.ok).toBe(true);
    expect(codes(report, "error")).toEqual([]);
  });

  it("matches runtime grouping for cancelling ancestor and sprite z deltas", async () => {
    const docs = baseDocs();
    docs.manifest.canvas = { width: 2, height: 2, origin: [0, 0] };
    docs.rig.params = [
      { id: "root_z", min: 0, max: 1, default: 0 },
      { id: "inner_z", min: 0, max: 1, default: 0 },
      { id: "sprite_z", min: 0, max: 1, default: 0 },
    ];
    docs.rig.nodes = [
      {
        id: "root",
        type: "group",
        children: [
          {
            id: "inner",
            type: "group",
            children: [
              { id: "s", type: "sprite", rect: [0, 0, 2, 2], z: 0, texture: "red" },
              { id: "t", type: "sprite", rect: [0, 0, 2, 2], z: 0, texture: "blue" },
            ],
          },
        ],
      },
    ];
    const constantZ = (target: string, param: string, value: number) => ({
      target,
      property: "z",
      params: [param],
      axes: [[0, 1]],
      values: [value, value],
    });
    docs.rig.bindings = [
      constantZ("root", "root_z", 1e12),
      constantZ("inner", "inner_z", -1e12),
      constantZ("s", "sprite_z", 0.49995),
    ];
    docs.textures = {
      red: pngBuffer(2, 2, [255, 0, 0, 255]),
      blue: pngBuffer(2, 2, [0, 0, 255, 255]),
    };

    const report = await run(docs);
    expect(report.ok).toBe(true);
    expect(codes(report, "error")).not.toContain("rest_pose");
  });

  it("matches runtime root-to-parent opacity multiplication exactly", () => {
    const docs = baseDocs();
    docs.manifest.canvas = { width: 1, height: 1, origin: [0, 0] };
    const ancestorOpacities = [0.9236455525271595, 0.9369270673720166, 0.9504242032300682];
    docs.rig.nodes = [
      {
        id: "root",
        type: "group",
        opacity: ancestorOpacities[0],
        children: [
          {
            id: "middle",
            type: "group",
            opacity: ancestorOpacities[1],
            children: [
              {
                id: "inner",
                type: "group",
                opacity: ancestorOpacities[2],
                children: [
                  {
                    id: "s",
                    type: "sprite",
                    rect: [0, 0, 1, 1],
                    z: 0,
                    opacity: 0.0023839723137707323,
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    docs.textures = { s: pngBuffer(1, 1, [255, 255, 255, 255]) };
    const container = loadContainerDir(writeFixture(docs));

    const actual = restPoseRender(container);
    expect([...actual]).toEqual([1, 1, 1, 1]);
    expect(referenceComposite(container)).toEqual(actual);
  });

  it("combines rest-reference mask sources in canonical id order", () => {
    const docs = baseDocs();
    docs.manifest.canvas = { width: 1, height: 1, origin: [0, 0] };
    docs.rig.nodes[0].children = [
      { id: "a", type: "sprite", rect: [0, 0, 1, 1], opacity: 0, texture: "alpha_a" },
      { id: "b", type: "sprite", rect: [0, 0, 1, 1], opacity: 0, texture: "alpha_b" },
      { id: "c", type: "sprite", rect: [0, 0, 1, 1], opacity: 0, texture: "alpha_c" },
      {
        id: "target",
        type: "sprite",
        rect: [0, 0, 1, 1],
        opacity: 0.0048816578042336963,
        texture: "white",
        // Deliberately reverse the normative source-id order. The chosen
        // alpha/opacity values straddle an RGBA8 half-step if accumulation is
        // performed in this authored order instead of canonical id order.
        mask: { mode: "alpha", sources: ["c", "b", "a"] },
      },
    ];
    docs.textures = {
      alpha_a: pngBuffer(1, 1, [0, 0, 0, 1]),
      alpha_b: pngBuffer(1, 1, [0, 0, 0, 38]),
      alpha_c: pngBuffer(1, 1, [0, 0, 0, 75]),
      white: pngBuffer(1, 1, [255, 255, 255, 255]),
    };
    const container = loadContainerDir(writeFixture(docs));

    const actual = restPoseRender(container);
    expect([...actual]).toEqual([0, 0, 0, 0]);
    expect(referenceComposite(container)).toEqual(actual);
  });

  it("uses canonical overflow-safe factor composition in the reference", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    const constantFactor = (factor: number) => ({
      target: "s",
      property: "opacity",
      params: ["p"],
      axes: [[0, 1]],
      values: [factor, factor],
    });
    docs.rig.bindings = [
      ...Array.from({ length: 26 }, () => constantFactor(1e12)),
      ...Array.from({ length: 26 }, () => constantFactor(1e-12)),
      constantFactor(0.5),
    ];

    const report = await run(docs);
    expect(report.ok).toBe(true);
    expect(codes(report, "error")).toEqual([]);
  });

  it("does not evaluate rest-reference bindings below an excluded default variant", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "variants"];
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.nodes[0].children.push({
      id: "inactive",
      type: "sprite",
      rect: [0, 0, 16, 16],
      z: 20,
      texture: "s",
    });
    docs.rig.bindings = Array.from({ length: 26 }, () => ({
      target: "inactive",
      property: "opacity",
      params: ["p"],
      axes: [[0, 1]],
      values: [1e12, 1e12],
    }));
    docs.variants = {
      slots: [
        {
          id: "outfit",
          default: "none",
          options: [
            { id: "none", nodes: [] },
            { id: "shown", nodes: ["inactive"] },
          ],
        },
      ],
    };

    const report = await run(docs);
    expect(report.ok).toBe(true);
    expect(codes(report, "error")).toEqual([]);
  });

  it("uses exclusive right and bottom edges for fractional flat rects", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children[0].rect = [0, 0, 0.5, 0.5];
    docs.textures = { s: pngBuffer(1, 1) };
    const report = await run(docs);
    expect(report.ok).toBe(true);
    expect(codes(report, "error")).toEqual([]);
  });

  it("returns a resource-limit issue before an excessive reference composite", async () => {
    const docs = baseDocs();
    const width = 1_000;
    const height = 1_000;
    const layers = Math.floor(RUNTIME_LIMITS.rasterSampleTestsPerFrame / (width * height)) + 1;
    docs.manifest.canvas = { width, height, origin: [0, 0] };
    docs.rig.nodes[0].children = Array.from({ length: layers }, (_, i) => ({
      id: `layer_${i}`,
      type: "sprite",
      rect: [0, 0, width, height],
      z: i,
      texture: "s",
    }));
    docs.textures = { s: pngBuffer(1, 1) };
    const report = await run(docs);
    expect(codes(report, "error")).toContain("limit_exceeded");
    expect(report.issues.find((issue) => issue.code === "limit_exceeded")?.message).toContain(
      "raster candidate tests",
    );
  });

  it("tiles a costly flat reference when the authored runtime frame is within its limit", async () => {
    const docs = baseDocs();
    const width = 1_024;
    const height = 1_024;
    docs.manifest.canvas = { width, height, origin: [0, 0] };
    const sources = Array.from({ length: 22 }, (_, index) => ({
      id: `source_${index}`,
      type: "sprite",
      rect: [0, 0, width, height],
      z: index,
      opacity: 0,
      texture: "clear",
      mesh: {
        type: "explicit",
        points: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        tris: [[0, 1, 2]],
      },
    }));
    const targets = sources.map((source, index) => ({
      id: `target_${index}`,
      type: "sprite",
      rect: [0, 0, 1, 1],
      z: 100 + index,
      texture: "clear",
      mask: { mode: "alpha", sources: [source.id] },
    }));
    docs.rig.nodes[0].children = [
      {
        id: "background",
        type: "sprite",
        rect: [0, 0, width, height],
        z: -1,
        texture: "opaque",
      },
      ...sources,
      ...targets,
    ];
    docs.textures = {
      clear: pngBuffer(1, 1, [0, 0, 0, 0]),
      opaque: pngBuffer(1, 1, [30, 90, 180, 255]),
    };

    const report = await run(docs);
    expect(codes(report, "error")).not.toContain("limit_exceeded");
    expect(report.ok).toBe(true);
  }, 30_000);

  it("subdivides from exact tile work instead of rejecting sparse geometry", async () => {
    const docs = baseDocs();
    docs.manifest.canvas = { width: 20, height: 20, origin: [0, 0] };
    docs.rig.nodes[0].children = [
      {
        id: "covered",
        type: "sprite",
        rect: [0, 0, 20, 20],
        z: 0,
        texture: "s",
        mesh: {
          type: "explicit",
          points: [
            [-100, -100],
            [-99, -100],
            [-100, -99],
          ],
          tris: [[0, 1, 2]],
        },
      },
      { id: "cover", type: "sprite", rect: [0, 0, 20, 20], z: 1, texture: "s" },
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `off_${index}`,
        type: "sprite",
        rect: [-100, -100, 1, 1],
        z: index + 2,
        texture: "s",
      })),
    ];
    docs.textures = { s: pngBuffer(1, 1, [30, 90, 180, 255]) };

    const originalFrameLimit = RUNTIME_LIMITS.rasterSampleTestsPerFrame;
    const originalReferenceLimit = RUNTIME_LIMITS.restPoseReferenceCandidateTests;
    Object.assign(RUNTIME_LIMITS, {
      rasterSampleTestsPerFrame: 1_200,
      restPoseReferenceCandidateTests: 4_800,
    });
    try {
      const report = await run(docs);
      expect(codes(report, "error")).not.toContain("limit_exceeded");
      expect(report.ok).toBe(true);
    } finally {
      Object.assign(RUNTIME_LIMITS, {
        rasterSampleTestsPerFrame: originalFrameLimit,
        restPoseReferenceCandidateTests: originalReferenceLimit,
      });
    }
  });

  it("uses normative candidate work for many tiny mask sources", async () => {
    const docs = baseDocs();
    const sources = Array.from({ length: 256 }, (_, index) => ({
      id: `source_${index}`,
      type: "sprite",
      rect: [index % 16, Math.floor(index / 16), 1, 1],
      z: index,
      opacity: 0,
      texture: "s",
    }));
    docs.manifest.canvas = { width: 512, height: 512, origin: [0, 0] };
    docs.rig.nodes[0].children = [
      ...sources,
      {
        id: "target",
        type: "sprite",
        rect: [0, 0, 512, 512],
        z: 1_000,
        texture: "s",
        mask: { mode: "alpha", sources: sources.map((source) => source.id) },
      },
    ];
    docs.textures = { s: pngBuffer(1, 1) };

    const report = await run(docs);
    expect(codes(report, "error")).not.toContain("limit_exceeded");
    expect(report.ok).toBe(true);
  });
});

describe("lints (§12)", () => {
  it("warns on sprite and ancestor binding z to the same parameter", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.bindings = [
      { target: "s", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 5] },
      { target: "root", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 5] },
    ];
    const report = await run(docs);
    expect(codes(report, "warning")).toContain("z_conflict");
  });

  it("warns conservatively on a possible z tie", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.nodes[0].children.push({
      id: "t",
      type: "sprite",
      rect: [16, 16, 16, 16],
      z: 15,
      texture: "s",
    });
    docs.rig.bindings = [
      { target: "s", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 10] },
    ];
    const report = await run(docs);
    const issue = report.issues.find((item) => item.code === "z_tie_possible");
    expect(issue?.message).toContain("may tie");
    expect(issue?.message).toContain("conservative ranges");
  });

  it("does not warn when constant z values merely tie", async () => {
    const docs = baseDocs();
    docs.rig.nodes[0].children.push({
      id: "t",
      type: "sprite",
      rect: [16, 16, 16, 16],
      z: 10,
      texture: "s",
    });
    const report = await run(docs);
    expect(codes(report, "warning")).not.toContain("z_tie_possible");
  });

  it("does not treat an unmatched constant z binding as dynamic", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.nodes[0].children.push({
      id: "t",
      type: "sprite",
      rect: [16, 16, 16, 16],
      z: 10,
      texture: "s",
    });
    docs.rig.bindings = [
      { target: "s", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 0] },
    ];
    const report = await run(docs);
    expect(codes(report, "warning")).not.toContain("z_tie_possible");
  });

  it("does not warn when shared ancestor motion preserves relative z", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.nodes[0].children.push({
      id: "t",
      type: "sprite",
      rect: [16, 16, 16, 16],
      z: 15,
      texture: "s",
    });
    docs.rig.bindings = [
      { target: "root", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 10] },
    ];
    const report = await run(docs);
    expect(codes(report, "warning")).not.toContain("z_tie_possible");
  });

  it("does not warn when identical correlated z functions preserve relative z", async () => {
    const docs = baseDocs();
    docs.rig.params = [{ id: "p", min: 0, max: 1, default: 0 }];
    docs.rig.nodes[0].children.push({
      id: "t",
      type: "sprite",
      rect: [16, 16, 16, 16],
      z: 15,
      texture: "s",
    });
    docs.rig.bindings = [
      { target: "s", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 10] },
      { target: "t", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 10] },
    ];
    const report = await run(docs);
    expect(codes(report, "warning")).not.toContain("z_tie_possible");
  });

  it("warns when a mask source can be excluded while its sprite is active", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "variants"];
    docs.rig.nodes[0].children = [
      { id: "src", type: "sprite", rect: [0, 0, 16, 16], z: 5, texture: "s" },
      {
        id: "clipped",
        type: "sprite",
        rect: [0, 0, 16, 16],
        z: 10,
        texture: "s",
        mask: { mode: "alpha", sources: ["src"] },
      },
    ];
    docs.variants = {
      slots: [
        {
          id: "acc",
          default: "on",
          options: [
            { id: "on", nodes: ["src"] },
            { id: "off", nodes: [] },
          ],
        },
      ],
    };
    const report = await run(docs);
    expect(codes(report, "warning")).toContain("excludable_mask_source");
  });

  it("finds excludable mask sources that require a combined slot selection", async () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "variants"];
    docs.rig.nodes[0].children = [
      {
        id: "gate",
        type: "group",
        children: [
          { id: "src", type: "sprite", rect: [0, 0, 16, 16], z: 5, texture: "s" },
          {
            id: "clipped",
            type: "sprite",
            rect: [0, 0, 16, 16],
            z: 10,
            texture: "s",
            mask: { mode: "alpha", sources: ["src"] },
          },
        ],
      },
    ];
    docs.variants = {
      slots: [
        {
          id: "source",
          default: "on",
          options: [
            { id: "on", nodes: ["src"] },
            { id: "off", nodes: [] },
          ],
        },
        {
          id: "gate",
          default: "hidden",
          options: [
            { id: "hidden", nodes: [] },
            { id: "shown", nodes: ["gate"] },
          ],
        },
      ],
    };

    const report = await run(docs);
    expect(codes(report, "warning")).toContain("excludable_mask_source");
  });

  it("bounds mask/variant candidate analysis deterministically", () => {
    const docs = baseDocs();
    docs.manifest.capabilities = ["core", "variants"];
    docs.manifest.files.variants = "variants.json";
    const sources = Array.from({ length: 256 }, (_, i) => ({
      id: `src_${i}`,
      type: "sprite",
      rect: [0, 0, 1, 1],
      z: i,
      texture: "s",
    }));
    docs.rig.nodes[0].children = [
      { id: "variant_node", type: "group", children: sources },
      {
        id: "clipped",
        type: "sprite",
        rect: [0, 0, 1, 1],
        z: 1_000,
        texture: "s",
        mask: { mode: "alpha", sources: sources.map((source) => source.id) },
      },
    ];
    docs.variants = {
      slots: [
        {
          id: "slot",
          default: "option_0",
          options: Array.from({ length: 400 }, (_, i) => ({
            id: `option_${i}`,
            nodes: ["variant_node"],
          })),
        },
      ],
    };

    const model = loadModel({
      manifest: docs.manifest,
      rig: docs.rig,
      variants: docs.variants,
    });
    const issues = lintModel(model);
    expect(issues.filter((issue) => issue.code === "excludable_mask_source")).toEqual([]);
    expect(issues.filter((issue) => issue.code === "mask_variant_analysis_truncated")).toHaveLength(
      1,
    );
    expect(issues.at(-1)?.message).toContain("candidate-selection budget (100000)");
  });
});
