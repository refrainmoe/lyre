import { describe, expect, it } from "vitest";
import {
  applyExpressionEntry,
  createRuntime,
  cubicBezierEase,
  loadModel,
  motionLocalTime,
  sampleTrack,
  type ModelFiles,
  type MotionTrack,
} from "../src/index.js";

function makeModel(files: Partial<ModelFiles> = {}, params: unknown[] = []) {
  const indexed: Record<string, unknown> = { rig: "rig.json" };
  if (files.physics !== undefined) indexed.physics = "physics.json";
  if (files.variants !== undefined) indexed.variants = "variants.json";
  if (files.atlas !== undefined) indexed.atlas = "atlas.json";
  const expressions = Object.keys(files.expressions ?? {});
  if (expressions.length > 0) indexed.expressions = expressions;
  const motions = Object.keys(files.motions ?? {});
  if (motions.length > 0) indexed.motions = motions;
  return loadModel({
    manifest: {
      lyre: "0.1",
      id: "dyn_test",
      canvas: { width: 64, height: 64, origin: [0, 0] },
      capabilities: ["motion", "physics"],
      files: indexed,
    },
    rig: {
      params,
      nodes: [{ id: "root", type: "group", children: [] }],
      bindings: [],
    },
    ...files,
  });
}

const P = (id: string, min = 0, max = 1, dflt = 0) => ({ id, min, max, default: dflt });

function nextUp(value: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  if (Object.is(value, -0)) return Number.MIN_VALUE;
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value >= 0 ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

describe("host API numeric safety", () => {
  it("rejects non-finite parameter values and frame deltas before they poison state", () => {
    const rt = createRuntime(makeModel({}, [P("p")]));
    expect(() => rt.setParam("p", Number.NaN)).toThrow(/finite/);
    expect(() => rt.setParam("p", Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => rt.update(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => rt.update(-0.1)).toThrow(/non-negative/);
  });

  it("rejects clearing an unknown parameter", () => {
    const rt = createRuntime(makeModel({}, [P("p")]));
    expect(() => rt.clearParam("missing")).toThrow(/unknown parameter/);
  });

  it("publishes a wrapping default in its canonical half-open range immediately", () => {
    const rt = createRuntime(
      makeModel({}, [{ id: "turn", min: 0, max: 360, default: 360, wrap: true }]),
    );
    expect(rt.getParamValue("turn")).toBe(0);
    rt.evaluate();
    expect(rt.getParamValue("turn")).toBe(0);
  });

  it("does not publish composed parameters from a failed evaluation", () => {
    const model = loadModel({
      manifest: {
        lyre: "0.1",
        id: "atomic_evaluate",
        canvas: { width: 1, height: 1, origin: [0, 0] },
        capabilities: [],
        files: { rig: "rig.json" },
      },
      rig: {
        params: [P("p")],
        nodes: [
          {
            id: "root",
            type: "group",
            children: [{ id: "rot", type: "rotator", pivot: [0, 0], children: [] }],
          },
        ],
        // Each factor is valid in isolation. At p=1 their product overflows,
        // forcing evaluate() to reject after parameter composition.
        bindings: Array.from({ length: 26 }, () => ({
          target: "rot",
          property: "scale",
          params: ["p"],
          axes: [[0, 1]],
          values: [1, 1e12],
        })),
      },
    });
    const rt = createRuntime(model);
    rt.evaluate();
    expect(rt.getParamValue("p")).toBe(0);

    rt.setParam("p", 1);
    expect(() => rt.evaluate()).toThrow(/binding factor/);
    expect(rt.getParamValue("p")).toBe(0);
  });

  it("rejects a non-finite resolved transform even when it has no drawable child", () => {
    const model = loadModel({
      manifest: {
        lyre: "0.1",
        id: "empty_transform_overflow",
        canvas: { width: 1, height: 1, origin: [0, 0] },
        capabilities: [],
        files: { rig: "rig.json" },
      },
      rig: {
        params: [P("p")],
        nodes: [
          {
            id: "root",
            type: "group",
            children: [
              {
                id: "empty_rotator",
                type: "rotator",
                pivot: [0, 0],
                scale: 1e12,
                children: [],
              },
            ],
          },
        ],
        // The canonical factor product is finite (1e300), but applying the
        // authored rest scale overflows. This is still an evaluation error;
        // an empty subtree must not hide a non-finite intermediate (§11).
        bindings: Array.from({ length: 25 }, () => ({
          target: "empty_rotator",
          property: "scale",
          params: ["p"],
          axes: [[0, 1]],
          values: [1, 1e12],
        })),
      },
    });
    const runtime = createRuntime(model);
    runtime.evaluate();
    runtime.setParam("p", 1);
    expect(() => runtime.evaluate()).toThrow(/effective scale.*must be finite/);
    expect(runtime.getParamValue("p")).toBe(0);
  });
});

describe("expression weight math (§10.1)", () => {
  const entry = (blend: "add" | "multiply" | "overwrite", value: number) => ({
    id: "p",
    value,
    blend,
  });

  it("is an exact no-op at w = 0 for every mode", () => {
    for (const e of [entry("add", 5), entry("multiply", 0.2), entry("overwrite", 9)]) {
      expect(applyExpressionEntry(0.37, e, 0)).toBe(0.37);
    }
  });

  it("implements the three modes at fractional weight", () => {
    expect(applyExpressionEntry(0.4, entry("overwrite", 1), 0.5)).toBeCloseTo(0.7, 12);
    expect(applyExpressionEntry(0.4, entry("add", 0.2), 0.5)).toBeCloseTo(0.5, 12);
    // multiply: v · lerp(1, 0.2, 0.5) = 0.4 · 0.6
    expect(applyExpressionEntry(0.4, entry("multiply", 0.2), 0.5)).toBeCloseTo(0.24, 12);
  });

  it("D.8: a held expression at w=0.5 blends with live host input", () => {
    const m = makeModel(
      {
        expressions: {
          "expressions/smile.exp.json": {
            id: "smile",
            fade_in: 0.3,
            fade_out: 0.3,
            params: [{ id: "Lyre.MouthForm", value: 1.0, blend: "overwrite" }],
          },
        },
      },
      [P("Lyre.MouthForm", -1, 1, 0)],
    );
    const rt = createRuntime(m);
    rt.setParam("Lyre.MouthForm", -0.5); // live tracking says frown
    rt.setExpressionWeight("smile", 0.5); // held smile at half weight
    rt.evaluate();
    // lerp(host −0.5, value 1, 0.5) = 0.25 — reads through to the host value.
    expect(rt.getParamValue("Lyre.MouthForm")).toBeCloseTo(0.25, 12);
    // Deactivating restores tracking.
    rt.setExpressionWeight("smile", 0);
    rt.evaluate();
    expect(rt.getParamValue("Lyre.MouthForm")).toBeCloseTo(-0.5, 12);
  });

  it("fades linearly over fade_in/fade_out via update(dt)", () => {
    const m = makeModel(
      {
        expressions: {
          "e.exp.json": {
            id: "wink",
            fade_in: 0.4,
            fade_out: 0.2,
            params: [{ id: "p", value: 1, blend: "overwrite" }],
          },
        },
      },
      [P("p")],
    );
    const rt = createRuntime(m);
    rt.setExpression("wink", true);
    rt.update(0.1); // 0.1/0.4 = 25%
    rt.evaluate();
    expect(rt.getParamValue("p")).toBeCloseTo(0.25, 12);
    rt.update(0.4); // overshoots → clamp at 1
    rt.evaluate();
    expect(rt.getParamValue("p")).toBe(1);
    rt.setExpression("wink", false);
    rt.update(0.1); // 1 − 0.1/0.2 = 0.5
    rt.evaluate();
    expect(rt.getParamValue("p")).toBeCloseTo(0.5, 12);
  });

  it("reverses a fade from its current weight at the new direction's fixed rate", () => {
    const model = makeModel(
      {
        expressions: {
          "e.exp.json": {
            id: "pulse",
            fade_in: 1,
            fade_out: 2,
            params: [{ id: "p", value: 1, blend: "overwrite" }],
          },
        },
      },
      [P("p")],
    );
    const runtime = createRuntime(model);
    runtime.setExpression("pulse", true);
    runtime.update(0.4);
    expect(runtime.getExpressionWeight("pulse")).toBeCloseTo(0.4, 12);

    runtime.setExpression("pulse", false);
    runtime.update(0.4); // fade-out rate is 1/2 weight unit per second
    expect(runtime.getExpressionWeight("pulse")).toBeCloseTo(0.2, 12);
    runtime.update(0.4);
    expect(runtime.getExpressionWeight("pulse")).toBe(0);
  });

  it("expressions apply after host input (§6.1 stage order)", () => {
    const m = makeModel(
      {
        expressions: {
          "e.exp.json": {
            id: "shut",
            params: [{ id: "eye", value: 0.2, blend: "multiply" }],
          },
        },
      },
      [P("eye", 0, 1, 1)],
    );
    const rt = createRuntime(m);
    rt.setParam("eye", 0.5);
    rt.setExpressionWeight("shut", 1);
    rt.evaluate();
    expect(rt.getParamValue("eye")).toBeCloseTo(0.1, 12); // 0.5 × 0.2
  });

  it("reactivation after a completed fade appends to activation order", () => {
    const m = makeModel(
      {
        expressions: {
          "a.exp.json": {
            id: "a",
            fade_in: 0,
            fade_out: 0,
            params: [{ id: "p", value: 0.25, blend: "overwrite" }],
          },
          "b.exp.json": {
            id: "b",
            fade_in: 0,
            fade_out: 0,
            params: [{ id: "p", value: 0.75, blend: "overwrite" }],
          },
        },
      },
      [P("p")],
    );
    const rt = createRuntime(m);
    rt.setExpression("a", true);
    rt.setExpression("b", true);
    rt.evaluate();
    expect(rt.getParamValue("p")).toBe(0.75);

    rt.setExpression("a", false);
    rt.setExpression("a", true);
    rt.evaluate();
    expect(rt.getParamValue("p")).toBe(0.25);
  });

  it("a directly held zero weight retains its activation order", () => {
    const m = makeModel(
      {
        expressions: {
          "a.exp.json": {
            id: "a",
            params: [{ id: "p", value: 0.25, blend: "overwrite" }],
          },
          "b.exp.json": {
            id: "b",
            params: [{ id: "p", value: 0.75, blend: "overwrite" }],
          },
        },
      },
      [P("p")],
    );
    const rt = createRuntime(m);
    rt.setExpression("a", true);
    rt.setExpression("b", true);
    rt.setExpressionWeight("a", 0);
    rt.update(0.1);
    rt.setExpressionWeight("a", 1);
    rt.evaluate();
    expect(rt.getParamValue("p")).toBe(0.75);
  });
});

describe("bezier easing (§10.2)", () => {
  it("solves x(t) within 1e-4", () => {
    // cp [0.4, 0, 0.6, 1] — the spec example's ease-in-out.
    const y = cubicBezierEase([0.4, 0, 0.6, 1], 0.5);
    expect(y).toBeCloseTo(0.5, 4); // symmetric curve passes through (0.5, 0.5)
    expect(cubicBezierEase([0.4, 0, 0.6, 1], 0)).toBe(0);
    expect(cubicBezierEase([0.4, 0, 0.6, 1], 1)).toBe(1);
  });

  it("handles extreme flat-tangent control points via bisection", () => {
    // x1=x2=1, degenerate: x(u) has a flat region near u=1.
    const y25 = cubicBezierEase([1, 0, 1, 1], 0.25);
    // Reference cubic-bezier(1,0,1,1) at s=0.25 (computed independently):
    // x(u)=3u(1-u)²+3u²(1-u)+u³ … with x1=x2=1: x(u) = 3u−3u²+u³·1 …
    // just assert monotonicity and bounds; exactness is covered by m12 goldens.
    expect(y25).toBeGreaterThanOrEqual(0);
    expect(y25).toBeLessThanOrEqual(1);
    const y75 = cubicBezierEase([1, 0, 1, 1], 0.75);
    expect(y75).toBeGreaterThanOrEqual(y25);
  });

  it("allows y overshoot outside [0,1]", () => {
    const y = cubicBezierEase([0.4, -2, 0.6, 3], 0.5);
    expect(Number.isFinite(y)).toBe(true);
  });
});

describe("motion sampling and layering (§10.2)", () => {
  const track: MotionTrack = {
    param: "p",
    keys: [
      { t: 0, v: 0, ease: { type: "linear" } },
      { t: 1, v: 1, ease: { type: "linear" } },
      { t: 2, v: 0.5, ease: { type: "step" } },
    ],
  };

  it("samples linear and step segments; ease belongs to the ending key", () => {
    expect(sampleTrack(track, 0.5)).toBeCloseTo(0.5, 12);
    // Step segment (1→2): holds the previous key's value until t=2.
    expect(sampleTrack(track, 1.5)).toBe(1);
    expect(sampleTrack(track, 2)).toBe(0.5);
  });

  it("holds boundary values outside the key range", () => {
    expect(sampleTrack(track, -1)).toBe(0);
    expect(sampleTrack(track, 99)).toBe(0.5);
  });

  it("loop wraps modulo duration; non-loop holds the end", () => {
    const loop = { id: "l", duration: 2, loop: true, tracks: [] };
    const once = { id: "o", duration: 2, loop: false, tracks: [] };
    expect(motionLocalTime(loop, 2.5)).toBeCloseTo(0.5, 12);
    expect(motionLocalTime(once, 2.5)).toBe(2);
  });

  it("layers motions by start order with lerp at fractional weights", () => {
    const m = makeModel(
      {
        motions: {
          "a.motion.json": {
            id: "a",
            duration: 10,
            tracks: [{ param: "p", keys: [{ t: 0, v: 0.8 }] }],
          },
          "b.motion.json": {
            id: "b",
            duration: 10,
            tracks: [{ param: "p", keys: [{ t: 0, v: 0.2 }] }],
          },
        },
      },
      [P("p", 0, 1, 0.5)],
    );
    const rt = createRuntime(m);
    rt.playMotion("a", 1); // overwrites: 0.8
    rt.playMotion("b", 0.5); // lerp(0.8, 0.2, 0.5) = 0.5
    rt.evaluate();
    expect(rt.getParamValue("p")).toBeCloseTo(0.5, 12);
    // Host input overwrites motions (stage 3 above stage 2).
    rt.setParam("p", 0.9);
    rt.evaluate();
    expect(rt.getParamValue("p")).toBeCloseTo(0.9, 12);
    rt.clearParam("p");
    rt.stopMotion("b");
    rt.evaluate();
    expect(rt.getParamValue("p")).toBeCloseTo(0.8, 12);
  });

  it("keeps an active motion intact when replay is rejected for an invalid weight", () => {
    const model = makeModel(
      {
        motions: {
          "move.motion.json": {
            id: "move",
            duration: 1,
            tracks: [
              {
                param: "p",
                keys: [
                  { t: 0, v: 0 },
                  { t: 1, v: 1 },
                ],
              },
            ],
          },
        },
      },
      [P("p")],
    );
    const rt = createRuntime(model);
    rt.playMotion("move");
    rt.update(0.25);
    expect(() => rt.playMotion("move", Number.NaN)).toThrow(/finite/);
    rt.update(0.25);
    rt.evaluate();
    expect(rt.getParamValue("p")).toBeCloseTo(0.5, 12);
  });

  it("samples an adjacent-double step key identically after bulk and split updates", () => {
    const boundary = nextUp(10);
    const model = makeModel(
      {
        motions: {
          "motions/edge.motion.json": {
            id: "edge",
            duration: 20,
            tracks: [
              {
                param: "p",
                keys: [
                  { t: 0, v: 0 },
                  { t: boundary, v: 1, ease: "step" },
                ],
              },
            ],
          },
        },
      },
      [P("p")],
    );
    const bulk = createRuntime(model);
    const split = createRuntime(model);
    bulk.playMotion("edge");
    split.playMotion("edge");

    bulk.update(10);
    for (let i = 0; i < 600; i++) split.update(1 / 60);
    bulk.evaluate();
    split.evaluate();

    expect(bulk.getParamValue("p")).toBe(0);
    expect(split.getParamValue("p")).toBe(bulk.getParamValue("p"));
  });
});

describe("runtime fixed-step chronology (§9–§11)", () => {
  const dynamicPhysics = () =>
    makeModel(
      {
        motions: {
          "motions/drive.motion.json": {
            id: "drive",
            duration: 1,
            tracks: [
              {
                param: "drive",
                keys: [
                  { t: 0, v: 0 },
                  { t: 1, v: 1 },
                ],
              },
            ],
          },
        },
        expressions: {
          "expressions/fade.exp.json": {
            id: "fade",
            fade_in: 1,
            fade_out: 1,
            params: [{ id: "drive", value: 1, blend: "overwrite" }],
          },
        },
        physics: {
          fps: 10,
          chains: [
            {
              id: "strand",
              inputs: [{ param: "drive", type: "x", weight: 50 }],
              links: [{ length: 100, damping: 0, stiffness: 0 }],
              gravity: [0, 0],
              wind: [0, 0],
              outputs: [],
            },
          ],
        },
      },
      [P("drive")],
    );

  it("samples moving physics inputs at each chronological step boundary", () => {
    const oneUpdate = createRuntime(dynamicPhysics());
    const twoUpdates = createRuntime(dynamicPhysics());
    oneUpdate.playMotion("drive");
    twoUpdates.playMotion("drive");

    oneUpdate.update(0.2);
    twoUpdates.update(0.1);
    twoUpdates.update(0.1);

    expect(oneUpdate.physics!.linkAngles("strand")).toEqual(
      twoUpdates.physics!.linkAngles("strand"),
    );
  });

  it("samples motion and expression clocks identically at 600 bulk/split boundaries", () => {
    const boundary = nextUp(10);
    const model = makeModel(
      {
        motions: {
          "motions/edge.motion.json": {
            id: "edge",
            duration: 20,
            tracks: [
              {
                param: "motion_drive",
                keys: [
                  { t: 0, v: 0 },
                  { t: boundary, v: 1, ease: "step" },
                ],
              },
            ],
          },
        },
        expressions: {
          "expressions/fade.exp.json": {
            id: "fade",
            fade_in: 20,
            params: [{ id: "expression_drive", value: 1, blend: "overwrite" }],
          },
        },
        physics: {
          fps: 60,
          chains: [
            {
              id: "motion_chain",
              inputs: [{ param: "motion_drive", type: "x", weight: 50 }],
              links: [{ length: 100, damping: 0, stiffness: 0 }],
              gravity: [0, 0],
              wind: [0, 0],
              outputs: [],
            },
            {
              id: "expression_chain",
              inputs: [{ param: "expression_drive", type: "x", weight: 50 }],
              links: [{ length: 100, damping: 0, stiffness: 0 }],
              gravity: [0, 0],
              wind: [0, 0],
              outputs: [],
            },
          ],
        },
      },
      [P("motion_drive"), P("expression_drive")],
    );
    const bulk = createRuntime(model);
    const split = createRuntime(model);
    for (const runtime of [bulk, split]) {
      runtime.playMotion("edge");
      runtime.setExpression("fade", true);
    }

    const bulkTrace: number[][] = [];
    const splitTrace: number[][] = [];
    const record = (runtime: typeof bulk, trace: number[][]): void => {
      trace.push([
        ...runtime.physics!.linkAngles("motion_chain"),
        ...runtime.physics!.linkAngles("expression_chain"),
      ]);
    };
    bulk.update(10, () => record(bulk, bulkTrace));
    for (let i = 0; i < 600; i++) {
      split.update(1 / 60, () => record(split, splitTrace));
    }

    expect(bulkTrace).toHaveLength(600);
    expect(splitTrace).toEqual(bulkTrace);
    expect(split.getExpressionWeight("fade")).toBe(bulk.getExpressionWeight("fade"));
    bulk.evaluate();
    split.evaluate();
    expect(bulk.getParamValue("motion_drive")).toBe(0);
    expect(split.getParamValue("motion_drive")).toBe(0);
    expect(split.getParamValue("expression_drive")).toBe(bulk.getParamValue("expression_drive"));
  });

  it("rolls back compensated motion and expression clock components", () => {
    const runtime = createRuntime(dynamicPhysics());
    runtime.playMotion("drive");
    runtime.setExpression("fade", true);
    runtime.physicsEnabled = false;
    for (let i = 0; i < 59; i++) runtime.update(1 / 60);
    runtime.physicsEnabled = true;

    type RuntimeClockInternals = {
      activeMotions: Array<{ time: number; timeError: number }>;
      expressionStates: Map<
        string,
        { weight: number; fadeElapsed: number; fadeElapsedError: number }
      >;
    };
    const internals = runtime as unknown as RuntimeClockInternals;
    const readClock = () => {
      const expression = internals.expressionStates.get("fade")!;
      return {
        motionTime: internals.activeMotions[0]!.time,
        motionError: internals.activeMotions[0]!.timeError,
        expressionWeight: expression.weight,
        expressionElapsed: expression.fadeElapsed,
        expressionError: expression.fadeElapsedError,
      };
    };
    const before = readClock();
    expect(before.motionError).not.toBe(0);
    expect(before.expressionError).not.toBe(0);

    expect(() =>
      runtime.update(0.1, () => {
        throw new Error("observer failed");
      }),
    ).toThrow(/observer failed/);
    expect(readClock()).toEqual(before);
  });

  it("rejects recursive updates without overwriting the outer rollback snapshot", () => {
    const runtime = createRuntime(dynamicPhysics());
    runtime.playMotion("drive");
    const before = runtime.physics!.linkAngles("strand");

    expect(() => runtime.update(0.2, () => runtime.update(0.1))).toThrow(
      /cannot update while a runtime update is in progress/,
    );
    expect(runtime.physics!.linkAngles("strand")).toEqual(before);
    runtime.evaluate();
    expect(runtime.getParamValue("drive")).toBe(0);

    // The guard and all rollback snapshots are released after the failed call.
    runtime.update(0.1);
    runtime.evaluate();
    expect(runtime.getParamValue("drive")).toBeCloseTo(0.1, 12);
  });

  it("rejects structural motion/expression mutation from a step observer", () => {
    const runtime = createRuntime(dynamicPhysics());
    runtime.playMotion("drive");
    runtime.setExpression("fade", true);
    const before = runtime.physics!.linkAngles("strand");

    for (const mutate of [
      () => runtime.playMotion("drive"),
      () => runtime.stopMotion("drive"),
      () => runtime.setExpression("fade", false),
      () => runtime.setExpressionWeight("fade", 0.5),
    ]) {
      expect(() => runtime.update(0.1, mutate)).toThrow(/while a runtime update is in progress/);
      expect(runtime.physics!.linkAngles("strand")).toEqual(before);
      expect(runtime.getExpressionWeight("fade")).toBe(0);
      runtime.evaluate();
      expect(runtime.getParamValue("drive")).toBe(0);
    }

    runtime.update(0.1);
    expect(runtime.getExpressionWeight("fade")).toBeCloseTo(0.1, 12);
  });

  it("rejects excessive catch-up before advancing motion clocks", () => {
    const runtime = createRuntime(dynamicPhysics());
    runtime.playMotion("drive");
    expect(() => runtime.update(10_000)).toThrow(/physics update/);
    runtime.evaluate();
    expect(runtime.getParamValue("drive")).toBe(0);
  });

  it("does not charge empty motion wrappers or held-zero expression entries", () => {
    const motions: Record<string, unknown> = {};
    const expressions: Record<string, unknown> = {};
    for (let i = 0; i < 256; i++) {
      motions[`motions/m${i}.motion.json`] = {
        id: `m${i}`,
        duration: 1,
        loop: true,
        tracks: [],
      };
      expressions[`expressions/e${i}.exp.json`] = {
        id: `e${i}`,
        params: [{ id: "p", value: 1, blend: "overwrite" }],
      };
    }
    const runtime = createRuntime(
      makeModel(
        {
          motions,
          expressions,
          physics: { fps: 1, chains: [] },
        },
        [P("p")],
      ),
    );
    for (let i = 0; i < 256; i++) {
      runtime.playMotion(`m${i}`);
      runtime.setExpressionWeight(`e${i}`, 0);
    }
    expect(() => runtime.update(10_000)).not.toThrow();
  });

  it("charges exactly one default source visit per parameter and fixed-step sample", () => {
    const params = Array.from({ length: 1_000 }, (_, i) => P(`p_${i}`));
    const atLimit = createRuntime(makeModel({ physics: { fps: 1, chains: [] } }, params));
    // 1,000 defaults × 10,000 samples = the exact 10,000,000-unit ceiling.
    expect(() => atLimit.update(10_000)).not.toThrow();

    const aboveLimit = createRuntime(
      makeModel({ physics: { fps: 1, chains: [] } }, [...params, P("one_more")]),
    );
    expect(() => aboveLimit.update(10_000)).toThrow(/work units/);
  });

  it("rolls back clocks and physics when a later boundary composition fails", () => {
    const runtime = createRuntime(
      makeModel(
        {
          expressions: {
            "expressions/grow.exp.json": {
              id: "grow",
              fade_in: 1,
              params: [{ id: "p", value: 2, blend: "multiply" }],
            },
          },
          physics: {
            fps: 10,
            chains: [
              {
                id: "strand",
                inputs: [],
                links: [{ length: 100, damping: 0, stiffness: 0 }],
                gravity: [100, 0],
                wind: [0, 0],
                outputs: [],
              },
            ],
          },
        },
        [P("p", 0, 1e12, 0)],
      ),
    );
    runtime.setParam("p", Number.MAX_VALUE);
    runtime.setExpression("grow", true);

    expect(() => runtime.update(1)).toThrow(/expression "grow" output/);
    expect(runtime.getExpressionWeight("grow")).toBe(0);
    expect(runtime.physics!.linkAngles("strand")).toEqual([0]);
  });
});
