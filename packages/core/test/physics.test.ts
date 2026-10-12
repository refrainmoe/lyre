import { describe, expect, it } from "vitest";
import {
  LIMITS,
  RUNTIME_LIMITS,
  fixedStepCount,
  normalizedInput,
  restDirection,
  PhysicsEngine,
} from "../src/index.js";
import type { ParamDef, PhysicsDef } from "../src/index.js";

const param = (id: string, min: number, max: number, dflt: number): ParamDef => ({
  id,
  min,
  max,
  default: dflt,
  wrap: false,
});

function engine(def: Partial<PhysicsDef["chains"][0]>, params: ParamDef[] = []) {
  const physics: PhysicsDef = {
    fps: 60,
    chains: [
      {
        id: "c",
        inputs: [],
        links: [{ length: 100, damping: 0.1, stiffness: 0.05 }],
        gravity: [0, 900],
        wind: [0, 0],
        outputs: [],
        ...def,
      },
    ],
  };
  const map = new Map(params.map((p) => [p.id, p]));
  return { eng: new PhysicsEngine(physics, map), params: map };
}

const valuesOf = (entries: Array<[string, number]>) => new Map(entries);

describe("normalizedInput (§9)", () => {
  it("centres the default at zero for asymmetric ranges", () => {
    const p = param("p", 0, 1, 0.3);
    expect(normalizedInput(p, 0.3)).toBe(0);
    expect(normalizedInput(p, 1)).toBe(1);
    expect(normalizedInput(p, 0)).toBe(-1);
    expect(normalizedInput(p, 0.65)).toBeCloseTo(0.5, 12);
    expect(normalizedInput(p, 0.15)).toBeCloseTo(-0.5, 12);
  });

  it("maps degenerate half-intervals to 0", () => {
    const atMin = param("p", 0, 1, 0);
    expect(normalizedInput(atMin, 0)).toBe(0); // default == min: lower half degenerate
    const atMax = param("p", 0, 1, 1);
    expect(normalizedInput(atMax, 1)).toBe(0); // upper half degenerate
  });

  it("holds normalization at the declared boundaries for out-of-range host input", () => {
    const p = param("p", -1, 1, 0);
    expect(normalizedInput(p, Number.MAX_VALUE)).toBe(1);
    expect(normalizedInput(p, -Number.MAX_VALUE)).toBe(-1);
  });
});

describe("restDirection (§9)", () => {
  it("points straight down at φ=0 and rotates clockwise", () => {
    expect(restDirection(0)).toEqual([-0, 1]);
    const [x, y] = restDirection(90);
    expect(x).toBeCloseTo(-1, 12); // down rotated 90° clockwise (viewer) → left
    expect(y).toBeCloseTo(0, 12);
  });
});

describe("PhysicsEngine (§9)", () => {
  it("rejects impractical fps and unbounded catch-up work", () => {
    const chain: PhysicsDef["chains"][0] = {
      id: "c",
      inputs: [],
      links: [{ length: 10, damping: 0, stiffness: 0 }],
      gravity: [0, 0],
      wind: [0, 0],
      outputs: [],
    };
    expect(
      () => new PhysicsEngine({ fps: LIMITS.physicsFps + 1, chains: [chain] }, new Map()),
    ).toThrow(/fps/);

    const eng = new PhysicsEngine({ fps: LIMITS.physicsFps, chains: [chain] }, new Map());
    eng.reset(new Map());
    expect(() => eng.advance(1000, () => new Map())).toThrow(/fixed steps/);
    expect(() => eng.advance(Number.POSITIVE_INFINITY, () => new Map())).toThrow(/finite/);
  });

  it("charges all four per-step solver visits for every link before mutation", () => {
    const linkCounts = [64, 64, 64, 64, 54, 1];
    const chains: PhysicsDef["chains"] = linkCounts.map((linkCount, i) => ({
      id: `c${i}`,
      inputs: [],
      links: Array.from({ length: linkCount }, () => ({
        length: 10,
        damping: 0,
        stiffness: 0,
      })),
      gravity: [0, 0],
      wind: [0, 0],
      outputs: [],
    }));
    const eng = new PhysicsEngine({ fps: 1, chains }, new Map());

    // Six chain visits plus four visits for each of 311 links (rest, Verlet,
    // stiffness, constraint) is 1,250 units/step. Step 8,000 lands exactly on
    // the 10,000,000-unit ceiling; step 8,001 is the first over it.
    const workPerStep = chains.length + 4 * linkCounts.reduce((sum, count) => sum + count, 0);
    const acceptedSteps = Math.floor(RUNTIME_LIMITS.physicsWorkUnitsPerUpdate / workPerStep);
    expect(workPerStep * 8_000).toBe(RUNTIME_LIMITS.physicsWorkUnitsPerUpdate);
    expect(acceptedSteps).toBe(8_000);
    expect(eng.preflightAdvance(acceptedSteps)).toBe(acceptedSteps);

    let samples = 0;
    expect(() =>
      eng.advance(acceptedSteps + 1, () => {
        samples++;
        throw new Error("sample callback must not run");
      }),
    ).toThrow(/work units/);
    expect(samples).toBe(0);
    expect(eng.preflightAdvance(acceptedSteps)).toBe(acceptedSteps);
  });

  it("charges no phantom solver visit when a physics definition has no chains", () => {
    const eng = new PhysicsEngine({ fps: 1, chains: [] }, new Map());
    expect(eng.preflightAdvance(RUNTIME_LIMITS.physicsStepsPerUpdate, 1_000)).toBe(
      RUNTIME_LIMITS.physicsStepsPerUpdate,
    );
    expect(() => eng.preflightAdvance(RUNTIME_LIMITS.physicsStepsPerUpdate, 1_001)).toThrow(
      /work units/,
    );
  });

  it("owns and freezes the definition shape used by cached work accounting", () => {
    const chain: PhysicsDef["chains"][number] = {
      id: "c",
      inputs: [],
      links: [{ length: 10, damping: 0, stiffness: 0 }],
      gravity: [0, 0],
      wind: [0, 0],
      outputs: [],
    };
    const def: PhysicsDef = { fps: 1, chains: [chain] };
    const eng = new PhysicsEngine(def, new Map());

    // Mutating the caller-owned definition cannot change the engine's loops
    // after its work budget and fixed-size state arrays have been created.
    chain.inputs.push({ param: "late", type: "x", weight: 1 });
    chain.links.push({ length: 20, damping: 0, stiffness: 0 });
    expect(eng.def.chains[0]!.inputs).toHaveLength(0);
    expect(eng.def.chains[0]!.links).toHaveLength(1);

    // Nor can callers invalidate the cache through the exposed snapshot.
    expect(() => eng.def.chains[0]!.inputs.push({ param: "late", type: "x", weight: 1 })).toThrow(
      TypeError,
    );
    expect(() => eng.def.chains[0]!.links.push({ length: 20, damping: 0, stiffness: 0 })).toThrow(
      TypeError,
    );
    expect(eng.preflightAdvance(RUNTIME_LIMITS.physicsStepsPerUpdate)).toBe(
      RUNTIME_LIMITS.physicsStepsPerUpdate,
    );
  });

  it("snapshots parameter definitions used by normalization and outputs", () => {
    const drive = param("drive", -1, 1, 0);
    const params = new Map([[drive.id, drive]]);
    const def: PhysicsDef = {
      fps: 1,
      chains: [
        {
          id: "c",
          inputs: [{ param: "drive", type: "x", weight: 50 }],
          links: [{ length: 10, damping: 0, stiffness: 0 }],
          gravity: [0, 0],
          wind: [0, 0],
          outputs: [],
        },
      ],
    };
    const eng = new PhysicsEngine(def, params);
    const control = new PhysicsEngine(def, new Map([[drive.id, { ...drive }]]));
    const rest = valuesOf([["drive", 0]]);
    eng.reset(rest);
    control.reset(rest);

    drive.max = 1_000;
    params.clear();
    const moved = valuesOf([["drive", 1]]);
    eng.step(moved);
    control.step(moved);
    expect(eng.linkAngles("c")).toEqual(control.linkAngles("c"));
  });

  it("rejects non-finite sampled inputs without corrupting the chain", () => {
    const p = param("sway", -1, 1, 0);
    const { eng } = engine({ inputs: [{ param: "sway", type: "x", weight: 10 }] }, [p]);
    eng.reset(valuesOf([["sway", 0]]));
    expect(() => eng.step(valuesOf([["sway", Number.NaN]]))).toThrow(/must be finite/);
    expect(eng.linkAngles("c")[0]).toBe(0);
  });

  it("rolls back every chain when a public one-step call or reset fails late", () => {
    const drive = param("drive", -1, 1, 0);
    const first: PhysicsDef["chains"][number] = {
      id: "first",
      inputs: [],
      links: [{ length: 10, damping: 0, stiffness: 0 }],
      gravity: [100, 0],
      wind: [0, 0],
      outputs: [],
    };
    const second: PhysicsDef["chains"][number] = {
      id: "second",
      inputs: [{ param: "drive", type: "x", weight: 1 }],
      links: [{ length: 10, damping: 0, stiffness: 0 }],
      gravity: [0, 0],
      wind: [0, 0],
      outputs: [],
    };
    const eng = new PhysicsEngine(
      { fps: 1, chains: [first, second] },
      new Map([[drive.id, drive]]),
    );
    eng.reset(valuesOf([["drive", 0]]));
    const before = eng.linkAngles("first");

    expect(() => eng.step(valuesOf([["drive", Number.NaN]]))).toThrow(/must be finite/);
    expect(eng.linkAngles("first")).toEqual(before);

    eng.step(valuesOf([["drive", 0]]));
    const moved = eng.linkAngles("first");
    expect(moved).not.toEqual(before);
    expect(() => eng.reset(valuesOf([["drive", Number.NaN]]))).toThrow(/must be finite/);
    expect(eng.linkAngles("first")).toEqual(moved);
  });

  it("rejects mutating reentrancy without overwriting the outer rollback snapshot", () => {
    const { eng } = engine({ gravity: [100, 0] });
    const values = valuesOf([]);
    eng.reset(values);
    const before = eng.linkAngles("c");
    let samples = 0;

    expect(() =>
      eng.advance(2 * eng.stepDt, () => {
        samples++;
        if (samples === 2) eng.step(values);
        return values;
      }),
    ).toThrow(/cannot be re-entered/);
    expect(samples).toBe(2);
    expect(eng.linkAngles("c")).toEqual(before);

    // The guard is cleared after rollback; a later independent mutation works.
    eng.step(values);
    expect(eng.linkAngles("c")).not.toEqual(before);
  });

  it("bounds perturbation to finite, non-reentrant transactional mutations", () => {
    const { eng } = engine({ gravity: [100, 0] });
    const values = valuesOf([]);
    eng.reset(values);
    const before = eng.linkAngles("c");

    expect(() => eng.perturbLinks(Number.NaN)).toThrow(/finite/);
    expect(eng.linkAngles("c")).toEqual(before);
    expect(() =>
      eng.advance(eng.stepDt, () => {
        eng.perturbLinks(1e-9);
        return values;
      }),
    ).toThrow(/cannot be re-entered/);
    expect(eng.linkAngles("c")).toEqual(before);

    eng.perturbLinks(1e-9);
    expect(eng.linkAngles("c")).not.toEqual(before);
  });

  it("rest inputs produce identically zero output forever", () => {
    const { eng } = engine({});
    eng.reset(valuesOf([]));
    const values = valuesOf([]);
    for (let i = 0; i < 600; i++) eng.step(values);
    // Chain hangs straight down under gravity, exactly at the rest chain.
    expect(eng.linkAngles("c")[0]).toBe(0);
  });

  it("initializes p=q=rest at the then-current parameter values", () => {
    const p = param("sway", -1, 1, 0);
    const { eng } = engine({ inputs: [{ param: "sway", type: "x", weight: 50 }] }, [p]);
    eng.reset(valuesOf([["sway", 1]])); // anchor displaced 50px right at reset
    // No step yet: outputs are zero because the chain sits on its rest chain.
    expect(eng.linkAngles("c")[0]).toBe(0);
  });

  it("an anchor x-displacement swings the link opposite the motion", () => {
    const p = param("sway", -1, 1, 0);
    const { eng } = engine({ inputs: [{ param: "sway", type: "x", weight: 50 }] }, [p]);
    eng.reset(valuesOf([["sway", 0]]));
    eng.step(valuesOf([["sway", 1]])); // anchor jumps +50 in x
    const angle = eng.linkAngles("c")[0]!;
    // Link tip lags behind → direction tilts toward down-left. On a clock
    // face, moving from 6 toward 7–8 o'clock is clockwise, i.e. positive (§4).
    expect(angle).toBeGreaterThan(1);
  });

  it("angle inputs rotate the whole rest frame, keeping outputs at zero", () => {
    const p = param("roll", -30, 30, 0);
    const { eng } = engine(
      { inputs: [{ param: "roll", type: "angle", weight: 1 }], gravity: [0, 0] },
      [p],
    );
    eng.reset(valuesOf([["roll", 30]])); // φ = 30°
    // With no gravity the chain stays on the rotated rest chain; the output
    // measures against d̂(φ), so it remains 0.
    eng.step(valuesOf([["roll", 30]]));
    expect(eng.linkAngles("c")[0]!).toBeCloseTo(0, 10);
  });

  it("applies the exact zero-vector rule (§9)", () => {
    // Gravity off; anchor teleports by exactly the link length so the Verlet
    // step leaves p₁ exactly on top of the new anchor.
    const p = param("jump", 0, 1, 0);
    const { eng } = engine(
      {
        inputs: [{ param: "jump", type: "y", weight: 100 }],
        links: [{ length: 100, damping: 0, stiffness: 0 }],
        gravity: [0, 0],
      },
      [p],
    );
    eng.reset(valuesOf([["jump", 0]]));
    // p₁ rests at (0, 100). Anchor moves to (0, 100): direction = exact zero.
    eng.step(valuesOf([["jump", 1]]));
    expect(eng.zeroVectorCount).toBe(1);
    expect(() => ((eng as unknown as { zeroVectorCount: number }).zeroVectorCount = 99)).toThrow();
    expect(eng.zeroVectorCount).toBe(1);
    // Fallback direction d̂(φ=0) = down: p₁ = anchor + 100·down = (0, 200).
    expect(eng.linkAngles("c")[0]).toBe(0);
  });

  it("normalizes a finite displacement whose unscaled norm would overflow", () => {
    const chain: PhysicsDef["chains"][0] = {
      id: "extreme",
      inputs: [],
      links: [{ length: 100, damping: 0, stiffness: 0 }],
      gravity: [1e12, 1e12],
      wind: [0, 0],
      outputs: [],
    };
    const eng = new PhysicsEngine({ fps: 1e-148, chains: [chain] }, new Map());
    eng.reset(new Map());
    eng.step(new Map());
    expect(eng.linkAngles("extreme")[0]).toBeCloseTo(-45, 10);
  });

  it("writes outputs as default + angle·multiplier (overwrite) and adds (add)", () => {
    const sway = param("sway", -1, 1, 0);
    const out1 = param("out1", -90, 90, 5);
    const out2 = param("out2", -90, 90, 1);
    const { eng } = engine(
      {
        inputs: [{ param: "sway", type: "x", weight: 50 }],
        outputs: [
          { link: 0, param: "out1", multiplier: 2, blend: "overwrite" },
          { link: 0, param: "out2", multiplier: 1, blend: "add" },
        ],
      },
      [sway, out1, out2],
    );
    eng.reset(valuesOf([["sway", 0]]));
    eng.step(valuesOf([["sway", 1]]));
    const angle = eng.linkAngles("c")[0]!;
    const values = valuesOf([
      ["sway", 1],
      ["out1", 99], // stage ≤4 value is ignored by overwrite
      ["out2", 1],
    ]);
    eng.applyOutputs(values);
    expect(values.get("out1")).toBeCloseTo(5 + angle * 2, 12);
    expect(values.get("out2")).toBeCloseTo(1 + angle, 12);
  });

  it("composes colliding overwrite/add outputs independently of chain order", () => {
    const drive = param("drive", -1, 1, 0);
    const out = param("out", -360, 360, 5);
    const params = new Map([
      [drive.id, drive],
      [out.id, out],
    ]);
    const chain = (
      id: string,
      blend: "overwrite" | "add",
      multiplier: number,
    ): PhysicsDef["chains"][0] => ({
      id,
      inputs: [{ param: "drive", type: "x", weight: 50 }],
      links: [{ length: 100, damping: 0.1, stiffness: 0.05 }],
      gravity: [0, 900],
      wind: [0, 0],
      outputs: [{ link: 0, param: "out", multiplier, blend }],
    });
    const overwrite = chain("z_overwrite", "overwrite", 2);
    const add = chain("a_add", "add", 3);

    const run = (chains: PhysicsDef["chains"]) => {
      const eng = new PhysicsEngine({ fps: 60, chains }, params);
      eng.reset(
        valuesOf([
          ["drive", 0],
          ["out", 99],
        ]),
      );
      eng.step(
        valuesOf([
          ["drive", 1],
          ["out", 99],
        ]),
      );
      const expected =
        out.default + eng.linkAngles("z_overwrite")[0]! * 2 + eng.linkAngles("a_add")[0]! * 3;
      const values = valuesOf([
        ["drive", 1],
        ["out", 99], // ignored as a base because an overwrite exists
      ]);
      eng.applyOutputs(values);
      expect(values.get("out")).toBeCloseTo(expected, 12);
      return values.get("out");
    };

    expect(run([overwrite, add])).toBe(run([add, overwrite]));
  });

  it("rejects multiple overwrite outputs targeting one parameter", () => {
    const out = param("out", -90, 90, 0);
    const chain = (id: string): PhysicsDef["chains"][0] => ({
      id,
      inputs: [],
      links: [{ length: 10, damping: 0, stiffness: 0 }],
      gravity: [0, 0],
      wind: [0, 0],
      outputs: [{ link: 0, param: "out", multiplier: 1, blend: "overwrite" }],
    });
    expect(
      () =>
        new PhysicsEngine({ fps: 60, chains: [chain("a"), chain("b")] }, new Map([["out", out]])),
    ).toThrow(/overwrite outputs/);
  });

  it("advances on a fixed-timestep accumulator", () => {
    const { eng } = engine({ gravity: [100, 0] });
    eng.reset(valuesOf([]));
    const sample = () => valuesOf([]);
    // Two updates of half a step each → exactly one step total.
    eng.advance(1 / 120, sample);
    const afterHalf = eng.linkAngles("c")[0]!;
    expect(afterHalf).toBe(0); // no step ran yet
    eng.advance(1 / 120, sample);
    const afterFull = eng.linkAngles("c")[0]!;
    expect(afterFull).not.toBe(0);
  });

  it("snaps only binary64 noise at fixed-step boundaries", () => {
    const chain: PhysicsDef["chains"][number] = {
      id: "c",
      inputs: [],
      links: [{ length: 10, damping: 0, stiffness: 0 }],
      gravity: [0, 0],
      wind: [0, 0],
      outputs: [],
    };

    // This quotient is one representable value below 600, despite the input
    // being written as the normative N/fps interval.
    const ordinary = new PhysicsEngine({ fps: 59.94, chains: [chain] }, new Map());
    expect(600 / 59.94 / ordinary.stepDt).toBeLessThan(600);
    expect(ordinary.preflightAdvance(600 / 59.94)).toBe(600);

    // This decimal is genuinely half a billionth of a step short at 10 s.
    // The §9/§12 floor rule therefore requires nine steps, not ten.
    const nearBoundaryFps = 0.99999999995;
    const nearBoundary = new PhysicsEngine({ fps: nearBoundaryFps, chains: [chain] }, new Map());
    expect(10 / nearBoundary.stepDt).toBeCloseTo(10 * nearBoundaryFps, 14);
    expect(nearBoundary.preflightAdvance(10)).toBe(9);
    expect(nearBoundary.plannedInputSlices(10)).toHaveLength(9);
  });

  it("counts endpoint-derived common and fractional cadences from total elapsed time", () => {
    const runCadence = (scriptFps: number): number[] => {
      const eng = new PhysicsEngine({ fps: 60, chains: [] }, new Map());
      const callbacks: number[] = [];
      let elapsed = 0;
      for (let frame = 0; elapsed < 10; frame++) {
        const endpoint = Math.min(10, (frame + 1) / scriptFps);
        let count = 0;
        eng.advance(
          endpoint - elapsed,
          () => new Map(),
          undefined,
          () => count++,
        );
        callbacks.push(count);
        elapsed = endpoint;
      }
      return callbacks;
    };

    const common = runCadence(60);
    expect(common).toHaveLength(600);
    expect(common.every((count) => count === 1)).toBe(true);

    const fractional = runCadence(23.976);
    expect(fractional.reduce((sum, count) => sum + count, 0)).toBe(fixedStepCount(10, 1 / 60));
    expect(fractional.reduce((sum, count) => sum + count, 0)).toBe(600);
  });

  it("rolls back compensated elapsed time and the completed-step ordinal", () => {
    const make = () => new PhysicsEngine({ fps: 60, chains: [] }, new Map());
    const failed = make();
    const control = make();
    const sample = () => new Map<string, number>();
    for (let i = 0; i < 599; i++) {
      failed.advance(1 / 60, sample);
      control.advance(1 / 60, sample);
    }

    type ClockInternals = {
      accumulator: number;
      accumulatorError: number;
      completedSteps: number;
    };
    const clock = failed as unknown as ClockInternals;
    const readClock = () => ({
      accumulator: clock.accumulator,
      accumulatorError: clock.accumulatorError,
      completedSteps: clock.completedSteps,
    });
    const before = readClock();
    expect(before.accumulatorError).not.toBe(0);
    expect(() =>
      failed.advance(1 / 60, sample, undefined, () => {
        throw new Error("observer failed");
      }),
    ).toThrow(/observer failed/);
    expect(readClock()).toEqual(before);

    let failedCallbacks = 0;
    let controlCallbacks = 0;
    failed.advance(1 / 60, sample, undefined, () => failedCallbacks++);
    control.advance(1 / 60, sample, undefined, () => controlCallbacks++);
    expect(failedCallbacks).toBe(1);
    expect(failedCallbacks).toBe(controlCallbacks);
  });

  it("is deterministic: identical runs produce identical traces", () => {
    const make = () => {
      const p = param("sway", -1, 1, 0);
      const { eng } = engine(
        {
          inputs: [{ param: "sway", type: "x", weight: 30 }],
          links: [
            { length: 120, damping: 0.1, stiffness: 0.06 },
            { length: 140, damping: 0.12, stiffness: 0.03 },
          ],
        },
        [p],
      );
      eng.reset(valuesOf([["sway", 0]]));
      const trace: number[] = [];
      for (let i = 0; i < 600; i++) {
        const v = Math.sin(i / 30);
        eng.step(valuesOf([["sway", v]]));
        trace.push(...eng.linkAngles("c"));
      }
      return trace;
    };
    const a = make();
    const b = make();
    expect(a).toEqual(b); // bitwise identical, not just within tolerance
  });
});
