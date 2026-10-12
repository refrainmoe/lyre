import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LIMITS, RUNTIME_LIMITS, parseLyreJson } from "@refrain-lyre/core";
import { createSoftRenderer } from "@refrain-lyre/render-soft";
import { loadContainerDir, type LoadedContainer } from "./container.js";
import { runTimelineSteps, type StepResult, type Timeline, type TimelineEvent } from "./steps.js";

export type { Timeline, TimelineEvent, StepResult, StepOptions } from "./steps.js";
export { runTimelineSteps } from "./steps.js";

export type RunResult = StepResult;

export interface RunOptions {
  /** §12 admission: displace initial link positions by this many px. */
  perturb?: number;
  /** Reuse an already-loaded container (perturbation reruns). */
  container?: LoadedContainer;
}

export interface ReadTimelineOptions {
  /** Resolve timeline.model from this directory instead of the timeline path's directory. */
  modelBaseDir?: string;
}

/** Internal fixture bounds: generous for focused suites, finite for typo safety. */
export const CONFORMANCE_TIMELINE_LIMITS = Object.freeze({
  jsonBytes: LIMITS.jsonFileBytes,
  steps: 100_000,
  events: 100_000,
  captures: 256,
  retainedCaptureBytes: 256 * 1024 * 1024,
  /** Combined scalar slots for the baseline and admission-perturbation traces. */
  retainedTraceScalars: 8 * 1024 * 1024,
});

function timelineError(path: string, message: string): never {
  throw new Error(`timeline "${path}": ${message}`);
}

function objectValue(value: unknown, path: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    timelineError(path, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    timelineError(path, `${what} must be a non-empty string`);
  }
  if (value.includes("\0")) timelineError(path, `${what} must not contain NUL`);
  if (Buffer.byteLength(value, "utf8") > RUNTIME_LIMITS.containerPathBytes) {
    timelineError(path, `${what} exceeds ${RUNTIME_LIMITS.containerPathBytes} UTF-8 bytes`);
  }
  return value;
}

function idValue(value: unknown, path: string, what: string): string {
  const id = stringValue(value, path, what);
  if (id.length > LIMITS.idLength) {
    timelineError(path, `${what} exceeds ${LIMITS.idLength} characters`);
  }
  return id;
}

function finiteNumber(value: unknown, path: string, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    timelineError(path, `${what} must be a finite number`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string, what: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") timelineError(path, `${what} must be a boolean`);
  return value;
}

function parseEvent(value: unknown, index: number, steps: number, path: string): TimelineEvent {
  const raw = objectValue(value, path, `events[${index}]`);
  const step = finiteNumber(raw.step, path, `events[${index}].step`);
  if (!Number.isSafeInteger(step) || step < 0 || step >= steps) {
    timelineError(path, `events[${index}].step must be an integer in [0, ${steps})`);
  }

  const actionKeys = ["set", "clear", "expression", "motion", "variant"].filter(
    (key) => raw[key] !== undefined,
  );
  if (actionKeys.length !== 1) {
    timelineError(
      path,
      `events[${index}] must contain exactly one of set, clear, expression, motion, or variant`,
    );
  }

  const event: TimelineEvent = { step };
  if (raw.set !== undefined) {
    const set = objectValue(raw.set, path, `events[${index}].set`);
    const entries = Object.entries(set);
    if (entries.length === 0 || entries.length > LIMITS.params) {
      timelineError(path, `events[${index}].set must contain 1..${LIMITS.params} parameters`);
    }
    event.set = Object.fromEntries(
      entries.map(([id, value]) => [
        idValue(id, path, `events[${index}].set parameter id`),
        finiteNumber(value, path, `events[${index}].set.${id}`),
      ]),
    );
  } else if (raw.clear !== undefined) {
    if (!Array.isArray(raw.clear) || raw.clear.length === 0 || raw.clear.length > LIMITS.params) {
      timelineError(path, `events[${index}].clear must contain 1..${LIMITS.params} parameter ids`);
    }
    const clear = raw.clear.map((id, clearIndex) =>
      idValue(id, path, `events[${index}].clear[${clearIndex}]`),
    );
    if (new Set(clear).size !== clear.length) {
      timelineError(path, `events[${index}].clear must not contain duplicate parameter ids`);
    }
    event.clear = clear;
  } else if (raw.expression !== undefined) {
    const expression = objectValue(raw.expression, path, `events[${index}].expression`);
    const id = idValue(expression.id, path, `events[${index}].expression.id`);
    const hasWeight = expression.weight !== undefined;
    const hasAction = expression.action !== undefined;
    if (hasWeight === hasAction) {
      timelineError(
        path,
        `events[${index}].expression must contain exactly one of weight or action`,
      );
    }
    if (hasWeight) {
      event.expression = {
        id,
        weight: finiteNumber(expression.weight, path, `events[${index}].expression.weight`),
      };
    } else {
      if (expression.action !== "activate" && expression.action !== "deactivate") {
        timelineError(path, `events[${index}].expression.action must be activate or deactivate`);
      }
      event.expression = { id, action: expression.action };
    }
  } else if (raw.motion !== undefined) {
    const motion = objectValue(raw.motion, path, `events[${index}].motion`);
    const id = idValue(motion.id, path, `events[${index}].motion.id`);
    if (motion.action !== "play" && motion.action !== "stop" && motion.action !== "weight") {
      timelineError(path, `events[${index}].motion.action must be play, stop, or weight`);
    }
    const hasWeight = motion.weight !== undefined;
    if (motion.action === "stop" && hasWeight) {
      timelineError(path, `events[${index}].motion stop action must not contain weight`);
    }
    if (motion.action === "weight" && !hasWeight) {
      timelineError(path, `events[${index}].motion weight action requires weight`);
    }
    event.motion = {
      id,
      action: motion.action,
      ...(hasWeight
        ? { weight: finiteNumber(motion.weight, path, `events[${index}].motion.weight`) }
        : {}),
    };
  } else {
    const variant = objectValue(raw.variant, path, `events[${index}].variant`);
    event.variant = {
      slot: idValue(variant.slot, path, `events[${index}].variant.slot`),
      option: idValue(variant.option, path, `events[${index}].variant.option`),
    };
  }
  return event;
}

function parseTimeline(value: unknown, path: string): Timeline {
  const raw = objectValue(value, path, "document");
  const model = stringValue(raw.model, path, "model");
  const fps = finiteNumber(raw.fps, path, "fps");
  if (fps <= 0 || !Number.isFinite(1 / fps)) {
    timelineError(path, "fps must be positive and produce a finite timestep");
  }
  const steps = finiteNumber(raw.steps, path, "steps");
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > CONFORMANCE_TIMELINE_LIMITS.steps) {
    timelineError(path, `steps must be an integer in [1, ${CONFORMANCE_TIMELINE_LIMITS.steps}]`);
  }
  if (!Number.isFinite(steps / fps)) {
    timelineError(path, "steps/fps must produce a finite duration");
  }

  let events: TimelineEvent[] | undefined;
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events)) timelineError(path, "events must be an array");
    if (raw.events.length > CONFORMANCE_TIMELINE_LIMITS.events) {
      timelineError(
        path,
        `events exceeds the ${CONFORMANCE_TIMELINE_LIMITS.events}-entry fixture limit`,
      );
    }
    events = raw.events.map((event, index) => parseEvent(event, index, steps, path));
  }

  let captures: number[] | undefined;
  if (raw.captures !== undefined) {
    if (!Array.isArray(raw.captures)) timelineError(path, "captures must be an array");
    if (raw.captures.length > CONFORMANCE_TIMELINE_LIMITS.captures) {
      timelineError(
        path,
        `captures exceeds the ${CONFORMANCE_TIMELINE_LIMITS.captures}-entry fixture limit`,
      );
    }
    captures = raw.captures.map((capture, index) => {
      const step = finiteNumber(capture, path, `captures[${index}]`);
      if (!Number.isSafeInteger(step) || step < 0 || step >= steps) {
        timelineError(path, `captures[${index}] must be an integer in [0, ${steps})`);
      }
      return step;
    });
    if (new Set(captures).size !== captures.length) {
      timelineError(path, "captures must not contain duplicate steps");
    }
  }

  const physicsTrace = optionalBoolean(raw.physics_trace, path, "physics_trace");
  const useAtlas = optionalBoolean(raw.use_atlas, path, "use_atlas");
  let traceChains: string[] | undefined;
  if (raw.trace_chains !== undefined) {
    if (!Array.isArray(raw.trace_chains)) timelineError(path, "trace_chains must be an array");
    if (!physicsTrace) timelineError(path, "trace_chains requires physics_trace: true");
    if (raw.trace_chains.length < 1) {
      timelineError(path, "trace_chains must contain at least one chain id");
    }
    if (raw.trace_chains.length > LIMITS.physicsChains) {
      timelineError(path, `trace_chains exceeds ${LIMITS.physicsChains} chain ids`);
    }
    traceChains = raw.trace_chains.map((id, index) => idValue(id, path, `trace_chains[${index}]`));
    if (new Set(traceChains).size !== traceChains.length) {
      timelineError(path, "trace_chains must not contain duplicate ids");
    }
  }

  return {
    model,
    fps,
    steps,
    ...(events !== undefined ? { events } : {}),
    ...(captures !== undefined ? { captures } : {}),
    ...(physicsTrace !== undefined ? { physics_trace: physicsTrace } : {}),
    ...(traceChains !== undefined ? { trace_chains: traceChains } : {}),
    ...(useAtlas !== undefined ? { use_atlas: useAtlas } : {}),
  };
}

export function readTimeline(
  path: string,
  opts: ReadTimelineOptions = {},
): { timeline: Timeline; modelDir: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) timelineError(path, "path is not a regular file");
    if (before.size > BigInt(CONFORMANCE_TIMELINE_LIMITS.jsonBytes)) {
      timelineError(
        path,
        `JSON exceeds the ${CONFORMANCE_TIMELINE_LIMITS.jsonBytes}-byte fixture limit`,
      );
    }
    const expectedSize = Number(before.size);
    bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const count = readSync(fd, bytes, offset, expectedSize - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      offset !== expectedSize ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      timelineError(path, "changed while being read");
    }
  } finally {
    closeSync(fd);
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = parseLyreJson(text, `timeline "${path}"`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    timelineError(path, `must be valid UTF-8 JSON (${detail})`);
  }
  const timeline = parseTimeline(value, path);
  return { timeline, modelDir: resolve(opts.modelBaseDir ?? dirname(path), timeline.model) };
}

/** Run a timeline file through the CPU reference renderer (§12 goldens). */
export function runTimeline(path: string, opts: RunOptions = {}): RunResult {
  const { timeline, modelDir } = readTimeline(path);
  const container = opts.container ?? loadContainerDir(modelDir);
  const { model, textures, atlasImage } = container;

  const renderer = createSoftRenderer(model.canvas.width, model.canvas.height);
  for (const [id, img] of textures) {
    const atlasRect = timeline.use_atlas ? model.atlas?.rects.get(id) : undefined;
    if (atlasRect && atlasImage) renderer.setTexture(id, atlasImage, atlasRect);
    else renderer.setTexture(id, img);
  }

  return runTimelineSteps(model, renderer, timeline, {
    ...(opts.perturb !== undefined ? { perturb: opts.perturb } : {}),
  });
}
