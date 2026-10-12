// §9 deterministic pendulum chains. All state and arithmetic are IEEE-754
// doubles in the exact operation order below; conformance compares per-step
// link outputs against golden traces at ±0.1°.

import type { ParamDef, PhysicsChain, PhysicsDef } from "./types/model.js";
import { LIMITS, RUNTIME_LIMITS } from "./limits.js";
import { addCompensated, compensatedValue } from "./clock.js";

/**
 * §9: piecewise-linear normalization with the default at zero:
 * [min, default] → [−1, 0], [default, max] → [0, 1]; a degenerate
 * half-interval maps to 0.
 */
export function normalizedInput(def: ParamDef, v: number): number {
  const bounded = v < def.min ? def.min : v > def.max ? def.max : v;
  if (bounded >= def.default) {
    const span = def.max - def.default;
    return span === 0 ? 0 : (bounded - def.default) / span;
  }
  const span = def.default - def.min;
  return span === 0 ? 0 : (bounded - def.default) / span;
}

interface ChainState {
  chain: PhysicsChain;
  /** Positions/previous positions; index 0 is the anchor, 1..n the links. */
  px: Float64Array;
  py: Float64Array;
  qx: Float64Array;
  qy: Float64Array;
  /** Reusable rest-chain positions populated at the start of every step. */
  rx: Float64Array;
  ry: Float64Array;
  /** Reused transaction backup for an atomic advance(). */
  rollbackPx: Float64Array;
  rollbackPy: Float64Array;
  rollbackQx: Float64Array;
  rollbackQy: Float64Array;
  rollbackPhi: number;
  /** Anchor orientation φ (degrees) of the most recent step (or reset). */
  phi: number;
}

interface AddContribution {
  chainId: string;
  link: number;
  multiplier: number;
  value: number;
}

interface ComposedOutput {
  overwrite: number | undefined;
  additions: AddContribution[];
}

/**
 * The engine caches work from the definition shape and allocates state arrays
 * to its link counts. Own and freeze that shape so mutation through either the
 * caller's object or the public `def` property cannot invalidate those caches.
 */
function snapshotPhysicsDef(def: PhysicsDef): PhysicsDef {
  const snapshot: PhysicsDef = {
    fps: def.fps,
    chains: def.chains.map((chain): PhysicsChain => ({
      id: chain.id,
      inputs: chain.inputs.map((input) => ({ ...input })),
      links: chain.links.map((link) => ({ ...link })),
      gravity: [chain.gravity[0], chain.gravity[1]],
      wind: [chain.wind[0], chain.wind[1]],
      outputs: chain.outputs.map((output) => ({ ...output })),
    })),
  };
  for (const chain of snapshot.chains) {
    for (const input of chain.inputs) Object.freeze(input);
    for (const link of chain.links) Object.freeze(link);
    for (const output of chain.outputs) Object.freeze(output);
    Object.freeze(chain.inputs);
    Object.freeze(chain.links);
    Object.freeze(chain.gravity);
    Object.freeze(chain.wind);
    Object.freeze(chain.outputs);
    Object.freeze(chain);
  }
  Object.freeze(snapshot.chains);
  Object.freeze(snapshot);
  return snapshot;
}

// Every normative solver step visits each link once while constructing the
// rest chain, then once in each of the Verlet, stiffness, and constraint
// passes (§9, §16).
const LINK_VISITS_PER_STEP = 4;

// A division that is mathematically integral can land one or two binary64
// representable values below that integer (for example (600 / 59.94) /
// (1 / 59.94)). Snap only that floating-point noise. A relative epsilon such
// as 1e-9 is far too broad: it turns a genuine 9.9999999995 steps into 10.
const FIXED_STEP_BOUNDARY_ULPS = 8;

/** §9 binary64 boundary rule for a fixed-timestep accumulator. */
export function fixedStepCount(accumulated: number, stepDt: number): number {
  const quotient = accumulated / stepDt;
  const nearest = Math.round(quotient);
  const tolerance =
    FIXED_STEP_BOUNDARY_ULPS * Number.EPSILON * Math.max(1, Math.abs(quotient), Math.abs(nearest));
  return Math.floor(Math.abs(quotient - nearest) <= tolerance ? nearest : quotient);
}

export class PhysicsEngine {
  readonly def: PhysicsDef;
  /** Fixed timestep dt = 1/fps (§9). */
  readonly stepDt: number;
  /** Count of exact zero-vector constraint fallbacks (test/corpus instrumentation). */
  private zeroVectorFallbacks = 0;

  get zeroVectorCount(): number {
    return this.zeroVectorFallbacks;
  }

  private paramsById: ReadonlyMap<string, ParamDef>;
  private chains: ChainState[];
  /** Total accepted elapsed time since reset. */
  private accumulator = 0;
  /** Low component retained so endpoint-derived deltas telescope. */
  private accumulatorError = 0;
  /** Fixed-step ordinal already committed against the total elapsed clock. */
  private completedSteps = 0;
  /**
   * Logical input clocks can be a few ULPs ahead of accepted elapsed time
   * after the boundary rule admits an early step. Retain that lead so the
   * next update does not advance the same sliver a second time.
   */
  private inputClockOffset = 0;
  private readonly stepWorkUnits: number;
  private transactionActive = false;

  constructor(def: PhysicsDef, paramsById: ReadonlyMap<string, ParamDef>) {
    if (!Number.isFinite(def.fps) || def.fps <= 0 || def.fps > LIMITS.physicsFps) {
      throw new RangeError(`physics fps must be within (0, ${LIMITS.physicsFps}]`);
    }
    const stepDt = 1 / def.fps;
    if (!Number.isFinite(stepDt) || !Number.isFinite(stepDt * stepDt)) {
      throw new RangeError(
        `physics fps is too small to produce a finite fixed timestep and squared timestep`,
      );
    }
    this.def = snapshotPhysicsDef(def);
    // The engine outlives its constructor inputs and reads parameter ranges on
    // every fixed step. Snapshot them just like the physics definition so a
    // caller cannot invalidate normalization/output assumptions after state
    // arrays and work accounting have been established.
    this.paramsById = new Map(
      Array.from(paramsById, ([id, param]) => [id, Object.freeze({ ...param })] as const),
    );
    this.stepDt = stepDt;
    const overwriteTargets = new Map<string, string>();
    let stepWorkUnits = this.def.chains.length;
    for (const chain of this.def.chains) {
      stepWorkUnits += chain.inputs.length + LINK_VISITS_PER_STEP * chain.links.length;
      const dt2 = this.stepDt * this.stepDt;
      for (let axis = 0; axis < 2; axis++) {
        const acceleration = chain.gravity[axis]! + chain.wind[axis]!;
        if (!Number.isFinite(acceleration) || !Number.isFinite(acceleration * dt2)) {
          throw new RangeError(
            `physics chain "${chain.id}" acceleration is not representable at its fixed timestep`,
          );
        }
      }
      for (const output of chain.outputs) {
        if (output.blend !== "overwrite") continue;
        const owner = overwriteTargets.get(output.param);
        if (owner !== undefined) {
          throw new Error(
            `physics parameter "${output.param}" has overwrite outputs in chains "${owner}" and "${chain.id}"`,
          );
        }
        overwriteTargets.set(output.param, chain.id);
      }
    }
    this.stepWorkUnits = stepWorkUnits;
    this.chains = this.def.chains.map((chain) => {
      const n = chain.links.length;
      return {
        chain,
        px: new Float64Array(n + 1),
        py: new Float64Array(n + 1),
        qx: new Float64Array(n + 1),
        qy: new Float64Array(n + 1),
        rx: new Float64Array(n + 1),
        ry: new Float64Array(n + 1),
        rollbackPx: new Float64Array(n + 1),
        rollbackPy: new Float64Array(n + 1),
        rollbackQx: new Float64Array(n + 1),
        rollbackQy: new Float64Array(n + 1),
        rollbackPhi: 0,
        phi: 0,
      };
    });
  }

  /**
   * Testing/admission hook (§12): displace every link position (not the
   * anchor) by `epsilon` in x. Used by the conformance suite's
   * perturbation-stability criterion; not part of the host API.
   */
  perturbLinks(epsilon: number): void {
    if (!Number.isFinite(epsilon)) {
      throw new RangeError(`physics perturbation must be finite`);
    }
    this.withRollback(() => {
      for (const state of this.chains) {
        for (let i = 1; i < state.px.length; i++) {
          const px = state.px[i]! + epsilon;
          const qx = state.qx[i]! + epsilon;
          if (!Number.isFinite(px) || !Number.isFinite(qx)) {
            throw new RangeError(`physics perturbation overflow`);
          }
          state.px[i] = px;
          state.qx[i] = qx;
        }
      }
    });
  }

  /**
   * §9 initialization/reset: p = q = rest chain evaluated at the current
   * parameter values; velocities are therefore zero.
   */
  reset(values: ReadonlyMap<string, number>): void {
    this.withRollback(() => {
      for (const state of this.chains) {
        const { ax, ay, phi } = this.anchor(state.chain, values);
        state.phi = phi;
        const [dx, dy] = restDirection(phi);
        let x = ax;
        let y = ay;
        state.px[0] = x;
        state.py[0] = y;
        state.qx[0] = x;
        state.qy[0] = y;
        for (let i = 0; i < state.chain.links.length; i++) {
          const len = state.chain.links[i]!.length;
          x += len * dx;
          y += len * dy;
          state.px[i + 1] = x;
          state.py[i + 1] = y;
          state.qx[i + 1] = x;
          state.qy[i + 1] = y;
        }
      }
      this.accumulator = 0;
      this.accumulatorError = 0;
      this.completedSteps = 0;
      this.inputClockOffset = 0;
    });
  }

  /**
   * Fixed-timestep accumulator (§9). `sampleInputs` is called once per
   * simulation step to read the composed §6.1 stage-1..4 parameter values.
   * When supplied, `advanceInputs` advances host clocks chronologically to
   * each step boundary before that sample is taken.
   */
  advance(
    dt: number,
    sampleInputs: () => ReadonlyMap<string, number>,
    advanceInputs?: (slice: number) => void,
    afterStep?: () => void,
  ): void {
    const plan = this.planAdvance(dt);
    if (dt === 0) return;

    this.withRollback(() => {
      if (advanceInputs === undefined) {
        for (let i = 0; i < plan.stepCount; i++) {
          this.simulateStep(sampleInputs());
          afterStep?.();
        }
        // No external clock was advanced, so a future callback starts a fresh
        // relative schedule from the then-current elapsed accumulator.
        this.inputClockOffset = 0;
      } else {
        const schedule = this.inputSchedule(dt, plan.stepCount);
        for (let i = 0; i < plan.stepCount; i++) {
          const slice = schedule.slices[i]!;
          if (slice > 0) advanceInputs(slice);
          this.simulateStep(sampleInputs());
          afterStep?.();
        }
        if (schedule.trailing > 0) advanceInputs(schedule.trailing);
        this.inputClockOffset = schedule.finalOffset;
      }
      this.accumulator = plan.finalAccumulator;
      this.accumulatorError = plan.finalAccumulatorError;
      this.completedSteps = plan.finalCompletedSteps;
    });
  }

  /**
   * Validate an update and calculate its fixed-step work without changing
   * simulation state. Runtimes use this to reject catch-up overflow before
   * advancing motion or expression clocks.
   */
  preflightAdvance(dt: number, externalWorkPerStep = 0): number {
    return this.planAdvance(dt, externalWorkPerStep).stepCount;
  }

  /**
   * Return the chronological input-clock slices that precede fixed-step
   * samples for this update. This mirrors advance() exactly, including a
   * tolerance-admitted boundary whose slice can be zero.
   */
  plannedInputSlices(dt: number): readonly number[] {
    const plan = this.planAdvance(dt);
    return this.inputSchedule(dt, plan.stepCount).slices;
  }

  /**
   * Preflight solver work plus an exact, already-totalled amount of external
   * stage-1–4 sampling work. Unlike preflightAdvance's compatibility API, the
   * external amount may vary from one fixed-step boundary to the next.
   */
  preflightAdvanceTotalWork(dt: number, totalExternalWork: number): number {
    const plan = this.planAdvance(dt);
    if (!Number.isSafeInteger(totalExternalWork) || totalExternalWork < 0) {
      throw new RangeError(
        `physics update exceeds ${RUNTIME_LIMITS.physicsWorkUnitsPerUpdate} work units`,
      );
    }
    const solverWork = plan.stepCount * this.stepWorkUnits;
    if (totalExternalWork > RUNTIME_LIMITS.physicsWorkUnitsPerUpdate - solverWork) {
      throw new RangeError(
        `physics update exceeds ${RUNTIME_LIMITS.physicsWorkUnitsPerUpdate} work units`,
      );
    }
    return plan.stepCount;
  }

  /**
   * Execute exactly one fixed solver step without changing the accumulator.
   * Kept public for low-level/testing consumers, but unlike the raw pass it is
   * work-bounded and transactional across all chains.
   */
  step(values: ReadonlyMap<string, number>): void {
    if (this.stepWorkUnits > RUNTIME_LIMITS.physicsWorkUnitsPerUpdate) {
      throw new RangeError(
        `physics step exceeds ${RUNTIME_LIMITS.physicsWorkUnitsPerUpdate} work units`,
      );
    }
    this.withRollback(() => this.simulateStep(values));
  }

  private withRollback(action: () => void): void {
    if (this.transactionActive) {
      throw new Error(`physics mutation cannot be re-entered`);
    }
    this.transactionActive = true;
    const priorAccumulator = this.accumulator;
    const priorAccumulatorError = this.accumulatorError;
    const priorCompletedSteps = this.completedSteps;
    const priorInputClockOffset = this.inputClockOffset;
    const priorZeroVectorCount = this.zeroVectorFallbacks;
    try {
      for (const state of this.chains) {
        state.rollbackPx.set(state.px);
        state.rollbackPy.set(state.py);
        state.rollbackQx.set(state.qx);
        state.rollbackQy.set(state.qy);
        state.rollbackPhi = state.phi;
      }
      try {
        action();
      } catch (error) {
        this.accumulator = priorAccumulator;
        this.accumulatorError = priorAccumulatorError;
        this.completedSteps = priorCompletedSteps;
        this.inputClockOffset = priorInputClockOffset;
        this.zeroVectorFallbacks = priorZeroVectorCount;
        for (const state of this.chains) {
          state.px.set(state.rollbackPx);
          state.py.set(state.rollbackPy);
          state.qx.set(state.rollbackQx);
          state.qy.set(state.rollbackQy);
          state.phi = state.rollbackPhi;
        }
        throw error;
      }
    } finally {
      this.transactionActive = false;
    }
  }

  private planAdvance(
    dt: number,
    externalWorkPerStep = 0,
  ): {
    stepCount: number;
    finalAccumulator: number;
    finalAccumulatorError: number;
    finalCompletedSteps: number;
  } {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new RangeError(`physics dt must be a finite non-negative number`);
    }
    if (dt === 0) {
      return {
        stepCount: 0,
        finalAccumulator: this.accumulator,
        finalAccumulatorError: this.accumulatorError,
        finalCompletedSteps: this.completedSteps,
      };
    }
    const next = addCompensated(this.accumulator, this.accumulatorError, dt);
    const accumulated = compensatedValue(next.value, next.error);
    if (!Number.isFinite(accumulated)) {
      throw new RangeError(`physics accumulator overflow`);
    }
    // Snap only a narrowly ULP-scaled error around an integer boundary so
    // update(N/fps) is exactly N steps without rounding genuinely incomplete
    // intervals up. Calculate the count up front: repeated subtraction can
    // stop making progress when dt is much larger than the fixed step.
    const finalCompletedSteps = fixedStepCount(accumulated, this.stepDt);
    const stepCount = finalCompletedSteps - this.completedSteps;
    if (stepCount < 0) {
      throw new RangeError(`physics elapsed clock lost a completed fixed step`);
    }
    if (stepCount > RUNTIME_LIMITS.physicsStepsPerUpdate) {
      throw new RangeError(
        `physics update requires ${stepCount} fixed steps (limit ${RUNTIME_LIMITS.physicsStepsPerUpdate})`,
      );
    }
    const workPerStep = this.stepWorkUnits + externalWorkPerStep;
    if (
      !Number.isSafeInteger(externalWorkPerStep) ||
      externalWorkPerStep < 0 ||
      stepCount > Math.floor(RUNTIME_LIMITS.physicsWorkUnitsPerUpdate / workPerStep)
    ) {
      throw new RangeError(
        `physics update exceeds ${RUNTIME_LIMITS.physicsWorkUnitsPerUpdate} work units`,
      );
    }
    return {
      stepCount,
      finalAccumulator: next.value,
      finalAccumulatorError: next.error,
      finalCompletedSteps,
    };
  }

  /**
   * Derive boundary slices from fixed-step indices, not repeated subtraction
   * from `dt`. This gives bulk and one-step updates identical clock values at
   * every boundary. A tolerance-admitted early boundary is snapped to the
   * canonical fixed-step instant, just as N individual `update(1/fps)` calls.
   */
  private inputSchedule(
    dt: number,
    stepCount: number,
  ): { slices: number[]; trailing: number; finalOffset: number } {
    const slices = new Array<number>(stepCount);
    const startingElapsed = compensatedValue(this.accumulator, this.accumulatorError);
    const finalElapsedPair = addCompensated(this.accumulator, this.accumulatorError, dt);
    const finalElapsed = compensatedValue(finalElapsedPair.value, finalElapsedPair.error);
    const logicalStart = startingElapsed + this.inputClockOffset;
    let previousBoundary = 0;
    for (let i = 0; i < stepCount; i++) {
      const stepOrdinal = this.completedSteps + i + 1;
      const boundary = Math.max(previousBoundary, stepOrdinal * this.stepDt - logicalStart);
      slices[i] = boundary - previousBoundary;
      previousBoundary = boundary;
    }
    const logicalBoundary = logicalStart + previousBoundary;
    const trailing = Math.max(0, finalElapsed - logicalBoundary);
    const logicalEnd = Math.max(logicalBoundary, finalElapsed);
    return { slices, trailing, finalOffset: Math.max(0, logicalEnd - finalElapsed) };
  }

  /** Raw simulation pass at dt = 1/fps (§9); caller owns budgeting/rollback. */
  private simulateStep(values: ReadonlyMap<string, number>): void {
    const dt = this.stepDt;
    const dt2 = dt * dt;
    for (const state of this.chains) {
      const chain = state.chain;
      const links = chain.links;
      const n = links.length;

      // Anchor and rest chain from inputs and φ alone — never link positions.
      const { ax, ay, phi } = this.anchor(chain, values);
      state.phi = phi;
      const [dx, dy] = restDirection(phi);
      state.px[0] = ax;
      state.py[0] = ay;
      const { rx, ry } = state;
      rx[0] = ax;
      ry[0] = ay;
      for (let i = 1; i <= n; i++) {
        rx[i] = rx[i - 1]! + links[i - 1]!.length * dx;
        ry[i] = ry[i - 1]! + links[i - 1]!.length * dy;
      }

      const gx = chain.gravity[0] + chain.wind[0];
      const gy = chain.gravity[1] + chain.wind[1];

      // 1. Verlet with per-link damping.
      for (let i = 1; i <= n; i++) {
        const damp = 1 - links[i - 1]!.damping;
        const vx = (state.px[i]! - state.qx[i]!) * damp;
        const vy = (state.py[i]! - state.qy[i]!) * damp;
        state.qx[i] = state.px[i]!;
        state.qy[i] = state.py[i]!;
        state.px[i] = state.px[i]! + vx + gx * dt2;
        state.py[i] = state.py[i]! + vy + gy * dt2;
      }

      // 2. Stiffness toward the rest chain.
      for (let i = 1; i <= n; i++) {
        const s = links[i - 1]!.stiffness;
        state.px[i] = state.px[i]! + (rx[i]! - state.px[i]!) * s;
        state.py[i] = state.py[i]! + (ry[i]! - state.py[i]!) * s;
      }

      // 3. Constraint, root→tip, one iteration.
      for (let i = 1; i <= n; i++) {
        let ux = state.px[i]! - state.px[i - 1]!;
        let uy = state.py[i]! - state.py[i - 1]!;
        if (ux === 0 && uy === 0) {
          // Exact zero vector: direction is d̂(φ) (§9).
          ux = dx;
          uy = dy;
          this.zeroVectorFallbacks++;
        } else {
          // Normalize without ever constructing the potentially overflowing
          // length hypot(ux, uy). Scaling first keeps both components and the
          // norm in [−1,1] even when each displacement is near MAX_VALUE.
          const magnitude = Math.max(Math.abs(ux), Math.abs(uy));
          ux /= magnitude;
          uy /= magnitude;
          const scaledLength = Math.hypot(ux, uy);
          ux /= scaledLength;
          uy /= scaledLength;
        }
        state.px[i] = state.px[i - 1]! + links[i - 1]!.length * ux;
        state.py[i] = state.py[i - 1]! + links[i - 1]!.length * uy;
      }
    }
  }

  /**
   * Current link output angles (degrees) per chain: the signed angle between
   * (pᵢ − pᵢ₋₁) and d̂(φ), positive clockwise (§4, §9).
   */
  linkAngles(chainId: string): number[] {
    const state = this.chains.find((c) => c.chain.id === chainId);
    if (!state) throw new Error(`unknown physics chain "${chainId}"`);
    return this.anglesOf(state);
  }

  /**
   * §6.1 stage 5: compose outputs by target, independent of document order.
   * At most one overwrite supplies a default-based value; all add outputs are
   * then accumulated in the canonical §9 order.
   */
  applyOutputs(values: Map<string, number>): void {
    const composed = new Map<string, ComposedOutput>();
    for (const state of this.chains) {
      const angles = this.anglesOf(state);
      for (const out of state.chain.outputs) {
        const angle = angles[out.link]!;
        const def = this.paramsById.get(out.param)!;
        let target = composed.get(out.param);
        if (target === undefined) {
          target = { overwrite: undefined, additions: [] };
          composed.set(out.param, target);
        }
        if (out.blend === "overwrite") {
          target.overwrite = def.default + angle * out.multiplier;
        } else {
          target.additions.push({
            chainId: state.chain.id,
            link: out.link,
            multiplier: out.multiplier,
            value: angle * out.multiplier,
          });
        }
      }
    }
    for (const [param, output] of composed) {
      output.additions.sort(compareAddContributions);
      let value = output.overwrite ?? values.get(param)!;
      for (const addition of output.additions) value += addition.value;
      values.set(param, value);
    }
  }

  private anglesOf(state: ChainState): number[] {
    const [dx, dy] = restDirection(state.phi);
    const out: number[] = [];
    for (let i = 1; i < state.px.length; i++) {
      const vx = state.px[i]! - state.px[i - 1]!;
      const vy = state.py[i]! - state.py[i - 1]!;
      // Signed angle from d̂ to v, positive clockwise in the +y-down frame.
      const cross = dx * vy - dy * vx;
      const dot = dx * vx + dy * vy;
      // `+ 0` collapses IEEE −0 to +0 (atan2(−0, +dot) yields −0).
      out.push((Math.atan2(cross, dot) * 180) / Math.PI + 0);
    }
    return out;
  }

  private anchor(
    chain: PhysicsChain,
    values: ReadonlyMap<string, number>,
  ): { ax: number; ay: number; phi: number } {
    let ax = 0;
    let ay = 0;
    let phi = 0;
    for (const input of chain.inputs) {
      const def = this.paramsById.get(input.param)!;
      const value = values.get(input.param)!;
      if (!Number.isFinite(value)) {
        throw new RangeError(`physics input parameter "${input.param}" must be finite`);
      }
      const norm = normalizedInput(def, value);
      if (!Number.isFinite(norm)) {
        throw new RangeError(`physics input parameter "${input.param}" cannot be normalized`);
      }
      if (input.type === "x") ax += input.weight * norm;
      else if (input.type === "y") ay += input.weight * norm;
      else phi += input.weight * norm * 30;
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(phi)) {
        throw new RangeError(`physics chain "${chain.id}" anchor input overflow`);
      }
    }
    return { ax, ay, phi };
  }
}

function compareAddContributions(a: AddContribution, b: AddContribution): number {
  if (a.chainId < b.chainId) return -1;
  if (a.chainId > b.chainId) return 1;
  return a.link - b.link || a.multiplier - b.multiplier;
}

/** d̂(φ): (0,1) rotated by φ degrees, positive clockwise under +y down (§9). */
export function restDirection(phiDeg: number): [number, number] {
  const rad = (phiDeg * Math.PI) / 180;
  return [-Math.sin(rad), Math.cos(rad)];
}
