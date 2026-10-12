import { describe, expect, it } from "vitest";
import { LyreLoadError, loadModel, type ModelFiles } from "../src/index.js";

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lyre: "0.1",
    id: "test_model",
    canvas: { width: 256, height: 256, origin: [128, 128] },
    ...extra,
  };
}

function minimalRig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    params: [],
    nodes: [{ id: "root", type: "group", children: [] }],
    bindings: [],
    ...extra,
  };
}

function indexedManifest(value: unknown, documents: Partial<ModelFiles>): Record<string, unknown> {
  const base = value as Record<string, unknown>;
  if (base.files !== undefined) return base;
  const indexed: Record<string, unknown> = { rig: "rig.json" };
  if (documents.physics !== undefined) indexed.physics = "physics.json";
  if (documents.variants !== undefined) indexed.variants = "variants.json";
  if (documents.atlas !== undefined) indexed.atlas = "atlas.json";
  const expressions = Object.keys(documents.expressions ?? {});
  if (expressions.length > 0) indexed.expressions = expressions;
  const motions = Object.keys(documents.motions ?? {});
  if (motions.length > 0) indexed.motions = motions;
  return { ...base, files: indexed };
}

function load(files: Partial<ModelFiles>) {
  const documents = { rig: minimalRig(), ...files };
  return loadModel({
    ...documents,
    manifest: indexedManifest(files.manifest ?? manifest(), documents),
  });
}

function expectLoadError(files: Partial<ModelFiles>, code: string) {
  try {
    load(files);
  } catch (e) {
    expect(e).toBeInstanceOf(LyreLoadError);
    expect((e as LyreLoadError).code).toBe(code);
    return;
  }
  expect.fail(`expected LyreLoadError ${code}, but the model loaded`);
}

describe("loadModel — manifest (§3.1)", () => {
  it("loads a minimal model", () => {
    const m = load({});
    expect(m.id).toBe("test_model");
    expect(m.root.type).toBe("group");
    expect(m.capabilities.has("core")).toBe(true);
    expect(m.warnings).toEqual([]);
  });

  it("refuses a higher MAJOR version", () => {
    expectLoadError({ manifest: manifest({ lyre: "1.0" }) }, "unsupported_spec_version");
  });

  it("warns on a higher MINOR version", () => {
    const m = load({ manifest: manifest({ lyre: "0.9" }) });
    expect(m.warnings.some((w) => w.includes("0.9"))).toBe(true);
  });

  it("refuses an unknown capability (§3.1)", () => {
    expectLoadError(
      { manifest: manifest({ capabilities: ["core", "holograms"] }) },
      "unsupported_capability",
    );
  });

  it("loads with the host override, surfacing a warning (§3.1)", () => {
    const m = loadModel(
      { manifest: manifest({ capabilities: ["holograms"] }), rig: minimalRig() },
      { allowCapabilityOverride: true },
    );
    expect(m.warnings.some((w) => w.includes("holograms"))).toBe(true);
  });

  it("allows an override only when the unsupported shipped feature is listed", () => {
    const m = loadModel(
      {
        manifest: manifest({
          capabilities: ["physics"],
          files: { rig: "rig.json", physics: "physics.json" },
        }),
        rig: minimalRig(),
        physics: { fps: 60, chains: [] },
      },
      { supportedCapabilities: ["core"], allowCapabilityOverride: true },
    );
    expect(m.physics).not.toBeNull();
    expect(m.warnings.some((w) => w.includes("physics"))).toBe(true);
  });

  it("does not let an override hide an omitted shipped-feature capability", () => {
    expect(() =>
      loadModel(
        {
          manifest: manifest({ files: { rig: "rig.json", physics: "physics.json" } }),
          rig: minimalRig(),
          physics: { fps: 60, chains: [] },
        },
        { supportedCapabilities: ["core"], allowCapabilityOverride: true },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<LyreLoadError>>({ code: "unsupported_capability" }),
    );
  });

  it("enforces manifest.files for the parsed-document loader", () => {
    expect(() =>
      loadModel({
        manifest: manifest({ capabilities: ["physics"], files: { rig: "rig.json" } }),
        rig: minimalRig(),
        physics: { fps: 60, chains: [] },
      }),
    ).toThrow(/does not list/);
    expect(() =>
      loadModel({
        manifest: manifest({
          capabilities: ["physics"],
          files: { rig: "rig.json", physics: "physics.json" },
        }),
        rig: minimalRig(),
      }),
    ).toThrow(/no parsed physics document/);
    expect(() =>
      loadModel({
        manifest: manifest({
          files: { rig: "rig.json", expressions: ["expressions/a.exp.json"] },
        }),
        rig: minimalRig(),
        expressions: {
          "expressions/b.exp.json": { id: "b", params: [] },
        },
      }),
    ).toThrow(/exactly match/);
  });

  it("rejects unsafe and overlong container paths in the parsed-document API", () => {
    for (const path of ["../rig.json", "/rig.json", "C:rig.json", "safe\\..\\rig.json", "x\0y"]) {
      const files = {
        manifest: manifest({ files: { rig: path } }),
        rig: minimalRig(),
      };
      expect(() => loadModel(files), path).toThrow(/path|relative|segments/);
    }

    const overlong = `${"é".repeat(2048)}x`;
    expect(() =>
      loadModel({
        manifest: manifest({ files: { rig: overlong } }),
        rig: minimalRig(),
      }),
    ).toThrow(/4096 UTF-8 path bytes/);

    expect(() =>
      loadModel({
        manifest: manifest({ files: { rig: "rig.json", atlas: "atlas.json" } }),
        rig: minimalRig(),
        atlas: { image: "../atlas.png", rects: {} },
      }),
    ).toThrow(/atlas\.image.*segments/);
  });

  it("applies the container-file ceiling across every manifest document class", () => {
    const expressions = Array.from(
      { length: 4096 },
      (_, index) => `expressions/e${index}.exp.json`,
    );
    expect(() =>
      loadModel({
        manifest: manifest({
          files: {
            rig: "rig.json",
            expressions,
            motions: ["motions/one.motion.json"],
          },
        }),
        rig: minimalRig(),
      }),
    ).toThrow(/more than 4096 distinct JSON documents/);
  });

  it.each([
    ["motion", { motions: { idle: { id: "idle", duration: 1, tracks: [] } } }],
    ["physics", { physics: { fps: 60, chains: [] } }],
    ["variants", { variants: { slots: [] } }],
  ])("rejects shipped %s data when its capability is omitted", (_feature, files) => {
    expectLoadError(files, "unsupported_capability");
  });

  it("refuses a supported-set restriction", () => {
    expect(() =>
      loadModel(
        { manifest: manifest({ capabilities: ["physics"] }), rig: minimalRig() },
        { supportedCapabilities: ["core"] },
      ),
    ).toThrowError(LyreLoadError);
  });

  it("rejects canvas above the §16 ceiling", () => {
    expectLoadError(
      { manifest: manifest({ canvas: { width: 999999, height: 10, origin: [0, 0] } }) },
      "limit_exceeded",
    );
  });

  it("rejects a canvas above the aggregate pixel ceiling", () => {
    expectLoadError(
      { manifest: manifest({ canvas: { width: 4096, height: 4096, origin: [0, 0] } }) },
      "limit_exceeded",
    );
  });
});

describe("loadModel — params (§6)", () => {
  it("rejects duplicate param ids", () => {
    expectLoadError(
      {
        rig: minimalRig({
          params: [
            { id: "a", min: 0, max: 1, default: 0 },
            { id: "a", min: 0, max: 1, default: 0 },
          ],
        }),
      },
      "duplicate_id",
    );
  });

  it("rejects a default outside [min, max]", () => {
    expectLoadError(
      { rig: minimalRig({ params: [{ id: "a", min: 0, max: 1, default: 2 }] }) },
      "bad_param",
    );
  });

  it("rejects an unknown id under the reserved registry prefix", () => {
    expectLoadError(
      {
        rig: minimalRig({
          params: [{ id: "Lyre.FutureFaceThing", min: 0, max: 1, default: 0 }],
        }),
      },
      "bad_param",
    );
  });

  it("rejects a registry range/default deviation from Annex A", () => {
    expectLoadError(
      {
        rig: minimalRig({
          params: [{ id: "Lyre.AngleX", min: -10, max: 10, default: 0 }],
        }),
      },
      "bad_param",
    );
  });

  it("rejects wrap on a registry param (§6)", () => {
    expectLoadError(
      {
        rig: minimalRig({
          params: [{ id: "Lyre.AngleX", min: -30, max: 30, default: 0, wrap: true }],
        }),
      },
      "bad_param",
    );
  });

  it("rejects unrepresentable numeric ranges and oversized authored numbers", () => {
    expectLoadError(
      {
        rig: minimalRig({
          params: [{ id: "huge", min: -1e308, max: 1e308, default: 0 }],
        }),
      },
      "limit_exceeded",
    );
  });
});

describe("loadModel — nodes (§5, §16)", () => {
  it("rejects two roots", () => {
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [
            { id: "a", type: "group" },
            { id: "b", type: "group" },
          ],
        }),
      },
      "bad_root",
    );
  });

  it("rejects a non-group root", () => {
    expectLoadError(
      { rig: minimalRig({ nodes: [{ id: "s", type: "sprite", rect: [0, 0, 8, 8] }] }) },
      "bad_root",
    );
  });

  it("rejects unknown node types (§2)", () => {
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [{ id: "root", type: "group", children: [{ id: "b", type: "bone" }] }],
        }),
      },
      "unknown_node_type",
    );
  });

  it("rejects sprites with children", () => {
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [
            {
              id: "root",
              type: "group",
              children: [
                {
                  id: "s",
                  type: "sprite",
                  rect: [0, 0, 8, 8],
                  children: [{ id: "t", type: "sprite", rect: [0, 0, 8, 8] }],
                },
              ],
            },
          ],
        }),
      },
      "sprite_children",
    );
  });

  it("rejects trees deeper than 64 (§16)", () => {
    let node: Record<string, unknown> = { id: "leaf", type: "group" };
    for (let i = 0; i < 65; i++) node = { id: `g${i}`, type: "group", children: [node] };
    expectLoadError({ rig: minimalRig({ nodes: [node] }) }, "limit_exceeded");
  });

  it("rejects excessive aggregate sprite-mesh and warp control points", () => {
    const children = Array.from({ length: 249 }, (_, i) => ({
      id: `sprite_${i}`,
      type: "sprite",
      rect: [0, 0, 1, 1],
      mesh: { type: "grid", cols: 64, rows: 64 },
    }));
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [{ id: "root", type: "group", children }],
        }),
      },
      "limit_exceeded",
    );
  });

  it("rejects an explicit mesh above the triangle ceiling", () => {
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [
            {
              id: "root",
              type: "group",
              children: [
                {
                  id: "s",
                  type: "sprite",
                  rect: [0, 0, 1, 1],
                  mesh: {
                    type: "explicit",
                    points: [[0, 0]],
                    tris: new Array(131_073).fill([0, 0, 0]),
                  },
                },
              ],
            },
          ],
        }),
      },
      "limit_exceeded",
    );
  });

  it("rejects non-finite explicit-mesh UV derivation", () => {
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [
            {
              id: "root",
              type: "group",
              children: [
                {
                  id: "s",
                  type: "sprite",
                  rect: [0, 0, Number.MIN_VALUE, 1],
                  mesh: { type: "explicit", points: [[1, 0]], tris: [] },
                },
              ],
            },
          ],
        }),
      },
      "bad_shape",
    );
  });

  it.each([
    [0, 10],
    [10, 0],
    [-1, 10],
    [10, -1],
  ])("rejects a warp rect with non-positive dimensions (%s × %s)", (width, height) => {
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [
            {
              id: "root",
              type: "group",
              children: [{ id: "w", type: "warp", rect: [0, 0, width, height], cols: 1, rows: 1 }],
            },
          ],
        }),
      },
      "bad_shape",
    );
  });

  it("applies sprite defaults (texture=id, z=0, opacity=1, blend=normal, 1×1 grid)", () => {
    const m = load({
      rig: minimalRig({
        nodes: [
          {
            id: "root",
            type: "group",
            children: [{ id: "s", type: "sprite", rect: [0, 0, 8, 8] }],
          },
        ],
      }),
    });
    const s = m.sprites[0]!;
    expect(s.texture).toBe("s");
    expect(s.z).toBe(0);
    expect(s.opacity).toBe(1);
    expect(s.blend).toBe("normal");
    expect(s.mesh).toEqual({ type: "grid", cols: 1, rows: 1 });
  });

  it("resolves mask sources and rejects recursion (§8.4)", () => {
    const nodes = [
      {
        id: "root",
        type: "group",
        children: [
          { id: "a", type: "sprite", rect: [0, 0, 8, 8], mask: { mode: "alpha", sources: ["b"] } },
          { id: "b", type: "sprite", rect: [0, 0, 8, 8], mask: { mode: "alpha", sources: ["a"] } },
        ],
      },
    ];
    expectLoadError({ rig: minimalRig({ nodes }) }, "recursive_mask");
  });

  it("rejects a mask source that is not a sprite", () => {
    const nodes = [
      {
        id: "root",
        type: "group",
        children: [
          {
            id: "a",
            type: "sprite",
            rect: [0, 0, 8, 8],
            mask: { mode: "alpha", sources: ["root"] },
          },
        ],
      },
    ];
    expectLoadError({ rig: minimalRig({ nodes }) }, "bad_reference");
  });

  it("bounds and de-duplicates each mask source list", () => {
    const source = { id: "source", type: "sprite", rect: [0, 0, 8, 8] };
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [
            {
              id: "root",
              type: "group",
              children: [
                source,
                {
                  id: "clipped",
                  type: "sprite",
                  rect: [0, 0, 8, 8],
                  mask: { mode: "alpha", sources: ["source", "source"] },
                },
              ],
            },
          ],
        }),
      },
      "bad_shape",
    );
    expectLoadError(
      {
        rig: minimalRig({
          nodes: [
            {
              id: "root",
              type: "group",
              children: [
                source,
                {
                  id: "clipped",
                  type: "sprite",
                  rect: [0, 0, 8, 8],
                  mask: { mode: "alpha", sources: new Array(257).fill("source") },
                },
              ],
            },
          ],
        }),
      },
      "limit_exceeded",
    );
  });
});

describe("loadModel — bindings (§7)", () => {
  const rigWithRotator = (bindings: unknown[]) =>
    minimalRig({
      params: [{ id: "p", min: -30, max: 30, default: 0 }],
      nodes: [
        {
          id: "root",
          type: "group",
          children: [{ id: "rot", type: "rotator", pivot: [0, 0], children: [] }],
        },
      ],
      bindings,
    });

  it("rejects a property that does not apply to the target type", () => {
    expectLoadError(
      {
        rig: rigWithRotator([
          { target: "rot", property: "grid", params: ["p"], axes: [[0]], values: [[[0, 0]]] },
        ]),
      },
      "bad_binding",
    );
  });

  it("rejects prototype-named properties as typed binding errors", () => {
    for (const property of ["constructor", "toString", "__proto__"]) {
      expectLoadError(
        {
          rig: rigWithRotator([
            { target: "rot", property, params: ["p"], axes: [[0]], values: [0] },
          ]),
        },
        "bad_binding",
      );
    }
  });

  it("rejects a model above the aggregate binding ceiling", () => {
    const binding = {
      target: "rot",
      property: "angle",
      params: ["p"],
      axes: [[0]],
      values: [0],
    };
    expectLoadError({ rig: rigWithRotator(new Array(100_001).fill(binding)) }, "limit_exceeded");
  });

  it("rejects non-increasing axes", () => {
    expectLoadError(
      {
        rig: rigWithRotator([
          { target: "rot", property: "angle", params: ["p"], axes: [[0, 0]], values: [0, 0] },
        ]),
      },
      "bad_binding",
    );
  });

  it("rejects the max endpoint on a wrapping axis because its range is half-open", () => {
    const rig = minimalRig({
      params: [{ id: "turn", min: 0, max: 360, default: 360, wrap: true }],
      nodes: [
        {
          id: "root",
          type: "group",
          children: [{ id: "rot", type: "rotator", pivot: [0, 0], children: [] }],
        },
      ],
      bindings: [
        {
          target: "rot",
          property: "angle",
          params: ["turn"],
          axes: [[0, 180, 360]],
          values: [0, 180, 0],
        },
      ],
    });
    expectLoadError({ rig }, "bad_binding");
    expect(() => load({ rig })).toThrow(/half-open range/);
  });

  it("rejects a values count that mismatches the axes product", () => {
    expectLoadError(
      {
        rig: rigWithRotator([
          { target: "rot", property: "angle", params: ["p"], axes: [[-30, 0, 30]], values: [0, 1] },
        ]),
      },
      "bad_binding",
    );
  });

  it("rejects grid deltas whose length mismatches the warp declaration (§5.4)", () => {
    expectLoadError(
      {
        rig: minimalRig({
          params: [{ id: "p", min: 0, max: 1, default: 0 }],
          nodes: [
            {
              id: "root",
              type: "group",
              children: [{ id: "w", type: "warp", rect: [0, 0, 10, 10], cols: 2, rows: 1 }],
            },
          ],
          bindings: [
            // (2+1)×(1+1) = 6 control points required; give 4.
            {
              target: "w",
              property: "grid",
              params: ["p"],
              axes: [[0, 1]],
              values: [
                [
                  [0, 0],
                  [0, 0],
                  [0, 0],
                  [0, 0],
                ],
                [
                  [0, 0],
                  [0, 0],
                  [0, 0],
                  [0, 0],
                ],
              ],
            },
          ],
        }),
      },
      "bad_binding",
    );
  });

  it("rejects an undeclared param reference", () => {
    expectLoadError(
      {
        rig: rigWithRotator([
          { target: "rot", property: "angle", params: ["ghost"], axes: [[0]], values: [0] },
        ]),
      },
      "bad_reference",
    );
  });
});

describe("loadModel — expressions (§10.1)", () => {
  it("rejects negative fade durations instead of repairing them", () => {
    expectLoadError(
      {
        rig: minimalRig({ params: [{ id: "p", min: 0, max: 1, default: 0 }] }),
        expressions: {
          "expressions/e.exp.json": {
            id: "e",
            fade_in: -1,
            params: [{ id: "p", value: 1, blend: "overwrite" }],
          },
        },
      },
      "bad_expression",
    );
  });

  it("rejects duplicate parameter targets within one expression", () => {
    expectLoadError(
      {
        rig: minimalRig({ params: [{ id: "p", min: 0, max: 1, default: 0 }] }),
        expressions: {
          "expressions/e.exp.json": {
            id: "e",
            params: [
              { id: "p", value: 0.25, blend: "overwrite" },
              { id: "p", value: 0.75, blend: "add" },
            ],
          },
        },
      },
      "bad_expression",
    );
  });
});

describe("loadModel — motions (§10.2)", () => {
  it("rejects duplicate tracks targeting one parameter", () => {
    expectLoadError(
      {
        manifest: manifest({ capabilities: ["motion"] }),
        rig: minimalRig({ params: [{ id: "p", min: 0, max: 1, default: 0 }] }),
        motions: {
          "motions/m.motion.json": {
            id: "m",
            duration: 1,
            tracks: [
              { param: "p", keys: [{ t: 0, v: 0 }] },
              { param: "p", keys: [{ t: 0, v: 1 }] },
            ],
          },
        },
      },
      "bad_motion",
    );
  });
});

describe("loadModel — physics (§9)", () => {
  it("rejects a positive fps whose timestep arithmetic is not finite", () => {
    for (const fps of [Number.MIN_VALUE, 1e-200]) {
      expectLoadError(
        {
          manifest: manifest({ capabilities: ["physics"] }),
          physics: { fps, chains: [] },
        },
        "bad_physics",
      );
    }
  });
  it("rejects physics fps above the §16 ceiling", () => {
    expectLoadError(
      {
        manifest: manifest({ capabilities: ["physics"] }),
        physics: { fps: 241, chains: [] },
      },
      "limit_exceeded",
    );
  });

  it("rejects multiple overwrite outputs targeting one parameter", () => {
    const chain = (id: string) => ({
      id,
      inputs: [],
      links: [{ length: 10, damping: 0, stiffness: 0 }],
      outputs: [{ link: 0, param: "out", blend: "overwrite" }],
    });
    expectLoadError(
      {
        manifest: manifest({ capabilities: ["physics"] }),
        rig: minimalRig({ params: [{ id: "out", min: -90, max: 90, default: 0 }] }),
        physics: { fps: 60, chains: [chain("a"), chain("b")] },
      },
      "bad_physics",
    );
  });
});

describe("loadModel — atlas (§3.2, §8.3)", () => {
  it("rejects fractional and empty atlas texel rectangles", () => {
    expectLoadError({ atlas: { image: "atlas.png", rects: { s: [0.5, 0, 8, 8] } } }, "bad_atlas");
    expectLoadError({ atlas: { image: "atlas.png", rects: { s: [0, 0, 0, 8] } } }, "bad_atlas");
  });

  it("ignores $ annotations but treats x_ keys as texture ids", () => {
    const m = load({
      atlas: {
        image: "atlas.png",
        rects: {
          $note: { authored_by: "rigging harness" },
          x_vendor_texture: [1, 2, 3, 4],
        },
      },
    });
    expect([...m.atlas!.rects]).toEqual([["x_vendor_texture", [1, 2, 3, 4]]]);
    expectLoadError(
      { atlas: { image: "atlas.png", rects: { x_vendor_texture: { extension: true } } } },
      "bad_shape",
    );
  });

  it("applies the id-length ceiling to atlas texture keys", () => {
    expectLoadError(
      { atlas: { image: "atlas.png", rects: { [`a${"b".repeat(128)}`]: [0, 0, 1, 1] } } },
      "limit_exceeded",
    );
  });
});

describe("loadModel — variants (§10.3)", () => {
  it("rejects a node under two different slots", () => {
    expectLoadError(
      {
        manifest: manifest({ capabilities: ["variants"] }),
        rig: minimalRig({
          nodes: [{ id: "root", type: "group", children: [{ id: "shared", type: "group" }] }],
        }),
        variants: {
          slots: [
            { id: "a", default: "x", options: [{ id: "x", nodes: ["shared"] }] },
            { id: "b", default: "y", options: [{ id: "y", nodes: ["shared"] }] },
          ],
        },
      },
      "bad_variants",
    );
  });

  it("accepts a node shared by two options of the same slot", () => {
    const m = load({
      manifest: manifest({ capabilities: ["variants"] }),
      rig: minimalRig({
        nodes: [{ id: "root", type: "group", children: [{ id: "collar", type: "group" }] }],
      }),
      variants: {
        slots: [
          {
            id: "outfit",
            default: "a",
            options: [
              { id: "a", nodes: ["collar"] },
              { id: "b", nodes: ["collar"] },
            ],
          },
        ],
      },
    });
    expect(m.variantSlots[0]!.options).toHaveLength(2);
  });

  it("rejects variants shipped without the capability", () => {
    expectLoadError({ variants: { slots: [] } }, "unsupported_capability");
  });
});
