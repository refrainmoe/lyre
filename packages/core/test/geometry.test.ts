import { describe, expect, it } from "vitest";
import {
  applyRotator,
  applyWarp,
  buildMesh,
  createRuntime,
  hitTestGeometry,
  loadModel,
  RUNTIME_LIMITS,
  roundEffectiveZ,
  warpRestPoints,
  type ModelFiles,
} from "../src/index.js";

// Canvas 256×256 with origin at [0, 0] so model space == canvas space in
// these tests, keeping expectations easy to hand-compute.
function makeModel(
  nodes: unknown[],
  bindings: unknown[] = [],
  params: unknown[] = [],
  extra: Partial<ModelFiles> = {},
) {
  const indexed: Record<string, unknown> = { rig: "rig.json" };
  if (extra.physics !== undefined) indexed.physics = "physics.json";
  if (extra.variants !== undefined) indexed.variants = "variants.json";
  if (extra.atlas !== undefined) indexed.atlas = "atlas.json";
  const expressions = Object.keys(extra.expressions ?? {});
  if (expressions.length > 0) indexed.expressions = expressions;
  const motions = Object.keys(extra.motions ?? {});
  if (motions.length > 0) indexed.motions = motions;
  return loadModel({
    manifest: {
      lyre: "0.1",
      id: "geom_test",
      canvas: { width: 256, height: 256, origin: [0, 0] },
      capabilities: ["variants"],
      files: indexed,
    },
    rig: { params, nodes: [{ id: "root", type: "group", children: nodes }], bindings },
    ...extra,
  });
}

describe("buildMesh (§5.4)", () => {
  it("derives the 2×1 grid deterministically, row-major from top-left", () => {
    const m = makeModel([
      {
        id: "s",
        type: "sprite",
        rect: [10, 20, 100, 50],
        mesh: { type: "grid", cols: 2, rows: 1 },
      },
    ]);
    const mesh = buildMesh(m.sprites[0]!);
    // (2+1)×(1+1) = 6 control points.
    expect(Array.from(mesh.points)).toEqual([
      10,
      20,
      60,
      20,
      110,
      20, // top row
      10,
      70,
      60,
      70,
      110,
      70, // bottom row
    ]);
    // Two cells × two triangles along the ↘ diagonal.
    expect(Array.from(mesh.indices)).toEqual([0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4]);
    expect(Array.from(mesh.uvs)).toEqual([0, 0, 0.5, 0, 1, 0, 0, 1, 0.5, 1, 1, 1]);
  });

  it("keeps large finite explicit-mesh UVs in double precision", () => {
    const m = makeModel([
      {
        id: "s",
        type: "sprite",
        rect: [0, 0, 1e-300, 1],
        mesh: { type: "explicit", points: [[1, 0]], tris: [] },
      },
    ]);
    const u = buildMesh(m.sprites[0]!).uvs[0]!;
    expect(Number.isFinite(u)).toBe(true);
    expect(u).toBeGreaterThan(1e299);
  });
});

describe("rotator math (§8.2)", () => {
  it("rotates clockwise (viewer) under +y down: right → down at 90°", () => {
    const p = Float64Array.of(1, 0);
    applyRotator({ cx: 0, cy: 0, tx: 0, ty: 0, angle: 90, scale: 1 }, p);
    expect(p[0]).toBeCloseTo(0, 12);
    expect(p[1]).toBeCloseTo(1, 12);
  });

  it("scales about the pivot", () => {
    const p = Float64Array.of(12, 8);
    applyRotator({ cx: 10, cy: 10, tx: 0, ty: 0, angle: 0, scale: 2 }, p);
    expect(Array.from(p)).toEqual([14, 6]);
  });

  it("maps the rest pivot through pivot_offset and translates the whole subtree", () => {
    const p = Float64Array.of(12, 8, 10, 10);
    applyRotator({ cx: 10, cy: 10, tx: 3, ty: -4, angle: 0, scale: 1 }, p);
    expect(Array.from(p)).toEqual([15, 4, 13, 6]);
  });

  it("keeps an identity rotator exact even when its pivot is far away", () => {
    const p = Float64Array.of(0.1, -0.2, 10.3, 20.4);
    const before = Array.from(p);
    applyRotator({ cx: 1e12, cy: -1e12, tx: 0, ty: 0, angle: 0, scale: 1 }, p);
    expect(Array.from(p)).toEqual(before);
  });

  it("composes nested rotators nearest-ancestor-first (§8.1 step 4)", () => {
    // Outer rotates 90° about (0,0); inner rotates 90° about (10,0).
    // Point at (11,0): inner first → (10,1); outer → (-1,10).
    const m = makeModel(
      [
        {
          id: "outer",
          type: "rotator",
          pivot: [0, 0],
          children: [
            {
              id: "inner",
              type: "rotator",
              pivot: [10, 0],
              children: [{ id: "s", type: "sprite", rect: [11, 0, 0, 0] }],
            },
          ],
        },
      ],
      [
        { target: "outer", property: "angle", params: ["turn"], axes: [[0, 1]], values: [0, 90] },
        { target: "inner", property: "angle", params: ["turn"], axes: [[0, 1]], values: [0, 90] },
      ],
      [{ id: "turn", min: 0, max: 1, default: 0 }],
    );
    const rt = createRuntime(m);
    rt.setParam("turn", 1);
    const frame = rt.evaluate();
    const pos = frame.drawList[0]!.positions;
    // All four mesh corners coincide (0-size rect) at the mapped point.
    expect(pos[0]).toBeCloseTo(-1, 10);
    expect(pos[1]).toBeCloseTo(10, 10);
  });
});

describe("warp mapping (§5.5)", () => {
  const rect = [0, 0, 100, 100] as const;

  it("is the identity at rest", () => {
    const state = { rect, cols: 4, rows: 4, points: warpRestPoints(rect, 4, 4) };
    const p = Float64Array.of(33, 71);
    applyWarp(state, p);
    expect(Array.from(p)).toEqual([33, 71]);
  });

  it("preserves the exact identity outside the rect and across mesh diagonals", () => {
    const overhangRect = [50, 50, 60, 60] as const;
    const state = {
      rect: overhangRect,
      cols: 2,
      rows: 2,
      points: warpRestPoints(overhangRect, 2, 2),
    };
    const p = Float64Array.of(30, 30, 40, 40, 50, 50, 90, 90, 120, 120, 130, 130);
    const before = Array.from(p);
    applyWarp(state, p);
    expect(Array.from(p)).toEqual(before);
  });

  it("preserves rest identity when subnormal dimensions overflow normalized coordinates", () => {
    const subnormalRect = [0, 0, Number.MIN_VALUE, Number.MIN_VALUE] as const;
    const state = {
      rect: subnormalRect,
      cols: 1,
      rows: 1,
      points: warpRestPoints(subnormalRect, 1, 1),
    };
    const p = Float64Array.of(1e12, -1e12);
    applyWarp(state, p);
    expect(Array.from(p)).toEqual([1e12, -1e12]);
  });

  it("interpolates a displaced control point bilinearly", () => {
    // 1×1 warp: pin the four corners; displace bottom-right by (+10, +20).
    const points = warpRestPoints(rect, 1, 1);
    points[6] += 10; // bottom-right x
    points[7] += 20; // bottom-right y
    const state = { rect, cols: 1, rows: 1, points };
    const p = Float64Array.of(50, 50); // centre: weight 0.25 on each corner
    applyWarp(state, p);
    expect(p[0]).toBeCloseTo(52.5, 12);
    expect(p[1]).toBeCloseTo(55, 12);
  });

  it("extrapolates outside the rect via the clamped cell's bilinear function", () => {
    // 2×2 warp with the whole right column shifted +10 in x. A point at
    // x=150 (one rect-width right of the rect) extrapolates the right cell.
    const points = warpRestPoints(rect, 2, 2);
    for (let row = 0; row < 3; row++) {
      const i = (row * 3 + 2) * 2; // right column
      points[i] += 10;
    }
    const state = { rect, cols: 2, rows: 2, points };
    const p = Float64Array.of(150, 50);
    // fx = 3, clamped cell cx=1, u=2: bilinear in x over [50,100+10]:
    // x(u) = 50 + u·(110−50) = 50 + 2·60 = 170.
    applyWarp(state, p);
    expect(p[0]).toBeCloseTo(170, 12);
    expect(p[1]).toBeCloseTo(50, 12);
  });

  it("diagonally outside a corner selects the corner cell", () => {
    const points = warpRestPoints(rect, 2, 2);
    // displace bottom-right control point (only affects the corner cell)
    points[16] += 40; // point (2,2) x
    const state = { rect, cols: 2, rows: 2, points };
    const p = Float64Array.of(125, 125); // fx = fy = 2.5 → cell (1,1), u=v=1.5
    applyWarp(state, p);
    // Corner cell spans [50,100]²; bilinear with only C11 displaced by 40:
    // x = 50 + 50u + 40·u·v = 50 + 75 + 90 = 215
    expect(p[0]).toBeCloseTo(215, 12);
    // y = 50 + 50v = 125 (C11 y undisplaced)
    expect(p[1]).toBeCloseTo(125, 12);
  });

  it("does not erase a small grid delta attached to a large rest coordinate", () => {
    const model = makeModel(
      [
        {
          id: "far_warp",
          type: "warp",
          rect: [1e12, 0, 1, 1],
          cols: 1,
          rows: 1,
          children: [{ id: "probe", type: "sprite", rect: [0, 0, 0, 0] }],
        },
      ],
      [
        {
          target: "far_warp",
          property: "grid",
          params: ["shift"],
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
              [1e-6, 0],
              [0, 0],
              [1e-6, 0],
            ],
          ],
        },
      ],
      [{ id: "shift", min: 0, max: 1, default: 0 }],
    );
    const runtime = createRuntime(model);
    runtime.setParam("shift", 1);
    const x = runtime.evaluate().drawList[0]!.positions[0]!;

    // The probe is 10^12 pixels to the left of the 1px warp. Extrapolating
    // the right-column delta gives u·1e-6 = -1e6. If runtime evaluation first
    // forms `1e12 + 1e-6`, the delta rounds away and the result incorrectly
    // remains zero.
    expect(x).toBeCloseTo(-1e6, 6);
  });
});

describe("draw order (§8.1 step 6)", () => {
  const sprite = (id: string, z: number) => ({ id, type: "sprite", rect: [0, 0, 8, 8], z });

  it("sorts globally with document-order tie-break", () => {
    const m = makeModel([
      { id: "ga", type: "group", children: [sprite("a", 10), sprite("b", 30)] },
      { id: "gb", type: "group", children: [sprite("c", 20), sprite("d", 30)] },
    ]);
    const rt = createRuntime(m);
    const order = rt.evaluate().drawList.map((d) => d.sprite.id);
    // z: a=10, c=20, b=30, d=30 (b before d in document order).
    expect(order).toEqual(["a", "c", "b", "d"]);
  });

  it("accumulates group z deltas and rounds once (§8.1.6)", () => {
    const m = makeModel(
      [
        {
          id: "g",
          type: "group",
          children: [{ id: "outerg", type: "group", children: [sprite("s", 0)] }],
        },
        sprite("ref", 1),
      ],
      [
        // Two fractional deltas on nested groups: 0.3 (g) + 0.3 (outerg).
        { target: "g", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 0.3] },
        { target: "outerg", property: "z", params: ["p"], axes: [[0, 1]], values: [0, 0.3] },
      ],
      [{ id: "p", min: 0, max: 1, default: 0 }],
    );
    const rt = createRuntime(m);
    rt.setParam("p", 1);
    const frame = rt.evaluate();
    const s = frame.drawList.find((d) => d.sprite.id === "s")!;
    // 0.3 + 0.3 = 0.6 accumulated as a real, rounded once → 1.
    // (Per-binding rounding would give 0 + 0 = 0.)
    expect(s.effectiveZ).toBe(1);
    // Tie with "ref" (z=1): document order puts "s" first.
    expect(frame.drawList.map((d) => d.sprite.id)).toEqual(["s", "ref"]);
  });

  it("rounds exact z half-ties toward positive infinity", () => {
    expect(roundEffectiveZ(0.5)).toBe(1);
    expect(roundEffectiveZ(-0.5)).toBe(0);
    expect(roundEffectiveZ(12.499999)).toBe(12);
    expect(roundEffectiveZ(-12.500001)).toBe(-13);
  });
});

describe("opacity (§7 rule 5, §8.1 step 5)", () => {
  it("multiplies factors unclamped, clamps once, then multiplies down the tree", () => {
    const m = makeModel(
      [
        {
          id: "g",
          type: "group",
          opacity: 0.5,
          children: [{ id: "s", type: "sprite", rect: [0, 0, 8, 8], opacity: 0.5 }],
        },
      ],
      [
        // Two factor bindings on the sprite: 4 × 0.6 = 2.4 → 0.5·2.4 = 1.2 → clamp 1.
        { target: "s", property: "opacity", params: ["p"], axes: [[0, 1]], values: [1, 4] },
        { target: "s", property: "opacity", params: ["p"], axes: [[0, 1]], values: [1, 0.6] },
      ],
      [{ id: "p", min: 0, max: 1, default: 0 }],
    );
    const rt = createRuntime(m);
    rt.setParam("p", 1);
    const item = rt.evaluate().drawList[0]!;
    // Sprite clamps to 1, group contributes 0.5 → effective 0.5.
    // Clamping factors per binding (1·0.6=0.6 → 0.5·0.6=0.3·0.5group=0.15) would differ.
    expect(item.opacity).toBeCloseTo(0.5, 12);
  });

  it("combines cancelling additive bindings independently of document order", () => {
    const binding = (value: number) => ({
      target: "s",
      property: "offset",
      params: ["p"],
      axes: [[0]],
      values: [[value, 0]],
    });
    const evaluate = (orderedValues: number[]) => {
      const model = makeModel(
        [{ id: "s", type: "sprite", rect: [0, 0, 0, 0] }],
        orderedValues.map(binding),
        [{ id: "p", min: 0, max: 1, default: 0 }],
      );
      return createRuntime(model).evaluate().drawList[0]!.positions[0]!;
    };

    // At magnitude 1e12, the small residual is below one ULP. A document-order
    // left fold loses it in the first permutation but not the second.
    const residual = 1e-5;
    const grouped = evaluate([1e12, residual, -1e12]);
    const cancelledFirst = evaluate([-1e12, 1e12, residual]);
    expect(grouped).toBe(cancelledFirst);
    expect(grouped).toBeCloseTo(residual, 12);
  });

  it("combines reciprocal factors without permutation-only overflow or underflow", () => {
    const binding = (value: number) => ({
      target: "s",
      property: "opacity",
      params: ["p"],
      axes: [[0]],
      values: [value],
    });
    const evaluate = (orderedValues: number[]) => {
      const model = makeModel(
        [{ id: "s", type: "sprite", rect: [0, 0, 1, 1] }],
        orderedValues.map(binding),
        [{ id: "p", min: 0, max: 1, default: 0 }],
      );
      return createRuntime(model).evaluate().drawList[0]!.opacity;
    };

    const grouped = [...new Array<number>(26).fill(1e12), ...new Array<number>(26).fill(1e-12)];
    const alternating = Array.from({ length: 26 }, () => [1e12, 1e-12]).flat();
    const groupedOpacity = evaluate(grouped);
    const alternatingOpacity = evaluate(alternating);
    expect(groupedOpacity).toBe(alternatingOpacity);
    expect(groupedOpacity).toBeCloseTo(1, 12);
  });
});

describe("variants exclusion (§10.3)", () => {
  const files = {
    variants: {
      slots: [
        {
          id: "outfit",
          default: "a",
          options: [
            { id: "a", nodes: ["outfit_a"] },
            { id: "b", nodes: ["outfit_b"] },
          ],
        },
      ],
    },
  };

  it("excludes non-active option subtrees and their bindings", () => {
    const m = makeModel(
      [
        {
          id: "outfit_a",
          type: "group",
          children: [{ id: "sa", type: "sprite", rect: [0, 0, 8, 8] }],
        },
        {
          id: "outfit_b",
          type: "group",
          children: [{ id: "sb", type: "sprite", rect: [0, 0, 8, 8] }],
        },
        { id: "always", type: "sprite", rect: [0, 0, 8, 8] },
      ],
      [],
      [],
      files,
    );
    const rt = createRuntime(m);
    expect(rt.evaluate().drawList.map((d) => d.sprite.id)).toEqual(["sa", "always"]);
    rt.setVariant("outfit", "b");
    expect(rt.evaluate().drawList.map((d) => d.sprite.id)).toEqual(["sb", "always"]);
  });

  it("drops excluded mask sources from the union", () => {
    const m = makeModel(
      [
        {
          id: "outfit_a",
          type: "group",
          children: [{ id: "sa", type: "sprite", rect: [0, 0, 8, 8] }],
        },
        { id: "outfit_b", type: "group", children: [] },
        {
          id: "clipped",
          type: "sprite",
          rect: [0, 0, 8, 8],
          mask: { mode: "alpha", sources: ["sa"] },
        },
      ],
      [],
      [],
      files,
    );
    const rt = createRuntime(m);
    let frame = rt.evaluate();
    expect(frame.maskGroups[0]!.sources.map((s) => s.sprite.id)).toEqual(["sa"]);
    rt.setVariant("outfit", "b");
    frame = rt.evaluate();
    const clipped = frame.drawList.find((d) => d.sprite.id === "clipped")!;
    expect(frame.maskGroups[clipped.mask!.group]!.sources).toEqual([]);
  });
});

describe("mask source ordering (§8.4)", () => {
  it("canonicalizes active sources by id instead of declaration or draw order", () => {
    const model = makeModel([
      { id: "source_c", type: "sprite", rect: [0, 0, 8, 8], z: 0 },
      { id: "source_a", type: "sprite", rect: [0, 0, 8, 8], z: 2 },
      { id: "source_b", type: "sprite", rect: [0, 0, 8, 8], z: 1 },
      {
        id: "clipped",
        type: "sprite",
        rect: [0, 0, 8, 8],
        z: 3,
        mask: { mode: "alpha", sources: ["source_c", "source_a", "source_b"] },
      },
    ]);

    const frame = createRuntime(model).evaluate();
    const clipped = frame.drawList.find((item) => item.sprite.id === "clipped")!;
    expect(
      frame.maskGroups[clipped.mask!.group]!.sources.map((source) => source.sprite.id),
    ).toEqual(["source_a", "source_b", "source_c"]);
  });
});

describe("hitTest (§11)", () => {
  it("hits deformed geometry, ignoring texture alpha, topmost first", () => {
    const m = makeModel([
      { id: "under", type: "sprite", rect: [0, 0, 20, 20], z: 1 },
      { id: "over", type: "sprite", rect: [10, 10, 20, 20], z: 2 },
    ]);
    const rt = createRuntime(m);
    rt.evaluate();
    expect(rt.hitTest(15, 15)).toEqual(["over", "under"]);
    expect(rt.hitTest(5, 5)).toEqual(["under"]);
    expect(rt.hitTest(100, 100)).toEqual([]);
    expect(() => rt.hitTest(Number.NaN, 0)).toThrow(/finite/);
  });

  it("does not treat a zero-area triangle as a hit", () => {
    const model = makeModel([
      {
        id: "flat",
        type: "sprite",
        rect: [0, 0, 10, 10],
        mesh: {
          type: "explicit",
          points: [
            [0, 0],
            [5, 0],
            [10, 0],
          ],
          tris: [[0, 1, 2]],
        },
      },
    ]);
    const runtime = createRuntime(model);
    runtime.evaluate();
    expect(runtime.hitTest(5, 0)).toEqual([]);
  });

  it("does not overflow edge tests for huge finite query coordinates", () => {
    const runtime = createRuntime(makeModel([{ id: "s", type: "sprite", rect: [0, 0, 10, 10] }]));
    runtime.evaluate();
    expect(runtime.hitTest(Number.MAX_VALUE, Number.MAX_VALUE)).toEqual([]);
  });

  it("preserves mixed-scale triangles while bounding orientation arithmetic", () => {
    expect(
      hitTestGeometry(
        Float64Array.of(0, 0, 1e308, 0, 0, 1e-300),
        Uint32Array.of(0, 1, 2),
        1,
        1e-301,
      ),
    ).toBe(true);
  });

  it("preserves subnormal edge detail in hit-test orientation", () => {
    expect(
      hitTestGeometry(
        Float64Array.of(0, 0, Number.MIN_VALUE, 0, 1e12, 1e12),
        Uint32Array.of(0, 1, 2),
        Number.MIN_VALUE,
        0,
      ),
    ).toBe(true);
  });

  it("skips repeated-index triangles without consuming exact-predicate work", () => {
    const triangleCount = RUNTIME_LIMITS.hitTestExactPredicatesPerQuery + 1;
    expect(hitTestGeometry(Float64Array.of(0, 0), new Uint32Array(triangleCount * 3), 0, 0)).toBe(
      false,
    );
  });

  it("bounds exact hit-test work for adversarial collinear triangles", () => {
    const triangleCount = RUNTIME_LIMITS.hitTestExactPredicatesPerQuery + 1;
    const indices = new Uint32Array(triangleCount * 3);
    for (let i = 0; i < indices.length; i += 3) {
      indices[i] = 0;
      indices[i + 1] = 1;
      indices[i + 2] = 2;
    }
    expect(() => hitTestGeometry(Float64Array.of(0, 0, 1, 1, 2, 2), indices, 1, 1)).toThrow(
      /exact orientation predicates/,
    );
  });

  it("shares exact hit-test work across every sprite in one host query", () => {
    const trianglesPerSprite = Math.floor(RUNTIME_LIMITS.hitTestExactPredicatesPerQuery * 0.75);
    const mesh = {
      type: "explicit",
      points: [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      tris: Array.from({ length: trianglesPerSprite }, () => [0, 1, 2]),
    };
    const runtime = createRuntime(
      makeModel([
        { id: "a", type: "sprite", rect: [0, 0, 2, 2], mesh },
        { id: "b", type: "sprite", rect: [0, 0, 2, 2], mesh },
      ]),
    );
    runtime.evaluate();
    expect(() => runtime.hitTest(1, 1)).toThrow(/exact orientation predicates/);
  });
});

describe("rest pose (§2, §6)", () => {
  it("renders identical geometry with empty bindings and with all-defaults bindings", () => {
    const nodes = [
      {
        id: "w",
        type: "warp",
        rect: [0, 0, 64, 64],
        cols: 2,
        rows: 2,
        children: [{ id: "s", type: "sprite", rect: [8, 8, 48, 48] }],
      },
    ];
    const bare = createRuntime(makeModel(nodes)).evaluate();
    const zeroGrid = Array.from({ length: 9 }, () => [0, 0]);
    const bound = createRuntime(
      makeModel(
        nodes,
        [
          {
            target: "w",
            property: "grid",
            params: ["p"],
            axes: [[0, 1]],
            values: [zeroGrid, zeroGrid],
          },
        ],
        [{ id: "p", min: 0, max: 1, default: 0 }],
      ),
    ).evaluate();
    expect(Array.from(bound.drawList[0]!.positions)).toEqual(
      Array.from(bare.drawList[0]!.positions),
    );
  });

  it("hit-test on a sprite's own model→canvas mapping honors a non-zero origin", () => {
    const model = loadModel({
      manifest: {
        lyre: "0.1",
        id: "origin_test",
        canvas: { width: 100, height: 100, origin: [50, 50] },
      },
      rig: {
        params: [],
        nodes: [
          {
            id: "root",
            type: "group",
            children: [{ id: "s", type: "sprite", rect: [-10, -10, 20, 20] }],
          },
        ],
        bindings: [],
      },
    });
    const rt = createRuntime(model);
    const pos = rt.evaluate().drawList[0]!.positions;
    // Model-space rect [-10,-10,20,20] centred on origin → canvas 40..60.
    expect(pos[0]).toBe(40);
    expect(pos[1]).toBe(40);
    expect(rt.hitTest(50, 50)).toEqual(["s"]);
    expect(rt.hitTest(5, 5)).toEqual([]);
  });
});
