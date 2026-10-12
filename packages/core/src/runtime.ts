import type {
  AnyNode,
  BindableProperty,
  ExpressionDef,
  Model,
  MotionDef,
  SpriteNode,
} from "./types/model.js";
import type { DeformedGeometry, DrawItem, EvalFrame, MaskGroup } from "./types/frame.js";
import { clampOrWrap } from "./params.js";
import { evalBinding } from "./bindings.js";
import { buildMesh, type MeshData } from "./mesh.js";
import { applyRotator, applyWarp, warpRestPoints, type WarpState } from "./deform.js";
import { computeExcludedNodes } from "./variants.js";
import { hitTestGeometryWithBudget } from "./hittest.js";
import { applyExpressionEntry } from "./expressions.js";
import { motionLocalTime, sampleTrack } from "./motions.js";
import { PhysicsEngine } from "./physics.js";
import { deterministicProduct, deterministicSum } from "./accumulate.js";
import { addCompensated, compensatedValue } from "./clock.js";

export interface SlotInfo {
  id: string;
  options: string[];
  active: string;
}

interface Accumulator {
  /** Sum of additive deltas (length = binding arity) per property. */
  additive: Map<BindableProperty, Float64Array>;
  /** Product of scalar factors per property. */
  factor: Map<BindableProperty, number>;
}

interface BindingContributions {
  /** One evaluated entry-shaped delta per additive binding. */
  additive: Map<BindableProperty, Float64Array[]>;
  /** One evaluated scalar per factor binding. */
  factor: Map<BindableProperty, number[]>;
}

interface ActiveMotion {
  def: MotionDef;
  weight: number;
  time: number;
  timeError: number;
}

interface ExpressionState {
  def: ExpressionDef;
  weight: number;
  /** Fade target; setExpressionWeight() pins weight === target (held). */
  target: number;
  /** Completed setExpression(false) fades are removed from activation order. */
  removeAtZero: boolean;
  /** Weight at the most recent fade-direction change. */
  fadeStartWeight: number;
  /** Compensated elapsed time since that direction change. */
  fadeElapsed: number;
  fadeElapsedError: number;
}

/**
 * §8.1 step 6: nearest-integer effective z, with exact halves toward +∞.
 * Writing the rule explicitly avoids the language-dependent behavior of a
 * generic `round` function (notably for negative half-integers).
 */
export function roundEffectiveZ(z: number): number {
  return Math.floor(z + 0.5);
}

/**
 * Final §8.1 effective-z grouping. Keeping this tiny operation shared matters:
 * cancellation in the separately accumulated ancestor sum can otherwise make
 * an independent rest-pose check cross a half-integer at a different point.
 */
export function resolveEffectiveZ(restZ: number, ownDelta: number, ancestorGroupZ: number): number {
  return restZ + ownDelta + ancestorGroupZ;
}

/** Final §8.1 effective-opacity grouping after root-to-parent accumulation. */
export function resolveEffectiveOpacity(nodeOpacity: number, ancestorOpacity: number): number {
  return nodeOpacity * ancestorOpacity;
}

/**
 * A loaded model plus mutable host state (§11): parameters, expressions,
 * motions, variants, physics. `update(dt)` advances time; `evaluate()` runs
 * the §8.1 pipeline (steps 1–6) and returns the frame for a renderer (step 7).
 */
export class LyreRuntime {
  readonly model: Model;

  private hostInput = new Map<string, number>();
  private activeOptions = new Map<string, string>();
  /** Composed values of the last evaluate() (post stage 6). */
  private composed = new Map<string, number>();
  private meshes = new Map<SpriteNode, MeshData>();
  private lastFrame: EvalFrame | null = null;

  /** Active motions in start order (§10.2). */
  private activeMotions: ActiveMotion[] = [];
  /** Expression states in activation order (insertion order of the map). */
  private expressionStates = new Map<string, ExpressionState>();
  private rollbackMotionTimes = new Float64Array(0);
  private rollbackMotionTimeErrors = new Float64Array(0);
  private rollbackExpressionWeights = new Float64Array(0);
  private rollbackExpressionElapsed = new Float64Array(0);
  private rollbackExpressionElapsedErrors = new Float64Array(0);
  private rollbackExpressions: ExpressionState[] = [];
  private physicsEngine: PhysicsEngine | null = null;
  /** Prevent callbacks at fixed-step boundaries from mutating an in-flight transaction. */
  private updateActive = false;
  /** When false, physics is not stepped nor applied (host toggle; on by default). */
  private physicsIsEnabled = true;

  constructor(model: Model) {
    this.model = model;
    for (const slot of model.variantSlots) this.activeOptions.set(slot.id, slot.default);
    for (const sprite of model.sprites) this.meshes.set(sprite, buildMesh(sprite));
    for (const p of model.params) this.composed.set(p.id, clampOrWrap(p, p.default));
    if (model.physics) {
      // §9 initialization reads the then-current parameter values: compose
      // stages 1–4 as of load (defaults; no motions/host/expressions yet).
      this.physicsEngine = new PhysicsEngine(model.physics, model.paramsById);
      this.physicsEngine.reset(this.composeUpToStage4());
    }
  }

  // ----- host API (§11)

  get physicsEnabled(): boolean {
    return this.physicsIsEnabled;
  }

  set physicsEnabled(enabled: boolean) {
    this.requireMutationOutsideUpdate("change physicsEnabled");
    this.physicsIsEnabled = enabled;
  }

  setParam(id: string, v: number): void {
    this.requireMutationOutsideUpdate("set a parameter");
    this.requireParam(id);
    requireFinite(v, `parameter "${id}" value`);
    this.hostInput.set(id, v);
  }

  /** Release a host override; the parameter returns to defaults/motions. */
  clearParam(id: string): void {
    this.requireMutationOutsideUpdate("clear a parameter");
    this.requireParam(id);
    this.hostInput.delete(id);
  }

  /** Composed value (post-clamp, §6.1 stage 6) as of the last evaluate(). */
  getParamValue(id: string): number {
    this.requireParam(id);
    return this.composed.get(id)!;
  }

  listSlots(): SlotInfo[] {
    return this.model.variantSlots.map((s) => ({
      id: s.id,
      options: s.options.map((o) => o.id),
      active: this.activeOptions.get(s.id)!,
    }));
  }

  setVariant(slot: string, option: string): void {
    this.requireMutationOutsideUpdate("set a variant");
    const s = this.model.variantSlots.find((x) => x.id === slot);
    if (!s) throw new Error(`unknown variant slot "${slot}"`);
    if (!s.options.some((o) => o.id === option)) {
      throw new Error(`unknown option "${option}" in slot "${slot}"`);
    }
    // Takes effect at the start of the next pipeline run (§10.3 rule 4).
    this.activeOptions.set(slot, option);
  }

  playMotion(id: string, weight = 1): void {
    this.requireMutationOutsideUpdate("play a motion");
    const def = this.model.motions.find((m) => m.id === id);
    if (!def) throw new Error(`unknown motion "${id}"`);
    const heldWeight = clamp01(weight);
    // Replaying restarts the motion and moves it to the end of the start order.
    this.activeMotions = this.activeMotions.filter((m) => m.def.id !== id);
    this.activeMotions.push({ def, weight: heldWeight, time: 0, timeError: 0 });
  }

  setMotionWeight(id: string, w: number): void {
    this.requireMutationOutsideUpdate("set a motion weight");
    const m = this.activeMotions.find((x) => x.def.id === id);
    if (!m) throw new Error(`motion "${id}" is not active`);
    m.weight = clamp01(w);
  }

  stopMotion(id: string): void {
    this.requireMutationOutsideUpdate("stop a motion");
    this.activeMotions = this.activeMotions.filter((m) => m.def.id !== id);
  }

  /** Activate (fade in over fade_in) or deactivate (fade out) an expression. */
  setExpression(id: string, active: boolean): void {
    this.requireMutationOutsideUpdate("set an expression");
    const def = this.expressionDef(id);
    const state = this.expressionStates.get(id);
    if (active) {
      if (state) {
        if (state.target !== 1) this.beginExpressionFade(state, 1);
        state.target = 1;
        state.removeAtZero = false;
      } else {
        this.expressionStates.set(id, {
          def,
          weight: 0,
          target: 1,
          removeAtZero: false,
          fadeStartWeight: 0,
          fadeElapsed: 0,
          fadeElapsedError: 0,
        });
      }
      const s = this.expressionStates.get(id)!;
      if (def.fadeIn === 0) this.finishExpressionFade(s);
    } else if (state) {
      if (state.target !== 0) this.beginExpressionFade(state, 0);
      state.target = 0;
      state.removeAtZero = true;
      // A completed deactivation is no longer part of activation order.
      // Reactivating it later must append it after expressions still active.
      if (state.weight === 0 || def.fadeOut === 0) {
        this.expressionStates.delete(id);
      }
    }
  }

  /**
   * Hold an expression at a constant weight directly (§10.1, §11). Unlike
   * setExpression(id, false), a held weight of zero retains activation order.
   */
  setExpressionWeight(id: string, w: number): void {
    this.requireMutationOutsideUpdate("set an expression weight");
    const def = this.expressionDef(id);
    const weight = clamp01(w);
    const state = this.expressionStates.get(id);
    if (state) {
      state.weight = weight;
      state.target = weight;
      state.removeAtZero = false;
      state.fadeStartWeight = weight;
      state.fadeElapsed = 0;
      state.fadeElapsedError = 0;
    } else {
      this.expressionStates.set(id, {
        def,
        weight,
        target: weight,
        removeAtZero: false,
        fadeStartWeight: weight,
        fadeElapsed: 0,
        fadeElapsedError: 0,
      });
    }
  }

  getExpressionWeight(id: string): number {
    this.expressionDef(id);
    return this.expressionStates.get(id)?.weight ?? 0;
  }

  /**
   * Advance clocks and physics. The optional observer is conformance
   * instrumentation invoked after every completed internal solver step.
   */
  update(dt: number, afterPhysicsStep?: () => void): void {
    this.requireMutationOutsideUpdate("update");
    requireFinite(dt, "update dt");
    if (dt < 0) throw new RangeError(`update dt must be non-negative`);
    if (dt === 0) return;

    this.updateActive = true;
    try {
      // Preflight every known rejection before mutating any clock.
      if (this.physicsEngine && this.physicsEnabled) {
        const boundarySlices = this.physicsEngine.plannedInputSlices(dt);
        let workPerSample = this.model.params.length + this.hostInput.size;
        for (const motion of this.activeMotions) {
          for (const track of motion.def.tracks) {
            // One source visit plus the normative binary-search bound (§16).
            workPerSample += 1 + Math.ceil(Math.log2(track.keys.length + 1));
          }
        }
        let sampleWork = workPerSample * boundarySlices.length;
        for (const expression of this.expressionStates.values()) {
          let weight = expression.weight;
          let elapsed = expression.fadeElapsed;
          let elapsedError = expression.fadeElapsedError;
          for (const slice of boundarySlices) {
            if (slice > 0) {
              const next = expressionProgressAfter(
                weight,
                expression.target,
                expression.fadeStartWeight,
                elapsed,
                elapsedError,
                expression.def.fadeIn,
                expression.def.fadeOut,
                slice,
              );
              weight = next.weight;
              elapsed = next.elapsed;
              elapsedError = next.elapsedError;
            }
            // Stage 4 skips a zero-weight expression exactly, so none of its
            // parameter sources are visited at that boundary.
            if (weight !== 0) sampleWork += expression.def.params.length;
          }
        }
        this.physicsEngine.preflightAdvanceTotalWork(dt, sampleWork);
        // Advance motion/expression clocks to each fixed-step boundary before
        // sampling physics inputs. One update spanning N steps is therefore
        // equivalent to N chronological one-step updates.
        if (this.rollbackMotionTimes.length < this.activeMotions.length) {
          this.rollbackMotionTimes = new Float64Array(this.activeMotions.length);
          this.rollbackMotionTimeErrors = new Float64Array(this.activeMotions.length);
        }
        for (let i = 0; i < this.activeMotions.length; i++) {
          this.rollbackMotionTimes[i] = this.activeMotions[i]!.time;
          this.rollbackMotionTimeErrors[i] = this.activeMotions[i]!.timeError;
        }
        this.rollbackExpressions.length = 0;
        for (const expression of this.expressionStates.values()) {
          this.rollbackExpressions.push(expression);
        }
        if (this.rollbackExpressionWeights.length < this.rollbackExpressions.length) {
          this.rollbackExpressionWeights = new Float64Array(this.rollbackExpressions.length);
          this.rollbackExpressionElapsed = new Float64Array(this.rollbackExpressions.length);
          this.rollbackExpressionElapsedErrors = new Float64Array(this.rollbackExpressions.length);
        }
        for (let i = 0; i < this.rollbackExpressions.length; i++) {
          const expression = this.rollbackExpressions[i]!;
          this.rollbackExpressionWeights[i] = expression.weight;
          this.rollbackExpressionElapsed[i] = expression.fadeElapsed;
          this.rollbackExpressionElapsedErrors[i] = expression.fadeElapsedError;
        }
        try {
          this.physicsEngine.advance(
            dt,
            () => this.composeUpToStage4(),
            (slice) => this.advanceInputClocks(slice, true),
            afterPhysicsStep,
          );
        } catch (error) {
          for (let i = 0; i < this.activeMotions.length; i++) {
            this.activeMotions[i]!.time = this.rollbackMotionTimes[i]!;
            this.activeMotions[i]!.timeError = this.rollbackMotionTimeErrors[i]!;
          }
          for (let i = 0; i < this.rollbackExpressions.length; i++) {
            const expression = this.rollbackExpressions[i]!;
            expression.weight = this.rollbackExpressionWeights[i]!;
            expression.fadeElapsed = this.rollbackExpressionElapsed[i]!;
            expression.fadeElapsedError = this.rollbackExpressionElapsedErrors[i]!;
          }
          throw error;
        }
        this.removeCompletedExpressions();
      } else {
        this.advanceInputClocks(dt);
      }
    } finally {
      this.updateActive = false;
    }
  }

  private advanceInputClocks(dt: number, deferExpressionRemoval = false): void {
    for (const m of this.activeMotions) {
      // Looping clocks need only their phase; non-looping motions hold their
      // last keyed value and therefore never need to grow past duration.
      if (m.def.loop) {
        const delta = dt % m.def.duration;
        const time = compensatedValue(m.time, m.timeError);
        // Both operands are below duration, but their sum can still overflow
        // when a model uses a duration near Number.MAX_VALUE. Subtract across
        // the seam instead of constructing that overflowing sum.
        const distanceToSeam = m.def.duration - delta;
        const next =
          time >= distanceToSeam
            ? addCompensated(m.time, m.timeError, -distanceToSeam)
            : addCompensated(m.time, m.timeError, delta);
        m.time = next.value;
        m.timeError = next.error;
      } else {
        const remaining = m.def.duration - compensatedValue(m.time, m.timeError);
        if (dt >= remaining) {
          m.time = m.def.duration;
          m.timeError = 0;
        } else {
          const next = addCompensated(m.time, m.timeError, dt);
          m.time = next.value;
          m.timeError = next.error;
        }
      }
    }
    for (const [id, s] of this.expressionStates) {
      if (s.weight === s.target) {
        if (s.weight === 0 && s.removeAtZero && !deferExpressionRemoval) {
          this.expressionStates.delete(id);
        }
        continue;
      }
      const next = expressionProgressAfter(
        s.weight,
        s.target,
        s.fadeStartWeight,
        s.fadeElapsed,
        s.fadeElapsedError,
        s.def.fadeIn,
        s.def.fadeOut,
        dt,
      );
      s.weight = next.weight;
      s.fadeElapsed = next.elapsed;
      s.fadeElapsedError = next.elapsedError;
      if (s.weight === 0 && s.target === 0 && s.removeAtZero && !deferExpressionRemoval) {
        this.expressionStates.delete(id);
      }
    }
  }

  private removeCompletedExpressions(): void {
    for (const [id, state] of this.expressionStates) {
      if (state.weight === 0 && state.target === 0 && state.removeAtZero) {
        this.expressionStates.delete(id);
      }
    }
  }

  private beginExpressionFade(state: ExpressionState, target: number): void {
    state.target = target;
    state.fadeStartWeight = state.weight;
    state.fadeElapsed = 0;
    state.fadeElapsedError = 0;
  }

  private finishExpressionFade(state: ExpressionState): void {
    state.weight = state.target;
    state.fadeStartWeight = state.target;
    state.fadeElapsed = 0;
    state.fadeElapsedError = 0;
  }

  /** §9: re-initialize chains at the current parameter values (p = q = rest). */
  resetPhysics(): void {
    this.requireMutationOutsideUpdate("reset physics");
    this.physicsEngine?.reset(this.composeUpToStage4());
  }

  /** The model's physics engine (null without the capability). */
  get physics(): PhysicsEngine | null {
    return this.physicsEngine;
  }

  // ----- §8.1 pipeline, steps 1–6

  evaluate(): EvalFrame {
    this.requireMutationOutsideUpdate("evaluate");
    // Step 1: compose parameter values (§6.1).
    const values = this.composeParams();

    // Variant exclusion set for this frame (§10.3).
    const excluded = computeExcludedNodes(this.model, this.activeOptions);

    // Step 2: evaluate bindings, accumulating per (node, property).
    const contributions = new Map<AnyNode, BindingContributions>();
    const excludedDeep = this.expandExcluded(excluded);
    for (const b of this.model.bindings) {
      if (excludedDeep.has(b.target)) continue; // §7 rule 7
      const pv = b.params.map((p) => values.get(p.id)!);
      const delta = evalBinding(b, pv);
      let a = contributions.get(b.target);
      if (!a) contributions.set(b.target, (a = { additive: new Map(), factor: new Map() }));
      if (b.kind === "additive") {
        const pending = a.additive.get(b.property);
        if (pending) pending.push(delta);
        else a.additive.set(b.property, [delta]);
      } else {
        const pending = a.factor.get(b.property);
        if (pending) pending.push(delta[0]!);
        else a.factor.set(b.property, [delta[0]!]);
      }
    }

    // §7 rule 5: combination order is semantically irrelevant. Resolve the
    // bounded contribution lists canonically so JSON-array permutations cannot
    // change cancellation, overflow, or underflow behavior.
    const acc = new Map<AnyNode, Accumulator>();
    for (const [node, pending] of contributions) {
      const resolved: Accumulator = { additive: new Map(), factor: new Map() };
      for (const [property, entries] of pending.additive) {
        const combined = new Float64Array(entries[0]!.length);
        const scalars = new Array<number>(entries.length);
        for (let i = 0; i < combined.length; i++) {
          for (let j = 0; j < entries.length; j++) scalars[j] = entries[j]![i]!;
          const value = deterministicSum(scalars);
          requireFinite(value, `binding sum for "${node.id}.${property}"`);
          combined[i] = value;
        }
        resolved.additive.set(property, combined);
      }
      for (const [property, factors] of pending.factor) {
        const value = deterministicProduct(factors);
        requireFinite(value, `binding factor for "${node.id}.${property}"`);
        resolved.factor.set(property, value);
      }
      acc.set(node, resolved);
    }

    // Steps 3–5: resolve state and transform geometry down the tree.
    const drawItems: Array<{
      geometry: DeformedGeometry;
      opacity: number;
      zReal: number;
      sprite: SpriteNode;
    }> = [];
    const geometryBySprite = new Map<SpriteNode, DeformedGeometry>();

    type Deformer =
      | {
          kind: "rotator";
          cx: number;
          cy: number;
          tx: number;
          ty: number;
          angle: number;
          scale: number;
        }
      | { kind: "warp"; state: WarpState };

    const walk = (
      node: AnyNode,
      deformers: Deformer[],
      opacityProduct: number,
      groupZ: number,
    ): void => {
      if (excluded.has(node)) return; // whole subtree ceases to exist (§10.3)
      const a = acc.get(node);

      if (node.type === "group") {
        const opacity = this.resolveOpacity(node.opacity, a);
        const zDelta = a?.additive.get("z")?.[0] ?? 0;
        for (const child of node.children) {
          walk(child, deformers, opacityProduct * opacity, groupZ + zDelta);
        }
        return;
      }

      if (node.type === "rotator") {
        const off = a?.additive.get("pivot_offset");
        const angle = node.angle + (a?.additive.get("angle")?.[0] ?? 0);
        const scale = node.scale * (a?.factor.get("scale") ?? 1);
        requireFinite(angle, `effective angle for rotator "${node.id}"`);
        requireFinite(scale, `effective scale for rotator "${node.id}"`);
        const d: Deformer = {
          kind: "rotator",
          cx: node.pivot[0],
          cy: node.pivot[1],
          tx: off?.[0] ?? 0,
          ty: off?.[1] ?? 0,
          angle,
          scale,
        };
        for (const child of node.children) {
          walk(child, [...deformers, d], opacityProduct, groupZ);
        }
        return;
      }

      if (node.type === "warp") {
        const points = warpRestPoints(node.rect, node.cols, node.rows);
        const deltas = a?.additive.get("grid");
        if (deltas) for (let i = 0; i < points.length; i++) points[i] = points[i]! + deltas[i]!;
        const d: Deformer = {
          kind: "warp",
          state: {
            rect: node.rect,
            cols: node.cols,
            rows: node.rows,
            points,
            ...(deltas ? { deltas } : {}),
          },
        };
        for (const child of node.children) {
          walk(child, [...deformers, d], opacityProduct, groupZ);
        }
        return;
      }

      // Sprite (§8.1 step 4): own verts, then offset, then ancestors
      // nearest-first (deformers[last] is the parent-side deformer).
      const mesh = this.meshes.get(node)!;
      const positions = new Float64Array(mesh.points);
      const verts = a?.additive.get("verts");
      if (verts)
        for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! + verts[i]!;
      const offset = a?.additive.get("offset");
      if (offset) {
        for (let i = 0; i < positions.length; i += 2) {
          positions[i] = positions[i]! + offset[0]!;
          positions[i + 1] = positions[i + 1]! + offset[1]!;
        }
      }
      for (let di = deformers.length - 1; di >= 0; di--) {
        const d = deformers[di]!;
        if (d.kind === "rotator") applyRotator(d, positions);
        else applyWarp(d.state, positions);
      }
      // Model space → canvas space (§4): shift by the canvas origin.
      const [ox, oy] = this.model.canvas.origin;
      for (let i = 0; i < positions.length; i += 2) {
        positions[i] = positions[i]! + ox;
        positions[i + 1] = positions[i + 1]! + oy;
      }
      for (const coordinate of positions) {
        requireFinite(coordinate, `deformed position for sprite "${node.id}"`);
      }

      const opacity = resolveEffectiveOpacity(this.resolveOpacity(node.opacity, a), opacityProduct);
      const zReal = resolveEffectiveZ(node.z, a?.additive.get("z")?.[0] ?? 0, groupZ);
      requireFinite(opacity, `effective opacity for sprite "${node.id}"`);
      requireFinite(zReal, `effective z for sprite "${node.id}"`);
      const geometry: DeformedGeometry = {
        sprite: node,
        texture: node.texture,
        positions,
        uvs: mesh.uvs,
        indices: mesh.indices,
      };
      geometryBySprite.set(node, geometry);
      drawItems.push({ geometry, opacity, zReal, sprite: node });
    };

    walk(this.model.root, [], 1, 0);

    // Step 6: one flat global sort; single rounding; document-order ties.
    const rounded = drawItems.map((d) => ({ ...d, z: roundEffectiveZ(d.zReal) }));
    rounded.sort((p, q) => p.z - q.z || p.sprite.spriteOrder - q.sprite.spriteOrder);

    // Mask groups (§8.4): one group per distinct active-source set.
    const groupIndex = new Map<string, number>();
    const maskGroups: MaskGroup[] = [];
    const drawList: DrawItem[] = rounded.map((d) => {
      let mask: DrawItem["mask"] = null;
      if (d.sprite.mask) {
        const activeSources = d.sprite.mask.sources
          .filter((s) => geometryBySprite.has(s))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const key = activeSources.map((s) => s.id).join(" ");
        let gi = groupIndex.get(key);
        if (gi === undefined) {
          gi = maskGroups.length;
          groupIndex.set(key, gi);
          maskGroups.push({ sources: activeSources.map((s) => geometryBySprite.get(s)!) });
        }
        mask = { mode: d.sprite.mask.mode, group: gi };
      }
      return {
        ...d.geometry,
        opacity: d.opacity,
        blend: d.sprite.blend,
        effectiveZ: d.z,
        mask,
      };
    });

    const frame: EvalFrame = {
      canvas: { width: this.model.canvas.width, height: this.model.canvas.height },
      drawList,
      maskGroups,
    };
    // Commit observable evaluation state only after every binding, deformer,
    // geometry, sort, and mask operation has completed successfully.
    this.composed = values;
    this.lastFrame = frame;
    return frame;
  }

  /** §11: point-in-deformed-triangle over the last frame; alpha ignored. */
  hitTest(x: number, y: number): string[] {
    requireFinite(x, "hit-test x");
    requireFinite(y, "hit-test y");
    const frame = this.lastFrame ?? this.evaluate();
    const hits: string[] = [];
    const exactWork = { count: 0 };
    for (let i = frame.drawList.length - 1; i >= 0; i--) {
      const item = frame.drawList[i]!;
      if (hitTestGeometryWithBudget(item.positions, item.indices, x, y, exactWork)) {
        hits.push(item.sprite.id);
      }
    }
    return hits;
  }

  // ----- internals

  /** §6.1 stages 1–4 (defaults → motions → host input → expressions). */
  private composeUpToStage4(): Map<string, number> {
    const values = new Map<string, number>();
    // Stage 1: defaults.
    for (const p of this.model.params) values.set(p.id, p.default);
    // Stage 2: active motions, layered in start order (§10.2).
    for (const m of this.activeMotions) {
      const lt = motionLocalTime(m.def, compensatedValue(m.time, m.timeError));
      for (const track of m.def.tracks) {
        const tv = sampleTrack(track, lt);
        const cur = values.get(track.param)!;
        const next = cur * (1 - m.weight) + tv * m.weight;
        requireFinite(next, `motion "${m.def.id}" output for "${track.param}"`);
        values.set(track.param, next);
      }
    }
    // Stage 3: host input — overwrites.
    for (const [id, v] of this.hostInput) values.set(id, v);
    // Stage 4: expressions, by blend mode at their current weight (§10.1).
    for (const s of this.expressionStates.values()) {
      if (s.weight === 0) continue; // exact no-op
      for (const entry of s.def.params) {
        const next = applyExpressionEntry(values.get(entry.id)!, entry, s.weight);
        requireFinite(next, `expression "${s.def.id}" output for "${entry.id}"`);
        values.set(entry.id, next);
      }
    }
    return values;
  }

  private composeParams(): Map<string, number> {
    const values = this.composeUpToStage4();
    // Stage 5: physics outputs (§9), applied by chain blend mode.
    if (this.physicsEngine && this.physicsEnabled) {
      this.physicsEngine.applyOutputs(values);
    }
    // Stage 6: clamp / wrap.
    for (const p of this.model.params) {
      const value = values.get(p.id)!;
      requireFinite(value, `composed parameter "${p.id}"`);
      values.set(p.id, clampOrWrap(p, value));
    }
    return values;
  }

  /** §7 rule 5: factors multiply unclamped; clamp to [0,1] once, at the end. */
  private resolveOpacity(rest: number, a: Accumulator | undefined): number {
    const v = rest * (a?.factor.get("opacity") ?? 1);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  private expandExcluded(direct: Set<AnyNode>): Set<AnyNode> {
    // Bindings target nodes anywhere under an excluded root; expand by walking.
    const all = new Set<AnyNode>();
    const walk = (n: AnyNode, gone: boolean): void => {
      const g = gone || direct.has(n);
      if (g) all.add(n);
      if (n.type !== "sprite") for (const c of n.children) walk(c, g);
    };
    walk(this.model.root, false);
    return all;
  }

  private requireParam(id: string): void {
    if (!this.model.paramsById.has(id)) throw new Error(`unknown parameter "${id}"`);
  }

  private expressionDef(id: string): ExpressionDef {
    const def = this.model.expressions.find((e) => e.id === id);
    if (!def) throw new Error(`unknown expression "${id}"`);
    return def;
  }

  private requireMutationOutsideUpdate(operation: string): void {
    if (this.updateActive) {
      throw new Error(`cannot ${operation} while a runtime update is in progress`);
    }
  }
}

function clamp01(v: number): number {
  requireFinite(v, "weight");
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Advance one expression fade from a compensated elapsed clock.
 *
 * Recomputing from the fade's start point avoids accumulating `dt/fade`
 * rounding at every frame, so bulk and fragmented updates reach exactly the
 * same weights at fixed-step boundaries.
 */
function expressionProgressAfter(
  weight: number,
  target: number,
  fadeStartWeight: number,
  elapsed: number,
  elapsedError: number,
  fadeIn: number,
  fadeOut: number,
  dt: number,
): { weight: number; elapsed: number; elapsedError: number } {
  if (weight === target) return { weight, elapsed, elapsedError };
  const duration = target > fadeStartWeight ? fadeIn : fadeOut;
  if (duration === 0) return { weight: target, elapsed: 0, elapsedError: 0 };

  const next = addCompensated(elapsed, elapsedError, dt);
  const totalElapsed = compensatedValue(next.value, next.error);
  const totalFadeTime = Math.abs(target - fadeStartWeight) * duration;
  if (totalElapsed >= totalFadeTime) {
    return { weight: target, elapsed: 0, elapsedError: 0 };
  }
  const direction = target > fadeStartWeight ? 1 : -1;
  return {
    weight: fadeStartWeight + direction * (totalElapsed / duration),
    elapsed: next.value,
    elapsedError: next.error,
  };
}

function requireFinite(v: number, what: string): void {
  if (!Number.isFinite(v)) throw new RangeError(`${what} must be finite`);
}

export function createRuntime(model: Model): LyreRuntime {
  return new LyreRuntime(model);
}
