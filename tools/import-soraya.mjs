#!/usr/bin/env node

// Rebuild the real-world Soraya example from the source rig and atlas archived
// under examples/soraya.lyre/source/original. The source renderer uses a
// different mesh diagonal and a few authoring conventions, so conversion is
// deliberately explicit instead of treating its JSON as if it were Lyre.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

import { IdleMotion } from "../examples/soraya.lyre/source/original/motion.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "examples", "soraya.lyre");
const source = join(example, "source", "original");
const requireFromValidator = createRequire(join(root, "packages", "validate", "package.json"));
const { PNG } = requireFromValidator("pngjs");

const sourceRig = JSON.parse(readFileSync(join(source, "rig.json"), "utf8"));
const sourceAtlas = JSON.parse(readFileSync(join(source, "atlas.json"), "utf8"));
const atlasBytes = readFileSync(join(example, "atlas.png"));
const atlas = PNG.sync.read(atlasBytes);
const fallback = PNG.sync.read(readFileSync(join(source, "fallback.png")));
const radiansToDegrees = 180 / Math.PI;

function invariant(condition, message) {
  if (!condition) throw new Error(`Soraya import: ${message}`);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value) {
  invariant(Number.isFinite(value), `non-finite generated number ${String(value)}`);
  const result = Number(value.toFixed(4));
  return Object.is(result, -0) ? 0 : result;
}

function snakeId(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function pixelHash(image) {
  return createHash("sha256").update(image.data).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

invariant(sourceRig.version === 1, "unsupported source rig version");
invariant(sourceAtlas.version === 1, "unsupported source atlas version");
invariant(
  atlas.width === sourceAtlas.width && atlas.height === sourceAtlas.height,
  "atlas size mismatch",
);
invariant(
  pixelHash(atlas) === sourceAtlas.texture.sha256,
  "atlas decoded-pixel hash differs from the source manifest",
);
invariant(
  pixelHash(fallback) === sourceAtlas.fallback.sha256,
  "fallback decoded-pixel hash differs from the source manifest",
);

const sourceParams = sourceRig.parameters;
const parameterPlans = new Map();

for (const [sourceId, definition] of Object.entries(sourceParams)) {
  const direct = {
    sourceId,
    id: snakeId(sourceId),
    definition: {
      id: snakeId(sourceId),
      min: definition.min,
      max: definition.max,
      default: definition.default,
    },
    includeSourceKey: () => true,
    fromSource: (value) => value,
  };
  parameterPlans.set(sourceId, direct);
}

parameterPlans.set("rootRoll", {
  sourceId: "rootRoll",
  id: "Lyre.BodyAngleZ",
  definition: { id: "Lyre.BodyAngleZ", min: -10, max: 10, default: 0 },
  includeSourceKey: () => true,
  fromSource: (value) => value * radiansToDegrees,
});
parameterPlans.set("breath", {
  sourceId: "breath",
  id: "Lyre.Breath",
  definition: { id: "Lyre.Breath", min: 0, max: 1, default: 0 },
  // Lyre.Breath has a normative 0..1 domain and zero rest. Preserve the
  // source rig's inhale half; its negative exhale becomes the exact rest pose.
  includeSourceKey: (value) => value >= 0,
  fromSource: (value) => clamp(value, 0, 1),
});
parameterPlans.set("blinkLeft", {
  sourceId: "blinkLeft",
  id: "Lyre.EyeLOpen",
  definition: { id: "Lyre.EyeLOpen", min: 0, max: 1, default: 1 },
  includeSourceKey: () => true,
  fromSource: (value) => 1 - value,
});
parameterPlans.set("blinkRight", {
  sourceId: "blinkRight",
  id: "Lyre.EyeROpen",
  definition: { id: "Lyre.EyeROpen", min: 0, max: 1, default: 1 },
  includeSourceKey: () => true,
  fromSource: (value) => 1 - value,
});

for (const plan of parameterPlans.values()) {
  const sourceDefault = sourceParams[plan.sourceId].default;
  invariant(
    round(plan.fromSource(sourceDefault)) === plan.definition.default,
    `${plan.sourceId} does not map to its Lyre rest value`,
  );
}

function mappedKeyforms(sourceParameter, keyforms) {
  const plan = parameterPlans.get(sourceParameter);
  invariant(plan, `unknown source parameter ${sourceParameter}`);
  const mapped = keyforms
    .filter((keyform) => plan.includeSourceKey(keyform.value))
    .map((keyform) => ({
      axis: round(plan.fromSource(keyform.value)),
      sourceValue: keyform.value,
      keyform,
    }))
    .sort((left, right) => left.axis - right.axis);
  invariant(mapped.length > 0, `${sourceParameter} has no representable keyforms`);
  for (let index = 1; index < mapped.length; index++) {
    invariant(
      mapped[index - 1].axis < mapped[index].axis,
      `${sourceParameter} maps to duplicate keys`,
    );
  }
  return { plan, mapped };
}

function sourceRangeKeyforms(sourceParameter) {
  const definition = sourceParams[sourceParameter];
  const values = [definition.min, definition.default, definition.max]
    .filter((value, index, all) => all.indexOf(value) === index)
    .map((value) => ({ value }));
  return mappedKeyforms(sourceParameter, values);
}

const atlasLayers = new Map(sourceAtlas.layers.map((layer) => [layer.name, layer]));
const authoredDrawables = sourceRig.drawables.map((definition, authoredOrder) => ({
  definition,
  authoredOrder,
  atlasOrder: atlasLayers.get(definition.textureLayer ?? definition.id)?.drawOrder,
}));
authoredDrawables.sort(
  (left, right) =>
    (left.atlasOrder ?? Number.MAX_SAFE_INTEGER) - (right.atlasOrder ?? Number.MAX_SAFE_INTEGER) ||
    left.authoredOrder - right.authoredOrder,
);

function drawableGeometry(definition) {
  const layer = atlasLayers.get(definition.textureLayer ?? definition.id);
  invariant(layer, `${definition.id} references a missing atlas layer`);
  const bounds = definition.bounds ?? layer.source;
  const columns = Math.max(2, Math.floor(definition.grid?.[0] ?? 2));
  const rows = Math.max(2, Math.floor(definition.grid?.[1] ?? 2));
  const points = [];
  const normalized = [];
  for (let row = 0; row < rows; row++) {
    const v = row / (rows - 1);
    for (let column = 0; column < columns; column++) {
      const u = column / (columns - 1);
      points.push([round(bounds.x + bounds.width * u), round(bounds.y + bounds.height * v)]);
      normalized.push([u, v]);
    }
  }
  const tris = [];
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const topLeft = row * columns + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      // Preserve the source rig's ↗ diagonal instead of silently switching to
      // Lyre's generated-grid ↘ diagonal.
      tris.push([topLeft, bottomLeft, topRight], [topRight, bottomLeft, bottomRight]);
    }
  }
  return { layer, bounds, columns, rows, points, normalized, tris };
}

function keyformOffsets(keyform, columns, rows, label) {
  const count = columns * rows;
  if (keyform.offsets === undefined) return Array.from({ length: count }, () => [0, 0]);
  invariant(keyform.offsets.length === count, `${label} has the wrong cage offset count`);
  return keyform.offsets.map((pair) => {
    invariant(Array.isArray(pair) && pair.length === 2, `${label} has a malformed cage offset`);
    return pair;
  });
}

function sampleCage(offsets, columns, rows, u, v) {
  const x = clamp(u, 0, 1) * (columns - 1);
  const y = clamp(v, 0, 1) * (rows - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(columns - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const at = (column, row) => offsets[row * columns + column];
  const interpolate = (component) => {
    const top = at(x0, y0)[component] + (at(x1, y0)[component] - at(x0, y0)[component]) * tx;
    const bottom = at(x0, y1)[component] + (at(x1, y1)[component] - at(x0, y1)[component]) * tx;
    return top + (bottom - top) * ty;
  };
  return [round(interpolate(0)), round(interpolate(1))];
}

function cageDeltas(definition, geometry, keyform) {
  const columns = Math.max(2, Math.floor(definition.grid?.[0] ?? 0));
  const rows = Math.max(2, Math.floor(definition.grid?.[1] ?? 0));
  const offsets = keyformOffsets(keyform, columns, rows, `${definition.parameter} keyform`);
  return geometry.points.map((point, index) => {
    const [u, v] = geometry.normalized[index];
    const sampleU = definition.domain
      ? (point[0] - definition.domain.x) / definition.domain.width
      : u;
    const sampleV = definition.domain
      ? (point[1] - definition.domain.y) / definition.domain.height
      : v;
    return sampleCage(offsets, columns, rows, sampleU, sampleV);
  });
}

function axisScaleDeltas(definition, geometry, keyform) {
  const angle = ((definition.angleDegrees ?? 0) * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const scale = keyform.scale ?? 1;
  const scaleAlong = keyform.scaleAlong ?? 1;
  const translate = keyform.translate ?? 0;
  const curve = keyform.curve ?? 0;
  return geometry.points.map(([x, y], index) => {
    const u = geometry.normalized[index][0];
    const relativeX = x - definition.center[0];
    const relativeY = y - definition.center[1];
    const along = relativeX * cosine + relativeY * sine;
    const normal = -relativeX * sine + relativeY * cosine;
    const curvedNormal = normal * scale + translate + curve * ((u * 2 - 1) ** 2 - 0.5);
    const scaledAlong = along * scaleAlong;
    const transformedX = definition.center[0] + scaledAlong * cosine - curvedNormal * sine;
    const transformedY = definition.center[1] + scaledAlong * sine + curvedNormal * cosine;
    return [round(transformedX - x), round(transformedY - y)];
  });
}

function deformerBinding(drawableId, definition, geometry) {
  const { plan, mapped } = mappedKeyforms(definition.parameter, definition.keyforms);
  const sourceRest = sourceParams[definition.parameter].default;
  const restKeyform = definition.keyforms.find((keyform) => keyform.value === sourceRest);
  invariant(restKeyform, `${drawableId}.${definition.parameter} has no source-rest keyform`);
  const deltasFor = (keyform) =>
    definition.kind === "cage"
      ? cageDeltas(definition, geometry, keyform)
      : axisScaleDeltas(definition, geometry, keyform);
  const restDeltas = deltasFor(restKeyform);
  return {
    target: drawableId,
    property: "verts",
    params: [plan.id],
    axes: [mapped.map(({ axis }) => axis)],
    values: mapped.map(({ keyform }) =>
      deltasFor(keyform).map((pair, index) => [
        round(pair[0] - restDeltas[index][0]),
        round(pair[1] - restDeltas[index][1]),
      ]),
    ),
    $note: `Imported ${definition.kind} deformation from source parameter ${definition.parameter}, rebased to a zero-delta Lyre rest key.`,
  };
}

function opacityBinding(drawableId, definition, note) {
  const { plan, mapped } = mappedKeyforms(definition.parameter, definition.keyforms);
  const sourceRest = sourceParams[definition.parameter].default;
  const restKeyform = definition.keyforms.find((keyform) => keyform.value === sourceRest);
  invariant(
    restKeyform,
    `${drawableId}.${definition.parameter} opacity has no source-rest keyform`,
  );
  invariant(restKeyform.opacity > 0, `${drawableId}.${definition.parameter} has zero rest opacity`);
  return {
    target: drawableId,
    property: "opacity",
    params: [plan.id],
    axes: [mapped.map(({ axis }) => axis)],
    values: mapped.map(({ keyform }) => round(keyform.opacity / restKeyform.opacity)),
    $note: note,
  };
}

function cropTexture(definition, geometry, textureId) {
  const cropX = geometry.layer.atlas.x + (geometry.bounds.x - geometry.layer.source.x);
  const cropY = geometry.layer.atlas.y + (geometry.bounds.y - geometry.layer.source.y);
  const width = geometry.bounds.width;
  const height = geometry.bounds.height;
  invariant(
    [cropX, cropY, width, height].every(Number.isInteger),
    `${definition.id} crop is not integer-aligned`,
  );
  invariant(
    cropX >= 0 && cropY >= 0 && cropX + width <= atlas.width && cropY + height <= atlas.height,
    `${definition.id} crop leaves the atlas`,
  );
  const cropped = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sourceStart = ((cropY + y) * atlas.width + cropX) * 4;
    const targetStart = y * width * 4;
    atlas.data.copy(cropped.data, targetStart, sourceStart, sourceStart + width * 4);
  }
  writeFileSync(join(example, "textures", `${textureId}.png`), PNG.sync.write(cropped));
  return [cropX, cropY, width, height];
}

const spritesBySourceGroup = new Map(sourceRig.groups.map((group) => [group.id, []]));
const bindings = [];
const atlasRects = {};
const drawableRecords = new Map();

for (let z = 0; z < authoredDrawables.length; z++) {
  const definition = authoredDrawables[z].definition;
  const id = snakeId(definition.id);
  const texture = id;
  const geometry = drawableGeometry(definition);
  const sprite = {
    id,
    type: "sprite",
    rect: [geometry.bounds.x, geometry.bounds.y, geometry.bounds.width, geometry.bounds.height],
    texture,
    z,
    mesh: { type: "explicit", points: geometry.points, tris: geometry.tris },
    ...(definition.clip ? { mask: { mode: "alpha", sources: [snakeId(definition.clip)] } } : {}),
    $note: `Imported source drawable ${definition.id} (${definition.textureLayer ?? definition.id}).`,
  };
  spritesBySourceGroup.get(definition.group).push(sprite);
  atlasRects[texture] = cropTexture(definition, geometry, texture);
  for (const deformer of definition.deformers ?? []) {
    invariant(
      deformer.kind === "cage" || deformer.kind === "axisScale",
      `${definition.id} uses unsupported ${deformer.kind}`,
    );
    bindings.push(deformerBinding(id, deformer, geometry));
  }
  if (definition.opacityBinding) {
    bindings.push(
      opacityBinding(
        id,
        definition.opacityBinding,
        `Imported source opacity for ${definition.id}.`,
      ),
    );
  }
  drawableRecords.set(definition.id, { definition, id });
}

// The source renderer multiplies a clip source's opacity into its mask. Lyre
// intentionally ignores mask-source opacity, so fold the same uniform factor
// into each clipped sprite; alpha(x,y) * sourceOpacity remains algebraically
// identical without weakening Lyre's mask rule.
for (const { definition, id } of drawableRecords.values()) {
  if (!definition.clip) continue;
  const maskSource = drawableRecords.get(definition.clip)?.definition;
  if (maskSource?.opacityBinding) {
    bindings.push(
      opacityBinding(
        id,
        maskSource.opacityBinding,
        `Compensates for source mask ${definition.clip}'s animated opacity under Lyre mask semantics.`,
      ),
    );
  }
}

const groupDefinitions = new Map(sourceRig.groups.map((group) => [group.id, group]));
const childGroups = new Map(sourceRig.groups.map((group) => [group.id, []]));
let sourceRoot = null;
for (const group of sourceRig.groups) {
  if (group.parent) childGroups.get(group.parent).push(group.id);
  else {
    invariant(sourceRoot === null, "source rig has more than one transform root");
    sourceRoot = group.id;
  }
  const transform = group.transform ?? {};
  invariant(
    (transform.translateX ?? 0) === 0 &&
      (transform.translateY ?? 0) === 0 &&
      (transform.rotation ?? 0) === 0 &&
      (transform.scaleX ?? 1) === 1 &&
      (transform.scaleY ?? 1) === 1,
    `${group.id} has a non-rest source transform that requires baking`,
  );
  invariant(
    !group.bindings?.scale?.length &&
      !group.bindings?.scaleX?.length &&
      !group.bindings?.scaleY?.length,
    `${group.id} has a non-uniform/additive scale binding that is not directly representable`,
  );
}
invariant(sourceRoot, "source rig has no transform root");

function addGroupBindings(group, target) {
  const add = (sourceBinding, property, valueForSource) => {
    const { plan, mapped } = sourceRangeKeyforms(sourceBinding.parameter);
    const restValue = valueForSource(sourceParams[sourceBinding.parameter].default, sourceBinding);
    bindings.push({
      target,
      property,
      params: [plan.id],
      axes: [mapped.map(({ axis }) => axis)],
      values: mapped.map(({ sourceValue }) => {
        const value = valueForSource(sourceValue, sourceBinding);
        return Array.isArray(value)
          ? value.map((component, index) => round(component - restValue[index]))
          : round(value - restValue);
      }),
      $note: `Imported ${group.id}.${property} binding from ${sourceBinding.parameter}, rebased to the Lyre rest key.`,
    });
  };
  for (const sourceBinding of group.bindings?.translateX ?? []) {
    add(sourceBinding, "pivot_offset", (value, binding) => [
      round(value * (binding.scale ?? 1) + (binding.offset ?? 0)),
      0,
    ]);
  }
  for (const sourceBinding of group.bindings?.translateY ?? []) {
    add(sourceBinding, "pivot_offset", (value, binding) => [
      0,
      round(value * (binding.scale ?? 1) + (binding.offset ?? 0)),
    ]);
  }
  for (const sourceBinding of group.bindings?.rotation ?? []) {
    add(sourceBinding, "angle", (value, binding) =>
      round((value * (binding.scale ?? 1) + (binding.offset ?? 0)) * radiansToDegrees),
    );
  }
}

function groupNode(sourceId) {
  const definition = groupDefinitions.get(sourceId);
  const id = `${snakeId(sourceId)}_rot`;
  addGroupBindings(definition, id);
  return {
    id,
    type: "rotator",
    pivot: definition.pivot.map(round),
    children: [...spritesBySourceGroup.get(sourceId), ...childGroups.get(sourceId).map(groupNode)],
    $note: `Imported source transform group ${sourceId}.`,
  };
}

const params = [...parameterPlans.values()].map((plan) => ({
  ...plan.definition,
  $note: `Mapped from source parameter ${plan.sourceId}.`,
}));

const rig = {
  params,
  nodes: [
    {
      id: "root",
      type: "group",
      children: [groupNode(sourceRoot)],
      $note: "Lyre container root; root_rot preserves the source rig transform.",
    },
  ],
  bindings,
};

function smoothstep(value) {
  const amount = clamp(value, 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function simplifySamples(samples, tolerance) {
  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;
  const stack = [[0, samples.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    const left = samples[start];
    const right = samples[end];
    let largest = tolerance;
    let selected = -1;
    for (let index = start + 1; index < end; index++) {
      const amount = (samples[index].t - left.t) / (right.t - left.t);
      const expected = left.v + (right.v - left.v) * amount;
      const error = Math.abs(samples[index].v - expected);
      if (error > largest) {
        largest = error;
        selected = index;
      }
    }
    if (selected !== -1) {
      keep[selected] = 1;
      stack.push([start, selected], [selected, end]);
    }
  }
  return samples.filter((_, index) => keep[index]);
}

const motionDuration = 16;
const loopFadeStart = 14;
const motionFps = 120;
const controller = new IdleMotion({ seed: 1234, fixedDelta: 1 / motionFps });
const initialPose = controller.parameters;
const motionSamples = new Map([...parameterPlans.keys()].map((sourceId) => [sourceId, []]));
const tolerances = {
  rootX: 0.01,
  rootY: 0.015,
  rootRoll: 0.002,
  breath: 0.006,
  blinkLeft: 0.008,
  blinkRight: 0.008,
};

for (let step = 0; step <= motionDuration * motionFps; step++) {
  if (step > 0) controller.update(1 / motionFps);
  const t = step / motionFps;
  const pose = controller.parameters;
  const fade =
    t <= loopFadeStart ? 0 : smoothstep((t - loopFadeStart) / (motionDuration - loopFadeStart));
  for (const [sourceId, plan] of parameterPlans) {
    const sourceValue = pose[sourceId] * (1 - fade) + initialPose[sourceId] * fade;
    const value = clamp(plan.fromSource(sourceValue), plan.definition.min, plan.definition.max);
    motionSamples.get(sourceId).push({ t, v: value });
  }
}

const tracks = [];
for (const [sourceId, plan] of parameterPlans) {
  const simplified = simplifySamples(motionSamples.get(sourceId), tolerances[sourceId] ?? 0.008);
  const keys = simplified.map(({ t, v }) => ({ t: round(t), v: round(v) }));
  keys[0].t = 0;
  keys[keys.length - 1] = { t: motionDuration, v: keys[0].v };
  tracks.push({
    param: plan.id,
    keys,
    $note: `Deterministic seed-1234 capture of source channel ${sourceId}, linearly simplified.`,
  });
}

const motion = {
  id: "idle",
  duration: motionDuration,
  loop: true,
  tracks,
  $note:
    "Source autonomous spring motion captured at 120 Hz, simplified within per-channel visual tolerances, and eased to a seamless rest-value loop.",
};

const expression = {
  id: "eyes_closed",
  fade_in: 0.08,
  fade_out: 0.15,
  params: [
    { id: "Lyre.EyeLOpen", value: 0, blend: "overwrite" },
    { id: "Lyre.EyeROpen", value: 0, blend: "overwrite" },
  ],
  $note: "Interactive expression layered over the autonomous blink tracks.",
};

const manifest = {
  lyre: "0.1",
  id: "soraya",
  name: "Soraya",
  canvas: { width: sourceRig.canvas.width, height: sourceRig.canvas.height, origin: [0, 0] },
  capabilities: ["core", "motion"],
  files: {
    rig: "rig.json",
    atlas: "atlas.json",
    expressions: ["expressions/eyes_closed.exp.json"],
    motions: ["motions/idle.motion.json"],
  },
  $note: "Real-world Lyre example converted from return moe's Soraya web demo.",
};

writeJson(join(example, "manifest.json"), manifest);
writeJson(join(example, "rig.json"), rig);
writeJson(join(example, "atlas.json"), { image: "atlas.png", rects: atlasRects });
writeJson(join(example, "motions", "idle.motion.json"), motion);
writeJson(join(example, "expressions", "eyes_closed.exp.json"), expression);

stdout.write(
  `Generated Soraya: ${authoredDrawables.length} sprites, ${bindings.length} bindings, ` +
    `${tracks.reduce((total, track) => total + track.keys.length, 0)} motion keys.\n`,
);
