// Feature-isolation corpus models m01–m16. Each function returns the model
// spec plus its scripted timelines (model path filled in by main.ts).

import * as T from "./tex.js";
import type { Buf } from "./tex.js";
import type { ModelSpec } from "./write.js";

type Json = Record<string, unknown>;
export interface GenOut {
  spec: ModelSpec;
  timelines: Record<string, Json>;
}

const sprite = (id: string, rect: number[], extra: Json = {}): Json => ({
  id,
  type: "sprite",
  rect,
  ...extra,
});
const group = (id: string, children: Json[], extra: Json = {}): Json => ({
  id,
  type: "group",
  children,
  ...extra,
});
const rotator = (id: string, pivot: number[], children: Json[], extra: Json = {}): Json => ({
  id,
  type: "rotator",
  pivot,
  children,
  ...extra,
});
const warp = (id: string, rect: number[], cols: number, rows: number, children: Json[]): Json => ({
  id,
  type: "warp",
  rect,
  cols,
  rows,
  children,
});
const P = (id: string, min: number, max: number, dflt: number, extra: Json = {}): Json => ({
  id,
  min,
  max,
  default: dflt,
  ...extra,
});
const B = (
  target: string,
  property: string,
  params: string[],
  axes: number[][],
  values: unknown[],
): Json => ({ target, property, params, axes, values });
const rig = (params: Json[], children: Json[], bindings: Json[]): Json => ({
  params,
  nodes: [group("root", children)],
  bindings,
});
const setEvents = (values: Array<[number, Record<string, number>]>): Json[] =>
  values.map(([step, set]) => ({ step, set }));

// ---------------------------------------------------------------------------

export function m01_blend_over_transparency(): GenOut {
  const bg = T.buf(64, 128);
  T.hGradient(bg, [40, 60, 120, 255], [180, 60, 40, 255]);
  const glow = T.buf(64, 64);
  T.radial(glow, 32, 32, 30, [255, 240, 180, 255], [255, 240, 180, 0]);
  const blush = T.buf(96, 32);
  T.fillEllipse(blush, 48, 16, 44, 13, [255, 140, 150, 255], 3);
  const halo = T.buf(64, 64);
  T.radial(halo, 32, 32, 28, [230, 230, 255, 200], [230, 230, 255, 0]);

  return {
    spec: {
      id: "m01_blend_over_transparency",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      rig: rig(
        [],
        [
          // Normal compatibility halo beneath additive intensity (§8.3).
          sprite("halo", [64, 16, 64, 64], { z: 5 }),
          sprite("bg", [0, 0, 64, 128], { z: 10 }),
          // Spans the bg edge: left over opaque coverage, right over both
          // zero-alpha pixels and the normal halo. Additive RGB survives all.
          sprite("glow", [32, 32, 64, 64], { z: 20, blend: "additive" }),
          // Multiply over transparency is a no-op; over bg it darkens.
          sprite("blush", [16, 80, 96, 32], { z: 30, blend: "multiply" }),
        ],
        [],
      ),
      textures: { halo, bg, glow, blush },
      note: "§8.3 blend equations incl. additive emission at zero alpha, multiply over transparency, and a normal compatibility halo.",
    },
    timelines: {
      m01_blend_over_transparency: { fps: 60, steps: 1, captures: [0] },
    },
  };
}

export function m02_mesh_grid_verts(): GenOut {
  const grid = T.buf(48, 48);
  T.checker(grid, 6, [220, 220, 60, 255], [60, 100, 220, 255]);
  const expl = T.buf(48, 48);
  T.hGradient(expl, [30, 200, 120, 255], [200, 30, 160, 255]);

  // 2×2 grid mesh: 9 control points; displace the centre (index 4) downward.
  const vertDeltas = (dy: number) =>
    Array.from({ length: 9 }, (_, i) => (i === 4 ? [0, dy] : [0, 0]));

  return {
    spec: {
      id: "m02_mesh_grid_verts",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      rig: rig(
        [P("p", 0, 1, 0)],
        [
          sprite("grid_s", [8, 8, 48, 48], { mesh: { type: "grid", cols: 2, rows: 2 }, z: 10 }),
          sprite("expl_s", [72, 8, 48, 48], {
            z: 20,
            mesh: {
              type: "explicit",
              points: [
                [72, 8],
                [120, 8],
                [72, 56],
                [120, 56],
              ],
              tris: [
                [0, 1, 2],
                [1, 3, 2],
              ],
            },
          }),
        ],
        [
          B("grid_s", "verts", ["p"], [[0, 1]], [vertDeltas(0), vertDeltas(22)]),
          B(
            "expl_s",
            "offset",
            ["p"],
            [[0, 1]],
            [
              [0, 0],
              [0, 40],
            ],
          ),
        ],
      ),
      textures: { grid_s: grid, expl_s: expl },
      note: "§5.4 grid derivation (↘ diagonal made visible by a centre-point vert delta) + explicit-mesh escape hatch.",
    },
    timelines: {
      m02_mesh_grid_verts: {
        fps: 60,
        steps: 3,
        events: setEvents([
          [0, { p: 0 }],
          [1, { p: 0.5 }],
          [2, { p: 1 }],
        ]),
        captures: [0, 1, 2],
      },
    },
  };
}

export function m03_rotators_nested(): GenOut {
  const arm1 = T.buf(12, 32);
  T.fillRect(arm1, 0, 0, 12, 32, [200, 80, 60, 255]);
  T.fillRect(arm1, 2, 2, 8, 4, [255, 220, 200, 255]);
  const arm2 = T.buf(10, 30);
  T.fillRect(arm2, 0, 0, 10, 30, [60, 120, 200, 255]);
  T.fillEllipse(arm2, 5, 25, 4, 4, [230, 240, 90, 255]);

  return {
    spec: {
      id: "m03_rotators_nested",
      canvas: { width: 128, height: 128, origin: [64, 40] },
      rig: rig(
        [P("p", 0, 1, 0), P("q", 0, 1, 0)],
        [
          rotator(
            "outer",
            [0, 0],
            [
              sprite("upper", [-6, 0, 12, 32], { z: 10 }),
              rotator("inner", [0, 30], [sprite("lower", [-5, 30, 10, 30], { z: 20 })]),
            ],
          ),
        ],
        [
          B("outer", "angle", ["p"], [[0, 1]], [0, 60]),
          B("outer", "scale", ["p"], [[0, 1]], [1, 1.25]),
          B("inner", "angle", ["p"], [[0, 1]], [0, -90]),
          B(
            "inner",
            "pivot_offset",
            ["q"],
            [[0, 1]],
            [
              [0, 0],
              [14, 0],
            ],
          ),
        ],
      ),
      textures: { upper: arm1, lower: arm2 },
      note: "§8.2 clockwise rotator math; §8.1.4 nearest-ancestor-first composition (non-commuting nested rotators); pivot_offset translation.",
    },
    timelines: {
      m03_rotators_nested: {
        fps: 60,
        steps: 4,
        events: setEvents([
          [0, { p: 0, q: 0 }],
          [1, { p: 0.5 }],
          [2, { p: 1 }],
          [3, { p: 1, q: 1 }],
        ]),
        captures: [0, 1, 2, 3],
      },
    },
  };
}

/** Programmatic warp deltas: (cols+1)×(rows+1) [dx,dy] rows-major. */
function warpDeltas(
  cols: number,
  rows: number,
  f: (col: number, row: number) => [number, number],
): number[][] {
  const out: number[][] = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) out.push(f(c, r));
  return out;
}

export function m04_warp_interior(): GenOut {
  const tex = T.buf(112, 112);
  T.checker(tex, 14, [235, 235, 235, 255], [40, 44, 52, 255]);
  T.fillEllipse(tex, 56, 56, 10, 10, [220, 60, 60, 255]);

  // Bulge: push interior control points outward from the grid centre.
  const bulge = (amount: number) =>
    warpDeltas(4, 4, (c, r) => {
      const dx = c - 2;
      const dy = r - 2;
      const d2 = dx * dx + dy * dy;
      if (d2 === 0 || c === 0 || c === 4 || r === 0 || r === 4) return [0, 0];
      const s = amount / Math.sqrt(d2);
      return [Math.round(dx * s * 100) / 100, Math.round(dy * s * 100) / 100];
    });

  return {
    spec: {
      id: "m04_warp_interior",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      rig: rig(
        [P("p", 0, 1, 0)],
        [
          warp("w", [8, 8, 112, 112], 4, 4, [
            sprite("checker", [8, 8, 112, 112], { mesh: { type: "grid", cols: 8, rows: 8 } }),
          ]),
        ],
        [B("w", "grid", ["p"], [[0, 1]], [bulge(0), bulge(12)])],
      ),
      textures: { checker: tex },
      note: "§5.5 bilinear cell mapping over a multi-cell warp grid.",
    },
    timelines: {
      m04_warp_interior: {
        fps: 60,
        steps: 3,
        events: setEvents([
          [0, { p: 0 }],
          [1, { p: 0.5 }],
          [2, { p: 1 }],
        ]),
        captures: [0, 1, 2],
      },
    },
  };
}

export function m05_warp_overhang(): GenOut {
  const tex = T.buf(100, 100);
  T.checker(tex, 10, [90, 200, 140, 255], [30, 60, 100, 255]);
  T.strokeEllipse(tex, 50, 50, 40, 40, 3, [255, 255, 255, 255]);

  // Shift the warp's right column and bottom-right corner; the sprite
  // overhangs every edge, so §5.5 extrapolation is exercised on edges and
  // diagonally outside the corner.
  const shove = (amount: number) =>
    warpDeltas(2, 2, (c, r) => {
      if (c === 2 && r === 2) return [amount * 1.5, amount];
      if (c === 2) return [amount, 0];
      return [0, 0];
    });

  return {
    spec: {
      id: "m05_warp_overhang",
      canvas: { width: 160, height: 160, origin: [0, 0] },
      rig: rig(
        [P("p", 0, 1, 0)],
        [
          warp("w", [50, 50, 60, 60], 2, 2, [
            sprite("art", [30, 30, 100, 100], { mesh: { type: "grid", cols: 10, rows: 10 } }),
          ]),
        ],
        [B("w", "grid", ["p"], [[0, 1]], [shove(0), shove(10)])],
      ),
      textures: { art: tex },
      note: "§5.5 clamped-cell bilinear extrapolation for sprites overhanging the warp rect (edges and corner-diagonal).",
    },
    timelines: {
      m05_warp_overhang: {
        fps: 60,
        steps: 2,
        events: setEvents([
          [0, { p: 0 }],
          [1, { p: 1 }],
        ]),
        captures: [0, 1],
      },
    },
  };
}

export function m06_multiparam_grids(): GenOut {
  const dot = T.buf(24, 24);
  T.fillEllipse(dot, 12, 12, 10, 10, [240, 120, 40, 255]);
  const needle = T.buf(8, 40);
  T.fillRect(needle, 0, 0, 8, 40, [80, 80, 220, 255]);
  T.fillRect(needle, 2, 0, 4, 8, [255, 255, 255, 255]);

  // 2-param offset grid over non-uniform axes; values chosen non-separable
  // (x depends on both params) so row-major order errors show.
  const axes2 = [
    [-1, -0.2, 0, 1],
    [-1, 0, 1],
  ];
  const values2: number[][] = [];
  for (const ax of axes2[0]!) {
    for (const ay of axes2[1]!) {
      values2.push([
        Math.round((ax * 24 + ay * ax * 10) * 100) / 100,
        Math.round(ay * 18 * 100) / 100,
      ]);
    }
  }

  // 3-param angle grid: angle = 40a + 20b + 10c + 15abc (non-separable term).
  const values3: number[] = [];
  for (const a of [0, 1])
    for (const b of [0, 1])
      for (const c of [0, 1]) {
        values3.push(40 * a + 20 * b + 10 * c + 15 * a * b * c);
      }

  return {
    spec: {
      id: "m06_multiparam_grids",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      rig: rig(
        [
          P("px", -2, 2, 0),
          P("py", -2, 2, 0),
          P("pa", 0, 1, 0),
          P("pb", 0, 1, 0),
          P("pc", 0, 1, 0),
        ],
        [
          sprite("dot", [52, 20, 24, 24], { z: 10 }),
          rotator("rot", [30, 100], [sprite("needle", [26, 60, 8, 40], { z: 20 })]),
        ],
        [
          B("dot", "offset", ["px", "py"], axes2, values2),
          B(
            "rot",
            "angle",
            ["pa", "pb", "pc"],
            [
              [0, 1],
              [0, 1],
              [0, 1],
            ],
            values3,
          ),
        ],
      ),
      textures: { dot, needle },
      note: "§7 rule 2/3: multi-param row-major grids (first param slowest), non-uniform axes, clamp beyond the axis range.",
    },
    timelines: {
      m06_multiparam_grids: {
        fps: 60,
        steps: 5,
        events: setEvents([
          [0, { px: 0, py: 0 }],
          [1, { px: -0.6, py: 0.5, pa: 0.5, pb: 0.25, pc: 1 }],
          [2, { px: 1, py: -1, pa: 1, pb: 1, pc: 1 }],
          // Beyond the axis range (param range is wider): boundary held (§7).
          [3, { px: 2, py: 2 }],
          [4, { px: -2, py: -0.35, pa: 0.1, pb: 0.9, pc: 0.4 }],
        ]),
        captures: [0, 1, 2, 3, 4],
      },
    },
  };
}

export function m07_wrap_seam(): GenOut {
  const wheel = T.buf(72, 72);
  // Asymmetric pinwheel: four arms, one uniquely colored.
  T.fillEllipse(wheel, 36, 36, 8, 8, [40, 40, 40, 255]);
  T.fillRect(wheel, 33, 2, 6, 30, [220, 50, 50, 255]); // up arm (red)
  T.fillRect(wheel, 33, 40, 6, 30, [70, 70, 200, 255]); // down
  T.fillRect(wheel, 2, 33, 30, 6, [70, 180, 70, 255]); // left
  T.fillRect(wheel, 40, 33, 30, 6, [230, 200, 60, 255]); // right
  const marker = T.buf(10, 10);
  T.fillEllipse(marker, 5, 5, 4, 4, [0, 0, 0, 255]);

  return {
    spec: {
      id: "m07_wrap_seam",
      canvas: { width: 128, height: 128, origin: [64, 64] },
      rig: rig(
        [P("spin", 0, 360, 0, { wrap: true }), P("ref", 0, 360, 0)],
        [
          rotator("rot", [0, 0], [sprite("wheel", [-36, -36, 72, 72], { z: 10 })]),
          sprite("marker", [-60, -60, 10, 10], { z: 20 }),
        ],
        [
          // Keys stop at 240: the 240→360(≡0) interval interpolates across
          // the seam back to the first key (§7 rule 3).
          B("rot", "angle", ["spin"], [[0, 120, 240]], [0, 120, 240]),
          // Non-wrapping reference on the same axis shape: clamps instead.
          B(
            "marker",
            "offset",
            ["ref"],
            [[0, 120, 240]],
            [
              [0, 0],
              [40, 0],
              [80, 0],
            ],
          ),
        ],
      ),
      textures: { wheel, marker },
      note: "§6/§7 wrap: value wraps modulo [min,max); the axis interval past the last key interpolates across the seam.",
    },
    timelines: {
      m07_wrap_seam: {
        fps: 60,
        steps: 5,
        events: setEvents([
          [0, { spin: 60, ref: 60 }],
          [1, { spin: 240, ref: 240 }],
          [2, { spin: 300, ref: 300 }], // seam midpoint: lerp(240, 0, 0.5)
          [3, { spin: 450, ref: 450 }], // wraps to 90; ref clamps to 360→240 key
          [4, { spin: 359.9, ref: 0 }],
        ]),
        captures: [0, 1, 2, 3, 4],
      },
    },
  };
}

export function m08_zsort(): GenOut {
  const torso = T.buf(32, 96);
  T.hGradient(torso, [120, 120, 130, 255], [70, 70, 80, 255]);
  const seg = T.buf(24, 16);
  T.fillRect(seg, 0, 0, 24, 16, [220, 160, 60, 255]);
  T.fillRect(seg, 1, 1, 22, 2, [255, 230, 160, 255]);
  const tileA = T.buf(28, 28);
  T.fillRect(tileA, 0, 0, 28, 28, [200, 60, 120, 255]);
  const tileB = T.buf(28, 28);
  T.fillRect(tileB, 0, 0, 28, 28, [60, 180, 200, 255]);

  const armSprites = [0, 1, 2, 3].map((i) =>
    sprite(`arm${i}`, [8 + 22 * i, 48, 24, 16], { z: 1000 + 10 * i, texture: "seg" }),
  );

  return {
    spec: {
      id: "m08_zsort",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      rig: rig(
        [P("lift", 0, 1, 0), P("q", 0, 1, 0), P("half", -1, 1, 0)],
        [
          sprite("torso", [48, 16, 32, 96], { z: 2000 }),
          group("arm", armSprites),
          // Single-rounding pair: two fractional group-z deltas that cross .5
          // only summed; plus an engineered exact tie broken by document order.
          group("gz1", [group("gz2", [sprite("tile_a", [12, 92, 28, 28], { z: 3000 })])]),
          sprite("tile_b", [28, 100, 28, 28], { z: 3001 }),
          // Positive half-tie: mover precedes ref, so +0.5 must round to 1
          // for the pink mover to draw above the cyan ref.
          group("pos_half", [sprite("pos_mover", [88, 8, 28, 28], { texture: "tile_a" })]),
          sprite("pos_ref", [96, 16, 28, 28], { texture: "tile_b" }),
          // Negative half-tie: ref precedes mover, so -0.5 must round to 0
          // for the later pink mover to win the document-order tie.
          sprite("neg_ref", [88, 80, 28, 28], { texture: "tile_b" }),
          group("neg_half", [sprite("neg_mover", [96, 88, 28, 28], { texture: "tile_a" })]),
        ],
        [
          // ±1000-style region jump (Annex B): arm crosses the torso whole.
          B("arm", "z", ["lift"], [[0, 1]], [0, 1500]),
          B("gz1", "z", ["q"], [[0, 1]], [0, 0.3]),
          B("gz2", "z", ["q"], [[0, 1]], [0, 0.3]),
          B("pos_half", "z", ["half"], [[-1, 0, 1]], [-0.5, 0, 0.5]),
          B("neg_half", "z", ["half"], [[-1, 0, 1]], [-0.5, 0, 0.5]),
        ],
      ),
      textures: { torso, seg, tile_a: tileA, tile_b: tileB },
      note: "§8.1.6: flat global sort, group z-delta region jump, single rounding of the accumulated real z, exact ±0.5 ties toward +∞, document-order ties.",
    },
    timelines: {
      m08_zsort: {
        fps: 60,
        steps: 6,
        events: setEvents([
          [0, { lift: 0, q: 0, half: 0 }],
          [1, { lift: 1 }], // arm now draws over the torso, layering preserved
          // q=1: tile_a z = 3000 + 0.3 + 0.3 = 3000.6 → rounds once to 3001,
          // exact tie with tile_b → document order puts tile_a beneath.
          [2, { q: 1 }],
          // q=0.5: 3000.3 → 3000: tile_a under tile_b by z.
          [3, { q: 0.5 }],
          [4, { half: 1 }], // +0.5 → 1, not ties-to-even 0
          [5, { half: -1 }], // -0.5 → 0, not away-from-zero -1
        ]),
        captures: [0, 1, 2, 3, 4, 5],
      },
    },
  };
}

export function m09_masks(): GenOut {
  const circle = T.buf(40, 40);
  T.fillEllipse(circle, 20, 20, 17, 17, [255, 255, 255, 255], 2);
  const half = T.buf(40, 40);
  T.fillEllipse(half, 20, 20, 17, 17, [255, 255, 255, 128], 2);
  const art = T.buf(64, 64);
  T.checker(art, 8, [240, 90, 60, 255], [250, 200, 80, 255]);
  const art2 = T.buf(64, 64);
  T.hGradient(art2, [60, 90, 240, 255], [80, 220, 200, 255]);

  return {
    spec: {
      id: "m09_masks",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      rig: rig(
        [P("fade", 0, 1, 0)],
        [
          // Invisible union sources (rest opacity 0 still clips, §8.4) under
          // an opacity-animated group: neither may affect the mask.
          group("mask_holder", [
            sprite("src_a", [10, 10, 40, 40], { opacity: 0, texture: "half", z: 1 }),
            sprite("src_b", [34, 22, 40, 40], { opacity: 0, texture: "half", z: 2 }),
          ]),
          sprite("clipped", [0, 0, 64, 64], {
            z: 10,
            texture: "art",
            mask: { mode: "alpha", sources: ["src_a", "src_b"] },
          }),
          sprite("inv", [64, 64, 64, 64], {
            z: 20,
            texture: "art2",
            mask: { mode: "inverted", sources: ["src_c"] },
          }),
          // Visible source: draws normally AND clips (§8.4).
          sprite("src_c", [84, 84, 40, 40], { z: 30, texture: "circle" }),
        ],
        [B("mask_holder", "opacity", ["fade"], [[0, 1]], [1, 0])],
      ),
      textures: { circle, half, art, art2 },
      note: "§8.4: multi-source coverage union of raw alpha; opacity (own or inherited) never affects clipping; inverted mode; visible sources draw normally.",
    },
    timelines: {
      m09_masks: {
        fps: 60,
        steps: 2,
        events: setEvents([
          [0, { fade: 0 }],
          [1, { fade: 1 }], // group opacity → 0: goldens must be identical
        ]),
        captures: [0, 1],
      },
    },
  };
}

export function m10_opacity_combine(): GenOut {
  const sq = T.buf(40, 40);
  T.fillRect(sq, 0, 0, 40, 40, [90, 200, 90, 255]);
  const sq2 = T.buf(40, 40);
  T.fillRect(sq2, 0, 0, 40, 40, [200, 90, 200, 255]);
  const bg = T.buf(128, 32);
  T.hGradient(bg, [255, 255, 255, 255], [0, 0, 0, 255]);

  return {
    spec: {
      id: "m10_opacity_combine",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      rig: rig(
        [P("p", 0, 1, 0)],
        [
          sprite("bg", [0, 48, 128, 32], { z: 1 }),
          // rest 0.5 × (factor 2.4 × factor 1.25 = 3) = 1.5 → clamped once to 1.
          sprite("boost", [8, 44, 40, 40], { z: 10, opacity: 0.5, texture: "sq" }),
          group("g", [sprite("inner", [72, 44, 40, 40], { z: 20, opacity: 0.9, texture: "sq2" })], {
            opacity: 0.8,
          }),
        ],
        [
          B("boost", "opacity", ["p"], [[0, 1]], [1, 2.4]),
          B("boost", "opacity", ["p"], [[0, 1]], [1, 1.25]),
          B("g", "opacity", ["p"], [[0, 1]], [1, 0.5]),
        ],
      ),
      textures: { bg, sq, sq2 },
      note: "§7 rule 5: opacity factors multiply unclamped and clamp once post-combination; §8.1.5 ancestor opacity products.",
    },
    timelines: {
      m10_opacity_combine: {
        fps: 60,
        steps: 3,
        events: setEvents([
          [0, { p: 0 }],
          [1, { p: 0.5 }],
          [2, { p: 1 }],
        ]),
        captures: [0, 1, 2],
      },
    },
  };
}

export function m11_expressions(): GenOut {
  const mk = (c: T.RGBA): Buf => {
    const b = T.buf(20, 20);
    T.fillEllipse(b, 10, 10, 8, 8, c, 1.5);
    return b;
  };

  const offsetBinding = (target: string, param: string, range: [number, number]) =>
    B(
      target,
      "offset",
      [param],
      [[range[0], range[1]]],
      [
        [0, -30],
        [0, 30],
      ],
    );

  return {
    spec: {
      id: "m11_expressions",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      capabilities: ["core"],
      rig: rig(
        [P("a", -1, 1, 0), P("b", 0, 1, 0), P("c", 0, 1, 1)],
        [
          sprite("dot_a", [14, 54, 20, 20], { z: 10 }),
          sprite("dot_b", [54, 54, 20, 20], { z: 20 }),
          sprite("dot_c", [94, 54, 20, 20], { z: 30 }),
        ],
        [
          // §12 rest-pose: geometry contributions must vanish at defaults —
          // a's rest (0) sits mid-axis, b's (0) at the start, c's (1) at the end.
          offsetBinding("dot_a", "a", [-1, 1]),
          B(
            "dot_b",
            "offset",
            ["b"],
            [[0, 1]],
            [
              [0, 0],
              [0, 30],
            ],
          ),
          B(
            "dot_c",
            "offset",
            ["c"],
            [[0, 1]],
            [
              [0, 30],
              [0, 0],
            ],
          ),
        ],
      ),
      expressions: {
        exp_over: {
          id: "exp_over",
          fade_in: 0.5,
          fade_out: 0.5,
          params: [{ id: "a", value: 1, blend: "overwrite" }],
        },
        exp_add: {
          id: "exp_add",
          fade_in: 0,
          fade_out: 0,
          params: [{ id: "b", value: 0.5, blend: "add" }],
        },
        exp_mult: {
          id: "exp_mult",
          fade_in: 0,
          fade_out: 0,
          params: [{ id: "c", value: 0.2, blend: "multiply" }],
        },
      },
      textures: {
        dot_a: mk([220, 60, 60, 255]),
        dot_b: mk([60, 180, 60, 255]),
        dot_c: mk([60, 60, 220, 255]),
      },
      note: "§6.1/§10.1/D.8: expressions apply after host input; overwrite/add/multiply at fractional weights; linear fades.",
    },
    timelines: {
      m11_expressions: {
        fps: 60,
        steps: 121,
        events: [
          { step: 0, set: { a: -0.5, b: 0.2, c: 0.8 } },
          { step: 0, expression: { id: "exp_over", weight: 0.5 } },
          { step: 0, expression: { id: "exp_add", weight: 1 } },
          { step: 0, expression: { id: "exp_mult", weight: 0.5 } },
          // Drop the held weight, then fade in from zero (30 steps at 60fps).
          { step: 30, expression: { id: "exp_over", weight: 0 } },
          { step: 31, expression: { id: "exp_over", action: "activate" } },
          { step: 100, expression: { id: "exp_over", action: "deactivate" } },
        ],
        captures: [0, 30, 45, 61, 100, 115, 120],
      },
    },
  };
}

export function m12_motions(): GenOut {
  const mk = (c: T.RGBA): Buf => {
    const b = T.buf(18, 18);
    T.fillRect(b, 0, 0, 18, 18, c);
    return b;
  };

  return {
    spec: {
      id: "m12_motions",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      capabilities: ["core", "motion"],
      rig: rig(
        [P("px", -1, 1, 0), P("py", -1, 1, 0)],
        [
          sprite("box", [55, 55, 18, 18], { z: 10 }),
          sprite("shadow", [55, 100, 18, 18], { z: 5, texture: "shadow" }),
        ],
        [
          B(
            "box",
            "offset",
            ["px"],
            [[-1, 1]],
            [
              [-45, 0],
              [45, 0],
            ],
          ),
          B(
            "box",
            "offset",
            ["py"],
            [[-1, 1]],
            [
              [0, -45],
              [0, 45],
            ],
          ),
          B(
            "shadow",
            "offset",
            ["px"],
            [[-1, 1]],
            [
              [-45, 0],
              [45, 0],
            ],
          ),
        ],
      ),
      motions: {
        wave: {
          id: "wave",
          duration: 2,
          loop: true,
          tracks: [
            {
              param: "px",
              keys: [
                { t: 0, v: -1 },
                { t: 1, v: 1, ease: "bezier", cp: [0.4, 0, 0.6, 1] },
                { t: 2, v: -1, ease: "bezier", cp: [0.4, 0, 0.6, 1] },
              ],
            },
            {
              param: "py",
              keys: [
                { t: 0, v: 0 },
                { t: 0.5, v: 0.8, ease: "step" },
                // Extreme control points stress the 1e-4 x-solve (§10.2).
                { t: 1.5, v: -0.4, ease: "bezier", cp: [1, 0, 1, 1] },
                { t: 2, v: 0, ease: "linear" },
              ],
            },
          ],
        },
        drift: {
          id: "drift",
          duration: 4,
          loop: false,
          tracks: [
            {
              param: "px",
              keys: [
                { t: 0, v: 0 },
                { t: 4, v: 0.6 },
              ],
            },
          ],
        },
      },
      textures: { box: mk([230, 120, 40, 255]), shadow: mk([40, 40, 60, 160]) },
      note: "§10.2: bezier/step/linear easing, loop wrap, start-order lerp layering at fractional weights.",
    },
    timelines: {
      m12_motions: {
        fps: 60,
        steps: 240,
        events: [
          { step: 0, motion: { id: "wave", action: "play", weight: 1 } },
          { step: 60, motion: { id: "drift", action: "play", weight: 0.5 } },
          { step: 180, motion: { id: "wave", action: "weight", weight: 0.25 } },
        ],
        captures: [15, 30, 59, 90, 129, 150, 200, 239],
      },
    },
  };
}

export function m13_variants(): GenOut {
  const mk = (c: T.RGBA, w = 40, h = 40): Buf => {
    const b = T.buf(w, h);
    T.fillRect(b, 0, 0, w, h, c);
    return b;
  };
  const star = T.buf(24, 24);
  T.fillEllipse(star, 12, 12, 9, 9, [255, 220, 60, 255], 1.5);

  return {
    spec: {
      id: "m13_variants",
      canvas: { width: 128, height: 128, origin: [0, 0] },
      capabilities: ["core", "variants"],
      rig: rig(
        [P("p", 0, 1, 0)],
        [
          group("outfit_a", [
            sprite("dress_a", [20, 30, 40, 60], { z: 10 }),
            // Mask source that can be excluded while its clipped sprite stays
            // active (validator-warn configuration, §10.3/§8.4).
            sprite("mask_src", [70, 30, 40, 40], { z: 11, opacity: 0, texture: "dress_a" }),
          ]),
          group("outfit_b", [sprite("dress_b", [20, 30, 40, 60], { z: 20 })]),
          // Shared by both options of the same slot (§10.3 rule 3).
          sprite("collar", [24, 22, 32, 12], { z: 30 }),
          sprite("clipped", [70, 30, 40, 40], {
            z: 40,
            texture: "art",
            mask: { mode: "alpha", sources: ["mask_src"] },
          }),
          group("badge_star", [sprite("star", [90, 90, 24, 24], { z: 50 })]),
        ],
        [
          // Targets a node excluded under the default option: evaluates to
          // nothing rather than erroring (§7 rule 7).
          B(
            "dress_b",
            "offset",
            ["p"],
            [[0, 1]],
            [
              [0, 0],
              [0, 20],
            ],
          ),
        ],
      ),
      variants: {
        slots: [
          {
            id: "outfit",
            default: "a",
            options: [
              { id: "a", nodes: ["outfit_a", "collar"] },
              { id: "b", nodes: ["outfit_b", "collar"] },
            ],
          },
          {
            id: "badge",
            default: "none",
            options: [
              { id: "none", nodes: [] },
              { id: "star", nodes: ["badge_star"] },
            ],
          },
        ],
      },
      textures: {
        dress_a: mk([200, 80, 80, 255], 40, 60),
        dress_b: mk([80, 80, 200, 255], 40, 60),
        collar: mk([240, 240, 240, 255], 32, 12),
        art: mk([80, 200, 160, 255]),
        star,
      },
      note: "§10.3: exclusion semantics, same-slot sharing, empty option, excluded binding target, excludable mask source, mid-timeline switch.",
    },
    timelines: {
      m13_variants: {
        fps: 60,
        steps: 4,
        events: [
          { step: 0, set: { p: 1 } },
          { step: 1, variant: { slot: "outfit", option: "b" } },
          { step: 1, variant: { slot: "badge", option: "star" } },
          { step: 2, variant: { slot: "outfit", option: "a" } },
          { step: 3, variant: { slot: "badge", option: "none" } },
        ],
        captures: [0, 1, 2, 3],
      },
    },
  };
}

export function m14_physics(): GenOut {
  const strand = T.buf(12, 70);
  T.fillRect(strand, 2, 0, 8, 70, [150, 90, 200, 255]);
  T.fillEllipse(strand, 6, 64, 5, 5, [230, 200, 90, 255]);
  const strand2 = T.buf(10, 46);
  T.fillRect(strand2, 2, 0, 6, 46, [90, 160, 210, 255]);

  // Dense per-step input script: sine sway + slower tilt (10 s at 60 fps).
  const events: Json[] = [];
  for (let s = 0; s < 600; s++) {
    const sway = Math.round(Math.sin(s / 25) * 1e4) / 1e4;
    const tilt = Math.round(Math.sin(s / 80) * 20 * 1e4) / 1e4;
    const asym = s < 200 ? 0.3 : s < 400 ? 0.9 : 0.05;
    events.push({ step: s, set: { sway_in: sway, tilt_in: tilt, asym_in: asym } });
  }

  return {
    spec: {
      id: "m14_physics",
      canvas: { width: 160, height: 160, origin: [80, 20] },
      capabilities: ["core", "physics"],
      rig: rig(
        [
          P("sway_in", -1, 1, 0),
          P("tilt_in", -30, 30, 0),
          P("asym_in", 0, 1, 0.3),
          P("sway1", -90, 90, 0),
          P("sway2", -90, 90, 0),
          P("asway", -90, 90, 0),
        ],
        [
          rotator(
            "r1",
            [0, 0],
            [
              sprite("strand_a", [-6, 0, 12, 70], { z: 10, texture: "strand" }),
              rotator(
                "r2",
                [0, 60],
                [sprite("strand_b", [-5, 60, 10, 46], { z: 20, texture: "strand2" })],
              ),
            ],
          ),
          rotator(
            "r3",
            [-50, 0],
            [sprite("strand_c", [-56, 0, 12, 70], { z: 30, texture: "strand" })],
          ),
        ],
        [
          B("r1", "angle", ["sway1"], [[-90, 90]], [-90, 90]),
          B("r2", "angle", ["sway2"], [[-90, 90]], [-90, 90]),
          B("r3", "angle", ["asway"], [[-90, 90]], [-90, 90]),
        ],
      ),
      physics: {
        fps: 60,
        chains: [
          {
            id: "ch_sway",
            inputs: [
              { param: "sway_in", type: "x", weight: 40 },
              { param: "tilt_in", type: "angle", weight: 0.5 },
            ],
            links: [
              { length: 60, damping: 0.1, stiffness: 0.06 },
              { length: 46, damping: 0.12, stiffness: 0.03 },
            ],
            gravity: [0, 900],
            wind: [0, 0],
            outputs: [
              { link: 0, param: "sway1", multiplier: 1, blend: "overwrite" },
              { link: 1, param: "sway2", multiplier: 1.2, blend: "overwrite" },
              { link: 0, param: "asway", multiplier: 0.25, blend: "overwrite" },
            ],
          },
          {
            id: "ch_asym",
            inputs: [{ param: "asym_in", type: "x", weight: 30 }],
            links: [{ length: 70, damping: 0.15, stiffness: 0.1 }],
            gravity: [0, 900],
            wind: [15, 0],
            outputs: [{ link: 0, param: "asway", multiplier: 0.5, blend: "add" }],
          },
        ],
      },
      textures: { strand, strand2 },
      note: "§9: x/angle inputs, asymmetric-range default-centred normalization (asym_in 0..1 default 0.3), multi-link chains, order-independent overwrite+add fan-in to asway, wind; outputs consumed by ordinary bindings.",
    },
    timelines: {
      m14_physics: {
        fps: 60,
        steps: 600,
        events,
        captures: [0, 60, 200, 420, 599],
        physics_trace: true,
      },
    },
  };
}

export function m15_physics_variant_skip(): GenOut {
  const bar = T.buf(10, 50);
  T.fillRect(bar, 2, 0, 6, 50, [200, 120, 60, 255]);
  const cape = T.buf(30, 60);
  T.fillRect(cape, 0, 0, 30, 60, [120, 40, 40, 255]);

  const events: Json[] = [];
  // Physics conformance traces cover the full normative 10 seconds.
  for (let s = 0; s < 300; s++) {
    // The outer script runs at 30 fps while physics remains at 60 fps. Keep
    // the drive's temporal frequency equivalent to the former 60 fps script.
    events.push({ step: s, set: { drive: Math.round(Math.sin(s / 10) * 1e4) / 1e4 } });
  }

  return {
    spec: {
      id: "m15_physics_variant_skip",
      canvas: { width: 128, height: 128, origin: [64, 10] },
      capabilities: ["core", "physics", "variants"],
      rig: rig(
        [P("drive", -1, 1, 0), P("main_sway", -90, 90, 0), P("cape_sway", -90, 90, 0)],
        [
          rotator("main_rot", [0, 0], [sprite("bar", [-5, 0, 10, 50], { z: 10 })]),
          group("cape_grp", [
            rotator("cape_rot", [30, 0], [sprite("cape", [15, 0, 30, 60], { z: 5 })]),
          ]),
        ],
        [
          B("main_rot", "angle", ["main_sway"], [[-90, 90]], [-90, 90]),
          // Consumed only inside the excluded-by-default cape subtree:
          // runtimes MAY skip simulating ch_cape entirely (§10.3 rule 5).
          B("cape_rot", "angle", ["cape_sway"], [[-90, 90]], [-90, 90]),
        ],
      ),
      physics: {
        fps: 60,
        chains: [
          {
            id: "ch_main",
            inputs: [{ param: "drive", type: "x", weight: 35 }],
            links: [{ length: 50, damping: 0.1, stiffness: 0.08 }],
            gravity: [0, 900],
            outputs: [{ link: 0, param: "main_sway", multiplier: 1, blend: "overwrite" }],
          },
          {
            id: "ch_cape",
            inputs: [{ param: "drive", type: "x", weight: 35 }],
            links: [{ length: 60, damping: 0.12, stiffness: 0.05 }],
            gravity: [0, 900],
            outputs: [{ link: 0, param: "cape_sway", multiplier: 1, blend: "overwrite" }],
          },
        ],
      },
      variants: {
        slots: [
          {
            id: "cape",
            default: "none",
            options: [
              { id: "none", nodes: [] },
              { id: "on", nodes: ["cape_grp"] },
            ],
          },
        ],
      },
      textures: { bar, cape },
      note: "§10.3 rule 5: renders must be identical whether ch_cape is simulated or skipped; only ch_main is traced.",
    },
    timelines: {
      m15_physics_variant_skip: {
        fps: 30,
        steps: 300,
        events,
        captures: [0, 50, 149, 299],
        physics_trace: true,
        trace_chains: ["ch_main"],
      },
    },
  };
}

/** Build a packed atlas image with ≥2-texel replicated gutters (§3.2). */
export function packAtlas(
  parts: Array<{ id: string; buf: Buf }>,
  gutter = 2,
): { image: Buf; rects: Record<string, number[]> } {
  // Simple horizontal shelf packing.
  let w = gutter;
  let h = 0;
  for (const p of parts) {
    w += p.buf.w + 2 * gutter;
    h = Math.max(h, p.buf.h + 2 * gutter);
  }
  const image = T.buf(w, h);
  const rects: Record<string, number[]> = {};
  let x = gutter;
  for (const p of parts) {
    const { buf: b } = p;
    rects[p.id] = [x, gutter, b.w, b.h];
    // Blit with edge replication into the gutter ring.
    for (let yy = -gutter; yy < b.h + gutter; yy++) {
      for (let xx = -gutter; xx < b.w + gutter; xx++) {
        const sx = Math.min(b.w - 1, Math.max(0, xx));
        const sy = Math.min(b.h - 1, Math.max(0, yy));
        const so = (sy * b.w + sx) * 4;
        const dxp = x + xx;
        const dyp = gutter + yy;
        if (dxp < 0 || dyp < 0 || dxp >= image.w || dyp >= image.h) continue;
        const doff = (dyp * image.w + dxp) * 4;
        image.data[doff] = b.data[so]!;
        image.data[doff + 1] = b.data[so + 1]!;
        image.data[doff + 2] = b.data[so + 2]!;
        image.data[doff + 3] = b.data[so + 3]!;
      }
    }
    x += b.w + 2 * gutter;
  }
  return { image, rects };
}

export function m16_atlas(): GenOut {
  const petal = T.buf(40, 40);
  T.radial(petal, 20, 20, 18, [250, 160, 200, 255], [250, 160, 200, 0]);
  const leaf = T.buf(32, 48);
  T.fillEllipse(leaf, 16, 24, 12, 20, [80, 170, 90, 255], 2);

  const { rects } = packAtlas([
    { id: "petal", buf: petal },
    { id: "leaf", buf: leaf },
  ]);

  const timeline = (useAtlas: boolean): Json => ({
    fps: 60,
    steps: 2,
    events: setEvents([
      [0, { p: 0 }],
      [1, { p: 1 }],
    ]),
    captures: [0, 1],
    ...(useAtlas ? { use_atlas: true } : {}),
  });

  return {
    spec: {
      id: "m16_atlas",
      canvas: { width: 96, height: 96, origin: [0, 0] },
      rig: rig(
        [P("p", 0, 1, 0)],
        [
          sprite("leaf", [30, 40, 32, 48], { z: 10 }),
          sprite("petal", [16, 8, 40, 40], { z: 20 }),
          // Same texture reused by a second sprite (§3.2).
          sprite("petal2", [44, 20, 40, 40], { z: 30, texture: "petal" }),
        ],
        [
          B(
            "petal2",
            "offset",
            ["p"],
            [[0, 1]],
            [
              [0, 0],
              [8, 12],
            ],
          ),
        ],
      ),
      atlas: { image: "atlas.png", rects },
      textures: { petal, leaf },
      extraFiles: {},
      note: "§3.2: atlas rendering must be indistinguishable from per-file rendering; 2-texel replicated gutters.",
      // atlas.png is written via extraFiles by main.ts (needs encodePng).
    },
    timelines: {
      m16_files: timeline(false),
      m16_atlas: timeline(true),
    },
  };
}

// Expose the packed image so main.ts can encode it into extraFiles.
export function m16_atlasImage(): Buf {
  const petal = T.buf(40, 40);
  T.radial(petal, 20, 20, 18, [250, 160, 200, 255], [250, 160, 200, 0]);
  const leaf = T.buf(32, 48);
  T.fillEllipse(leaf, 16, 24, 12, 20, [80, 170, 90, 255], 2);
  return packAtlas([
    { id: "petal", buf: petal },
    { id: "leaf", buf: leaf },
  ]).image;
}

export const ALL_MODELS: Array<() => GenOut> = [
  m01_blend_over_transparency,
  m02_mesh_grid_verts,
  m03_rotators_nested,
  m04_warp_interior,
  m05_warp_overhang,
  m06_multiparam_grids,
  m07_wrap_seam,
  m08_zsort,
  m09_masks,
  m10_opacity_combine,
  m11_expressions,
  m12_motions,
  m13_variants,
  m14_physics,
  m15_physics_variant_skip,
  m16_atlas,
];
