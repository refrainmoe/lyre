import { parseTestbedJson } from "./json.js";

export interface TimelineEventDoc {
  step: number;
  set?: Record<string, number>;
  clear?: string[];
  expression?: { id: string; weight?: number; action?: "activate" | "deactivate" };
  motion?: { id: string; action: "play" | "stop" | "weight"; weight?: number };
  variant?: { slot: string; option: string };
}

export interface TimelineDoc {
  model: string;
  fps: number;
  steps: number;
  events?: TimelineEventDoc[];
  captures?: number[];
  physics_trace?: boolean;
  use_atlas?: boolean;
}

export const TESTBED_TIMELINE_LIMITS = Object.freeze({
  // These literals mirror the public core limits. They remain local so the
  // Node-loaded Vite config has no runtime dependency on workspace TS source;
  // test/unit.ts asserts that they cannot drift from @refrain-lyre/core.
  jsonBytes: 64 * 1024 * 1024,
  idLength: 128,
  params: 10_000,
  pathBytes: 4096,
  steps: 100_000,
  events: 100_000,
  captures: 256,
});

function fail(label: string, message: string): never {
  throw new Error(`${label}: ${message}`);
}

function objectValue(value: unknown, label: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(label, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(label, `${what} must be a finite number`);
  }
  return value;
}

function weightValue(value: unknown, label: string, what: string): number {
  const weight = finiteNumber(value, label, what);
  if (weight < 0 || weight > 1) fail(label, `${what} must be within 0..1`);
  return weight;
}

function stringValue(value: unknown, label: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(label, `${what} must be a non-empty string`);
  }
  if (value.includes("\0")) fail(label, `${what} must not contain NUL`);
  if (new TextEncoder().encode(value).byteLength > TESTBED_TIMELINE_LIMITS.pathBytes) {
    fail(label, `${what} exceeds ${TESTBED_TIMELINE_LIMITS.pathBytes} UTF-8 bytes`);
  }
  return value;
}

function idValue(value: unknown, label: string, what: string): string {
  const id = stringValue(value, label, what);
  if (id.length > TESTBED_TIMELINE_LIMITS.idLength) {
    fail(label, `${what} exceeds ${TESTBED_TIMELINE_LIMITS.idLength} characters`);
  }
  return id;
}

function parseEvent(value: unknown, index: number, steps: number, label: string): TimelineEventDoc {
  const raw = objectValue(value, label, `events[${index}]`);
  const step = finiteNumber(raw.step, label, `events[${index}].step`);
  if (!Number.isSafeInteger(step) || step < 0 || step >= steps) {
    fail(label, `events[${index}].step must be an integer in [0, ${steps})`);
  }
  const actionKeys = ["set", "clear", "expression", "motion", "variant"].filter(
    (key) => raw[key] !== undefined,
  );
  if (actionKeys.length !== 1) {
    fail(
      label,
      `events[${index}] must contain exactly one of set, clear, expression, motion, or variant`,
    );
  }

  const event: TimelineEventDoc = { step };
  if (raw.set !== undefined) {
    const set = objectValue(raw.set, label, `events[${index}].set`);
    const entries = Object.entries(set);
    if (entries.length < 1 || entries.length > TESTBED_TIMELINE_LIMITS.params) {
      fail(
        label,
        `events[${index}].set must contain 1..${TESTBED_TIMELINE_LIMITS.params} parameters`,
      );
    }
    event.set = Object.fromEntries(
      entries.map(([id, input]) => [
        idValue(id, label, `events[${index}].set parameter id`),
        finiteNumber(input, label, `events[${index}].set.${id}`),
      ]),
    );
  } else if (raw.clear !== undefined) {
    if (
      !Array.isArray(raw.clear) ||
      raw.clear.length < 1 ||
      raw.clear.length > TESTBED_TIMELINE_LIMITS.params
    ) {
      fail(
        label,
        `events[${index}].clear must contain 1..${TESTBED_TIMELINE_LIMITS.params} parameter ids`,
      );
    }
    const clear = raw.clear.map((id, clearIndex) =>
      idValue(id, label, `events[${index}].clear[${clearIndex}]`),
    );
    if (new Set(clear).size !== clear.length) {
      fail(label, `events[${index}].clear must not contain duplicates`);
    }
    event.clear = clear;
  } else if (raw.expression !== undefined) {
    const expression = objectValue(raw.expression, label, `events[${index}].expression`);
    const id = idValue(expression.id, label, `events[${index}].expression.id`);
    const hasWeight = expression.weight !== undefined;
    const hasAction = expression.action !== undefined;
    if (hasWeight === hasAction) {
      fail(label, `events[${index}].expression must contain exactly one of weight or action`);
    }
    if (hasWeight) {
      event.expression = {
        id,
        weight: weightValue(expression.weight, label, `events[${index}].expression.weight`),
      };
    } else {
      if (expression.action !== "activate" && expression.action !== "deactivate") {
        fail(label, `events[${index}].expression.action must be activate or deactivate`);
      }
      event.expression = { id, action: expression.action };
    }
  } else if (raw.motion !== undefined) {
    const motion = objectValue(raw.motion, label, `events[${index}].motion`);
    const id = idValue(motion.id, label, `events[${index}].motion.id`);
    if (motion.action !== "play" && motion.action !== "stop" && motion.action !== "weight") {
      fail(label, `events[${index}].motion.action must be play, stop, or weight`);
    }
    const hasWeight = motion.weight !== undefined;
    if (motion.action === "stop" && hasWeight) {
      fail(label, `events[${index}].motion stop action must not contain weight`);
    }
    if (motion.action === "weight" && !hasWeight) {
      fail(label, `events[${index}].motion weight action requires weight`);
    }
    event.motion = {
      id,
      action: motion.action,
      ...(hasWeight
        ? { weight: weightValue(motion.weight, label, `events[${index}].motion.weight`) }
        : {}),
    };
  } else {
    const variant = objectValue(raw.variant, label, `events[${index}].variant`);
    event.variant = {
      slot: idValue(variant.slot, label, `events[${index}].variant.slot`),
      option: idValue(variant.option, label, `events[${index}].variant.option`),
    };
  }
  return event;
}

export function parseTimelineValue(value: unknown, label = "timeline"): TimelineDoc {
  const raw = objectValue(value, label, "document");
  const model = stringValue(raw.model, label, "model");
  const fps = finiteNumber(raw.fps, label, "fps");
  if (fps <= 0 || !Number.isFinite(1 / fps)) {
    fail(label, "fps must be positive and produce a finite timestep");
  }
  const steps = finiteNumber(raw.steps, label, "steps");
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > TESTBED_TIMELINE_LIMITS.steps) {
    fail(label, `steps must be an integer in [1, ${TESTBED_TIMELINE_LIMITS.steps}]`);
  }
  if (!Number.isFinite(steps / fps)) {
    fail(label, "steps and fps must produce a finite timeline duration");
  }

  let events: TimelineEventDoc[] | undefined;
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events)) fail(label, "events must be an array");
    if (raw.events.length > TESTBED_TIMELINE_LIMITS.events) {
      fail(label, `events exceeds ${TESTBED_TIMELINE_LIMITS.events} entries`);
    }
    events = raw.events.map((event, index) => parseEvent(event, index, steps, label));
  }

  let captures: number[] | undefined;
  if (raw.captures !== undefined) {
    if (!Array.isArray(raw.captures)) fail(label, "captures must be an array");
    if (raw.captures.length > TESTBED_TIMELINE_LIMITS.captures) {
      fail(label, `captures exceeds ${TESTBED_TIMELINE_LIMITS.captures} entries`);
    }
    captures = raw.captures.map((capture, index) => {
      const step = finiteNumber(capture, label, `captures[${index}]`);
      if (!Number.isSafeInteger(step) || step < 0 || step >= steps) {
        fail(label, `captures[${index}] must be an integer in [0, ${steps})`);
      }
      return step;
    });
    if (new Set(captures).size !== captures.length) {
      fail(label, "captures must not contain duplicate steps");
    }
  }

  const booleanValue = (key: "physics_trace" | "use_atlas"): boolean | undefined => {
    const field = raw[key];
    if (field === undefined) return undefined;
    if (typeof field !== "boolean") fail(label, `${key} must be a boolean`);
    return field;
  };
  const physicsTrace = booleanValue("physics_trace");
  const useAtlas = booleanValue("use_atlas");
  return {
    model,
    fps,
    steps,
    ...(events !== undefined ? { events } : {}),
    ...(captures !== undefined ? { captures } : {}),
    ...(physicsTrace !== undefined ? { physics_trace: physicsTrace } : {}),
    ...(useAtlas !== undefined ? { use_atlas: useAtlas } : {}),
  };
}

export function parseTimelineText(text: string, label = "timeline"): TimelineDoc {
  return parseTimelineValue(parseTestbedJson(text, label), label);
}

export function parseTimelineBytes(bytes: Uint8Array, label = "timeline"): TimelineDoc {
  if (bytes.byteLength > TESTBED_TIMELINE_LIMITS.jsonBytes) {
    fail(label, `JSON exceeds ${TESTBED_TIMELINE_LIMITS.jsonBytes} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(label, "must be valid UTF-8 JSON");
  }
  return parseTimelineText(text, label);
}
