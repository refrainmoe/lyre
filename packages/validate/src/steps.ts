// Pure timeline stepping (no I/O): shared by the Node conformance runner and
// the in-browser WebGL harness so event semantics can never drift between the
// two. Timeline format is documented in conformance/README.md.

import { createRuntime, type Model, type SurfaceRenderer } from "@refrain-lyre/core";

export interface TimelineEvent {
  step: number;
  set?: Record<string, number>;
  clear?: string[];
  expression?: { id: string; weight?: number; action?: "activate" | "deactivate" };
  motion?: { id: string; action: "play" | "stop" | "weight"; weight?: number };
  variant?: { slot: string; option: string };
}

export interface Timeline {
  model: string;
  fps: number;
  steps: number;
  events?: TimelineEvent[];
  captures?: number[];
  physics_trace?: boolean;
  /** When set, only these chains are traced (e.g. §10.3 rule 5 skippable chains). */
  trace_chains?: string[];
  /** Render through atlas.json rects instead of per-file textures (§3.2). */
  use_atlas?: boolean;
}

export interface StepResult {
  width: number;
  height: number;
  /** Premultiplied RGBA surface dumps keyed by step. */
  captures: Map<number, Uint8Array>;
  /** Per-chain, per-internal-physics-step link output angles (degrees). */
  trace: Record<string, number[][]> | null;
  zeroVectorCount: number;
}

export interface StepOptions {
  /** §12 admission: displace initial link positions by this many px. */
  perturb?: number;
}

/**
 * Drive `model` through `timeline` on `renderer` (apply events → update →
 * capture post-evaluate). Physics-trace runs use integer-indexed outer
 * endpoints and sample every internal fixed-step boundary, even when timeline
 * and solver rates differ.
 * Textures must already be loaded into the renderer.
 */
export function runTimelineSteps(
  model: Model,
  renderer: SurfaceRenderer,
  timeline: Timeline,
  opts: StepOptions = {},
): StepResult {
  const rt = createRuntime(model);
  if (opts.perturb) rt.physics?.perturbLinks(opts.perturb);

  const byStep = new Map<number, TimelineEvent[]>();
  for (const e of timeline.events ?? []) {
    const list = byStep.get(e.step);
    if (list) list.push(e);
    else byStep.set(e.step, [e]);
  }
  const captureSet = new Set(timeline.captures ?? []);
  const traceChains =
    timeline.physics_trace && model.physics
      ? (timeline.trace_chains ?? model.physics.chains.map((c) => c.id))
      : [];
  const trace: Record<string, number[][]> | null = timeline.physics_trace
    ? Object.fromEntries(traceChains.map((id) => [id, []]))
    : null;

  const result: StepResult = {
    width: model.canvas.width,
    height: model.canvas.height,
    captures: new Map(),
    trace,
    zeroVectorCount: 0,
  };

  const timelineDt = 1 / timeline.fps;
  let elapsed = 0;
  const appendTraceSample = (): void => {
    for (const id of traceChains) {
      // Round to 1e-9° — far below the ±0.1° tolerance, keeps JSON diffable.
      trace![id]!.push(
        rt.physics!.linkAngles(id).map((angle) => Math.round(angle * 1e9) / 1e9 + 0),
      );
    }
  };

  for (let step = 0; step < timeline.steps; step++) {
    for (const e of byStep.get(step) ?? []) applyEvent(rt, e);

    // Derive each outer endpoint from its integer index. Repeatedly adding or
    // subtracting 1/fps can leave an exact ten-second script one ULP short and
    // silently lose its final fixed-step boundary at non-integral cadences.
    const outerEndpoint = (step + 1) / timeline.fps;
    const duration = trace ? Math.max(0, outerEndpoint - elapsed) : timelineDt;
    if (duration > 0) rt.update(duration, trace ? appendTraceSample : undefined);
    elapsed = outerEndpoint;

    if (captureSet.has(step)) {
      renderer.render(rt.evaluate());
      result.captures.set(step, renderer.readSurface());
    }
  }
  result.zeroVectorCount = rt.physics?.zeroVectorCount ?? 0;
  return result;
}

function applyEvent(rt: ReturnType<typeof createRuntime>, e: TimelineEvent): void {
  if (e.set) for (const [id, v] of Object.entries(e.set)) rt.setParam(id, v);
  if (e.clear) for (const id of e.clear) rt.clearParam(id);
  if (e.expression) {
    if (e.expression.weight !== undefined) {
      rt.setExpressionWeight(e.expression.id, e.expression.weight);
    } else {
      rt.setExpression(e.expression.id, e.expression.action !== "deactivate");
    }
  }
  if (e.motion) {
    if (e.motion.action === "play") rt.playMotion(e.motion.id, e.motion.weight ?? 1);
    else if (e.motion.action === "stop") rt.stopMotion(e.motion.id);
    else rt.setMotionWeight(e.motion.id, e.motion.weight ?? 1);
  }
  if (e.variant) rt.setVariant(e.variant.slot, e.variant.option);
}
