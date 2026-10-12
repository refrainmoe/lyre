import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { allSchemas, schemasByKind, type SchemaKind } from "../src/index.js";

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
for (const schema of allSchemas) ajv.addSchema(schema);

function check(kind: SchemaKind, data: unknown): { valid: boolean; errors: string } {
  const validate = ajv.getSchema((schemasByKind[kind] as { $id: string }).$id);
  if (!validate) throw new Error(`schema not registered: ${kind}`);
  const valid = validate(data) as boolean;
  return { valid, errors: ajv.errorsText(validate.errors) };
}

function expectValid(kind: SchemaKind, data: unknown) {
  const { valid, errors } = check(kind, data);
  expect(valid, errors).toBe(true);
}

function expectInvalid(kind: SchemaKind, data: unknown) {
  const { valid } = check(kind, data);
  expect(valid).toBe(false);
}

describe("manifest.schema.json", () => {
  // §3.1 example, verbatim.
  const specExample = {
    lyre: "0.1",
    id: "example_v1",
    name: "Example Model",
    canvas: { width: 2048, height: 3072, origin: [1024, 1536] },
    capabilities: ["core", "physics", "motion", "variants"],
    files: {
      rig: "rig.json",
      physics: "physics.json",
      variants: "variants.json",
      expressions: ["expressions/smile.exp.json"],
      motions: ["motions/idle.motion.json"],
    },
    author: "…",
    $note: "Rigged automatically from source.psd.",
  };

  it("accepts the spec example", () => expectValid("manifest", specExample));

  it("accepts unknown keys and x_ vendor keys (§2 forward compatibility)", () =>
    expectValid("manifest", { ...specExample, future_key: 1, x_vendor: { a: 1 } }));

  it("rejects a missing spec version", () =>
    expectInvalid("manifest", { ...specExample, lyre: undefined }));

  it("rejects a malformed spec version", () =>
    expectInvalid("manifest", { ...specExample, lyre: "0.1.3" }));

  it("rejects a canvas without origin", () =>
    expectInvalid("manifest", {
      ...specExample,
      canvas: { width: 2048, height: 3072 },
    }));

  it("rejects canvas dimensions over the §16 ceiling", () =>
    expectInvalid("manifest", {
      ...specExample,
      canvas: { width: 20000, height: 100, origin: [0, 0] },
    }));

  it("rejects an uppercase model id", () =>
    expectInvalid("manifest", { ...specExample, id: "Uppercase" }));

  it("rejects empty manifest file paths", () => {
    expectInvalid("manifest", {
      ...specExample,
      files: { ...specExample.files, rig: "" },
    });
    expectInvalid("manifest", {
      ...specExample,
      files: { ...specExample.files, motions: [""] },
    });
  });

  it("rejects duplicate manifest file-list entries", () =>
    expectInvalid("manifest", {
      ...specExample,
      files: {
        ...specExample.files,
        expressions: ["expressions/smile.exp.json", "expressions/smile.exp.json"],
      },
    }));
});

describe("rig.schema.json", () => {
  const minimalSprite = {
    id: "eye_l_iris",
    type: "sprite",
    rect: [812, 640, 180, 180],
    z: 340,
    opacity: 1.0,
    blend: "normal",
    mesh: { type: "grid", cols: 1, rows: 1 },
    mask: { mode: "alpha", sources: ["eye_l_white"] },
  };

  const rig = {
    params: [
      { id: "Lyre.AngleX", min: -30, max: 30, default: 0, $note: "head yaw" },
      { id: "hair_ribbon_bounce", min: 0, max: 1, default: 0 },
      { id: "pinwheel_spin", min: 0, max: 360, default: 0, wrap: true },
    ],
    nodes: [
      {
        id: "root",
        type: "group",
        children: [
          {
            id: "head_rot",
            type: "rotator",
            pivot: [0, -820],
            angle: 0,
            scale: 1.0,
            children: [
              {
                id: "hair_front_warp",
                type: "warp",
                rect: [640, 120, 800, 900],
                cols: 4,
                rows: 6,
                children: [minimalSprite],
              },
            ],
          },
        ],
      },
    ],
    bindings: [
      {
        target: "head_rot",
        property: "angle",
        params: ["Lyre.AngleX"],
        axes: [[-30, 0, 30]],
        values: [-22, 0, 22],
        $note: "head yaw follows AngleX nearly 1:1",
      },
      {
        target: "hair_front_warp",
        property: "grid",
        params: ["Lyre.AngleX", "hair_ribbon_bounce"],
        axes: [
          [-30, 0, 30],
          [0, 1],
        ],
        values: [[[0, 0]], [[0, 0]], [[0, 0]], [[0, 0]], [[0, 0]], [[1, -2]]],
      },
    ],
  };

  it("accepts a representative rig assembled from the spec examples", () =>
    expectValid("rig", rig));

  it("accepts the implicit grid mesh defaults from §5.4", () =>
    expectValid("rig", {
      ...rig,
      nodes: [
        {
          id: "root",
          type: "group",
          children: [
            { id: "mesh_omitted", type: "sprite", rect: [0, 0, 10, 10] },
            { id: "grid_type_omitted", type: "sprite", rect: [0, 0, 10, 10], mesh: {} },
            {
              id: "grid_size_partial",
              type: "sprite",
              rect: [0, 0, 10, 10],
              mesh: { cols: 2 },
            },
          ],
        },
      ],
    }));

  it("accepts an explicit mesh (§5.4 escape hatch)", () =>
    expectValid("rig", {
      ...rig,
      nodes: [
        {
          id: "root",
          type: "group",
          children: [
            {
              id: "imported",
              type: "sprite",
              rect: [0, 0, 10, 10],
              mesh: {
                type: "explicit",
                points: [
                  [0, 0],
                  [10, 0],
                  [0, 10],
                ],
                tris: [[0, 1, 2]],
              },
            },
          ],
        },
      ],
    }));

  it("rejects a second root node (§5: exactly one root)", () =>
    expectInvalid("rig", {
      ...rig,
      nodes: [rig.nodes[0], { id: "second_root", type: "group" }],
    }));

  it("rejects a sprite root (root must be a group)", () =>
    expectInvalid("rig", { ...rig, nodes: [minimalSprite] }));

  it("rejects an unknown node type (§2: load error)", () =>
    expectInvalid("rig", {
      ...rig,
      nodes: [
        { id: "root", type: "group", children: [{ id: "b", type: "bone", rect: [0, 0, 1, 1] }] },
      ],
    }));

  it("rejects a sprite without rect", () =>
    expectInvalid("rig", {
      ...rig,
      nodes: [{ id: "root", type: "group", children: [{ id: "s", type: "sprite" }] }],
    }));

  it("rejects a sprite with children (§5: MUST be absent/empty)", () =>
    expectInvalid("rig", {
      ...rig,
      nodes: [
        {
          id: "root",
          type: "group",
          children: [
            {
              id: "s",
              type: "sprite",
              rect: [0, 0, 1, 1],
              children: [{ id: "t", type: "sprite", rect: [0, 0, 1, 1] }],
            },
          ],
        },
      ],
    }));

  it("rejects warp cols over the §16 ceiling of 64", () =>
    expectInvalid("rig", {
      ...rig,
      nodes: [
        {
          id: "root",
          type: "group",
          children: [{ id: "w", type: "warp", rect: [0, 0, 1, 1], cols: 65, rows: 4 }],
        },
      ],
    }));

  it("rejects zero-sized warp rectangles (§5.5)", () => {
    const withWarpRect = (rect: number[]) => ({
      params: [],
      nodes: [
        {
          id: "root",
          type: "group",
          children: [{ id: "w", type: "warp", rect, cols: 1, rows: 1 }],
        },
      ],
      bindings: [],
    });
    expectInvalid("rig", withWarpRect([0, 0, 0, 1]));
    expectInvalid("rig", withWarpRect([0, 0, 1, 0]));
  });

  it("rejects a param missing its default", () =>
    expectInvalid("rig", {
      ...rig,
      params: [{ id: "p", min: 0, max: 1 }],
    }));

  it("rejects a binding with more than 3 params (§16)", () =>
    expectInvalid("rig", {
      ...rig,
      bindings: [
        {
          target: "head_rot",
          property: "angle",
          params: ["a", "b", "c", "d"],
          axes: [[0], [0], [0], [0]],
          values: [0],
        },
      ],
    }));

  it("rejects a binding axis with more than 33 keys (§16)", () =>
    expectInvalid("rig", {
      ...rig,
      bindings: [
        {
          target: "head_rot",
          property: "angle",
          params: ["Lyre.AngleX"],
          axes: [Array.from({ length: 34 }, (_, i) => i)],
          values: Array.from({ length: 34 }, () => 0),
        },
      ],
    }));

  it("rejects more than 100,000 aggregate bindings (§16)", () =>
    expectInvalid("rig", {
      ...rig,
      bindings: new Array(100_001).fill(rig.bindings[0]),
    }));

  it("rejects more than 131,072 explicit triangles (§16)", () =>
    expectInvalid("rig", {
      ...rig,
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
    }));

  it("rejects a dotted non-registry param id", () =>
    expectInvalid("rig", {
      ...rig,
      params: [{ id: "my.param", min: 0, max: 1, default: 0 }],
    }));
});

describe("physics.schema.json", () => {
  // §9 example, verbatim.
  const specExample = {
    fps: 60,
    chains: [
      {
        id: "hair_back",
        inputs: [
          { param: "Lyre.AngleX", type: "x", weight: 10 },
          { param: "Lyre.AngleZ", type: "angle", weight: 0.6 },
        ],
        links: [
          { length: 120, damping: 0.1, stiffness: 0.06 },
          { length: 140, damping: 0.12, stiffness: 0.03 },
        ],
        gravity: [0, 900],
        wind: [0, 0],
        outputs: [
          { link: 0, param: "hair_back_sway1", multiplier: 1.0, blend: "overwrite" },
          { link: 1, param: "hair_back_sway2", multiplier: 1.2, blend: "overwrite" },
        ],
      },
    ],
  };

  it("accepts the spec example", () => expectValid("physics", specExample));

  it("rejects a zero-length link", () =>
    expectInvalid("physics", {
      fps: 60,
      chains: [
        {
          id: "c",
          inputs: [],
          links: [{ length: 0, damping: 0.1, stiffness: 0.1 }],
          outputs: [],
        },
      ],
    }));

  it("rejects an unknown input type", () =>
    expectInvalid("physics", {
      fps: 60,
      chains: [
        {
          id: "c",
          inputs: [{ param: "p", type: "z", weight: 1 }],
          links: [{ length: 1, damping: 0, stiffness: 0 }],
          outputs: [],
        },
      ],
    }));

  it("rejects more than 64 links per chain (§16)", () =>
    expectInvalid("physics", {
      fps: 60,
      chains: [
        {
          id: "c",
          inputs: [],
          links: Array.from({ length: 65 }, () => ({ length: 1, damping: 0, stiffness: 0 })),
          outputs: [],
        },
      ],
    }));

  it("rejects physics fps above 240 (§16)", () =>
    expectInvalid("physics", { ...specExample, fps: 241 }));
});

describe("variants.schema.json", () => {
  // §10.3 example, verbatim.
  const specExample = {
    slots: [
      {
        id: "outfit",
        default: "school",
        options: [
          { id: "school", nodes: ["outfit_school"] },
          { id: "casual", nodes: ["outfit_casual"] },
        ],
      },
      {
        id: "glasses",
        default: "none",
        options: [
          { id: "none", nodes: [] },
          { id: "round", nodes: ["glasses_round"] },
        ],
      },
    ],
  };

  it("accepts the spec example", () => expectValid("variants", specExample));

  it("rejects a slot without options", () =>
    expectInvalid("variants", { slots: [{ id: "s", default: "a", options: [] }] }));

  it("rejects an option without nodes", () =>
    expectInvalid("variants", { slots: [{ id: "s", default: "a", options: [{ id: "a" }] }] }));
});

describe("expression.schema.json", () => {
  // §10.1 example, verbatim.
  const specExample = {
    id: "smile",
    fade_in: 0.3,
    fade_out: 0.3,
    params: [
      { id: "Lyre.MouthForm", value: 1.0, blend: "overwrite" },
      { id: "Lyre.EyeLOpen", value: 0.2, blend: "multiply" },
    ],
  };

  it("accepts the spec example", () => expectValid("expression", specExample));

  it("rejects an unknown blend mode", () =>
    expectInvalid("expression", {
      id: "e",
      params: [{ id: "p", value: 1, blend: "screen" }],
    }));

  it("rejects a negative fade", () =>
    expectInvalid("expression", { id: "e", fade_in: -1, params: [] }));
});

describe("motion.schema.json", () => {
  // §10.2 example, verbatim.
  const specExample = {
    id: "idle",
    duration: 4.0,
    loop: true,
    tracks: [
      {
        param: "Lyre.Breath",
        keys: [
          { t: 0.0, v: 0.0 },
          { t: 2.0, v: 1.0, ease: "bezier", cp: [0.4, 0.0, 0.6, 1.0] },
          { t: 4.0, v: 0.0, ease: "bezier", cp: [0.4, 0.0, 0.6, 1.0] },
        ],
      },
    ],
  };

  it("accepts the spec example", () => expectValid("motion", specExample));

  it("rejects bezier control points with x outside [0,1] (§10.2)", () =>
    expectInvalid("motion", {
      id: "m",
      duration: 1,
      tracks: [
        {
          param: "p",
          keys: [
            { t: 0, v: 0 },
            { t: 1, v: 1, ease: "bezier", cp: [1.5, 0, 0.5, 1] },
          ],
        },
      ],
    }));

  it("allows bezier y control points outside [0,1] (overshoot)", () =>
    expectValid("motion", {
      id: "m",
      duration: 1,
      tracks: [
        {
          param: "p",
          keys: [
            { t: 0, v: 0 },
            { t: 1, v: 1, ease: "bezier", cp: [0.4, -0.6, 0.6, 1.8] },
          ],
        },
      ],
    }));

  it("rejects a bezier key without cp", () =>
    expectInvalid("motion", {
      id: "m",
      duration: 1,
      tracks: [
        {
          param: "p",
          keys: [
            { t: 0, v: 0 },
            { t: 1, v: 1, ease: "bezier" },
          ],
        },
      ],
    }));

  it("rejects a zero duration", () =>
    expectInvalid("motion", { id: "m", duration: 0, tracks: [] }));
});

describe("atlas.schema.json", () => {
  it("accepts a minimal atlas", () =>
    expectValid("atlas", {
      image: "atlas.png",
      rects: { eye_l_iris: [2, 2, 180, 180], eye_r_iris: [186, 2, 180, 180] },
    }));

  it("rejects a rect with the wrong arity", () =>
    expectInvalid("atlas", { image: "atlas.png", rects: { a: [0, 0, 1] } }));

  it("rejects a non-id texture key", () =>
    expectInvalid("atlas", { image: "atlas.png", rects: { "Bad-Key": [0, 0, 1, 1] } }));

  it("rejects fractional, negative-origin, and empty texel rectangles", () => {
    expectInvalid("atlas", { image: "atlas.png", rects: { a: [0.5, 0, 1, 1] } });
    expectInvalid("atlas", { image: "atlas.png", rects: { a: [-1, 0, 1, 1] } });
    expectInvalid("atlas", { image: "atlas.png", rects: { a: [0, 0, 0, 1] } });
  });

  it("ignores $ annotations while treating x_ keys as texture ids", () => {
    expectValid("atlas", {
      image: "atlas.png",
      rects: { $note: { source: "packer" }, x_vendor_texture: [0, 0, 1, 1] },
    });
    expectInvalid("atlas", {
      image: "atlas.png",
      rects: { x_vendor_extension: { arbitrary: true } },
    });
  });
});
