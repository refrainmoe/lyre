// `lyre-validate stats` (§12): observed maximum of every §16 quantity, kept
// beside the normative ceilings so §16 stays anchored to measured practice.

import { LIMITS, type AnyNode, type Model } from "@refrain-lyre/core";
import type { LoadedContainer } from "./container.js";

/** Observed value per §16 quantity — keys mirror `LIMITS`. */
export type ModelStats = Record<keyof typeof LIMITS, number>;

const QUANTITY_LABELS: Record<keyof typeof LIMITS, string> = {
  containerFiles: "container files",
  containerUncompressedBytes: "container uncompressed bytes",
  jsonFileBytes: "single manifest-listed JSON document bytes",
  jsonDocumentsBytes: "aggregate manifest-listed JSON document bytes",
  idLength: "id length",
  authoredNumberMagnitude: "largest absolute authored number",
  capabilities: "model capabilities",
  params: "parameters",
  nodes: "nodes",
  treeDepth: "tree depth",
  gridColsRows: "grid or warp cols/rows",
  totalMeshPoints: "total mesh and warp control points",
  totalMeshTriangles: "total sprite-mesh triangles",
  explicitMeshPoints: "explicit mesh points per sprite",
  explicitMeshTriangles: "explicit mesh triangles per sprite",
  maskSources: "mask sources per sprite",
  maskReferences: "aggregate mask references",
  bindings: "bindings",
  bindingAxes: "binding axes",
  keysPerAxis: "keys per axis",
  valueScalarsPerBinding: "value scalars per binding",
  totalBindingValueScalars: "aggregate binding value scalars",
  expressions: "expressions",
  expressionEntries: "aggregate expression entries",
  motions: "motions",
  motionTracks: "aggregate motion tracks",
  motionKeys: "aggregate motion keys",
  atlasRects: "atlas rect/annotation entries",
  textureFileBytes: "single PNG file bytes",
  textureDimension: "texture dimension (px)",
  texturePixels: "single decoded texture pixels",
  totalTexturePixels: "aggregate decoded texture pixels",
  canvasDimension: "canvas dimension (px)",
  canvasPixels: "canvas pixels",
  physicsChains: "physics chains",
  linksPerChain: "links per chain",
  physicsInputs: "aggregate physics inputs",
  physicsOutputs: "aggregate physics outputs",
  physicsFps: "physics fps",
  variantSlots: "variant slots",
  variantOptions: "aggregate variant options",
  variantMemberships: "aggregate variant node memberships",
};

function treeDepth(node: AnyNode): number {
  if (node.type === "sprite") return 1;
  let deepest = 0;
  for (const child of node.children) deepest = Math.max(deepest, treeDepth(child));
  return 1 + deepest;
}

function maxIdLength(model: Model): number {
  let max = model.id.length;
  const see = (id: string): void => {
    if (id.length > max) max = id.length;
  };
  for (const p of model.params) see(p.id);
  for (const [id] of model.nodesById) see(id);
  for (const sprite of model.sprites) see(sprite.texture);
  for (const [id] of model.atlas?.rects ?? []) see(id);
  for (const e of model.expressions) see(e.id);
  for (const m of model.motions) see(m.id);
  for (const c of model.physics?.chains ?? []) see(c.id);
  for (const slot of model.variantSlots) {
    see(slot.id);
    for (const o of slot.options) see(o.id);
  }
  return max;
}

export function computeStats(container: LoadedContainer): ModelStats {
  const { model, textures, atlasImage, source } = container;
  const files = source.files();
  const rawManifest =
    typeof container.raw.manifest === "object" &&
    container.raw.manifest !== null &&
    !Array.isArray(container.raw.manifest)
      ? (container.raw.manifest as Record<string, unknown>)
      : null;
  const listedCapabilities = Array.isArray(rawManifest?.capabilities)
    ? rawManifest.capabilities.length
    : 0;

  let jsonBytes = 0;
  let jsonDocumentsBytes = 0;
  let totalBytes = 0;
  for (const rel of files) {
    const size = source.size(rel);
    totalBytes += size;
  }
  // `manifest.files` is authoritative regardless of filename extension;
  // opaque payload JSON is deliberately excluded from the §16 JSON maxima.
  const listedJsonPaths = new Set([
    container.rawPaths.manifest,
    container.rawPaths.rig,
    ...(container.rawPaths.physics ? [container.rawPaths.physics] : []),
    ...(container.rawPaths.variants ? [container.rawPaths.variants] : []),
    ...(container.rawPaths.atlas ? [container.rawPaths.atlas] : []),
    ...Object.keys(container.raw.expressions ?? {}),
    ...Object.keys(container.raw.motions ?? {}),
  ]);
  for (const rel of listedJsonPaths) {
    const size = source.size(rel);
    jsonBytes = Math.max(jsonBytes, size);
    jsonDocumentsBytes += size;
  }

  let gridColsRows = 0;
  let totalMeshPoints = 0;
  let totalMeshTriangles = 0;
  let explicitMeshPoints = 0;
  let explicitMeshTriangles = 0;
  let maskSources = 0;
  let maskReferences = 0;
  let authoredNumberMagnitude = 0;
  const seeNumber = (value: number): void => {
    authoredNumberMagnitude = Math.max(authoredNumberMagnitude, Math.abs(value));
  };
  seeNumber(model.canvas.width);
  seeNumber(model.canvas.height);
  model.canvas.origin.forEach(seeNumber);
  for (const p of model.params) {
    seeNumber(p.min);
    seeNumber(p.max);
    seeNumber(p.default);
  }
  const visit = (node: AnyNode): void => {
    if (node.type === "warp") {
      gridColsRows = Math.max(gridColsRows, node.cols, node.rows);
      totalMeshPoints += (node.cols + 1) * (node.rows + 1);
      node.rect.forEach(seeNumber);
      seeNumber(node.cols);
      seeNumber(node.rows);
    }
    if (node.type === "sprite") {
      node.rect.forEach(seeNumber);
      seeNumber(node.z);
      seeNumber(node.opacity);
      const sourceCount = node.mask?.sources.length ?? 0;
      maskSources = Math.max(maskSources, sourceCount);
      maskReferences += sourceCount;
      if (node.mesh.type === "grid") {
        gridColsRows = Math.max(gridColsRows, node.mesh.cols, node.mesh.rows);
        totalMeshPoints += (node.mesh.cols + 1) * (node.mesh.rows + 1);
        totalMeshTriangles += 2 * node.mesh.cols * node.mesh.rows;
        seeNumber(node.mesh.cols);
        seeNumber(node.mesh.rows);
      } else {
        totalMeshPoints += node.mesh.points.length;
        totalMeshTriangles += node.mesh.tris.length;
        explicitMeshPoints = Math.max(explicitMeshPoints, node.mesh.points.length);
        explicitMeshTriangles = Math.max(explicitMeshTriangles, node.mesh.tris.length);
        for (const point of node.mesh.points) point.forEach(seeNumber);
        for (const triangle of node.mesh.tris) triangle.forEach(seeNumber);
      }
    }
    if (node.type === "group") seeNumber(node.opacity);
    if (node.type === "rotator") {
      node.pivot.forEach(seeNumber);
      seeNumber(node.angle);
      seeNumber(node.scale);
    }
    if (node.type !== "sprite") for (const c of node.children) visit(c);
  };
  visit(model.root);

  let bindingAxes = 0;
  let keysPerAxis = 0;
  let valueScalars = 0;
  let totalBindingValueScalars = 0;
  for (const b of model.bindings) {
    bindingAxes = Math.max(bindingAxes, b.axes.length);
    for (const axis of b.axes) {
      keysPerAxis = Math.max(keysPerAxis, axis.length);
      axis.forEach(seeNumber);
    }
    valueScalars = Math.max(valueScalars, b.values.length);
    totalBindingValueScalars += b.values.length;
    b.values.forEach(seeNumber);
  }

  let expressionEntries = 0;
  for (const expression of model.expressions) {
    seeNumber(expression.fadeIn);
    seeNumber(expression.fadeOut);
    expressionEntries += expression.params.length;
    for (const entry of expression.params) seeNumber(entry.value);
  }
  let motionTracks = 0;
  let motionKeys = 0;
  for (const motion of model.motions) {
    seeNumber(motion.duration);
    motionTracks += motion.tracks.length;
    for (const track of motion.tracks) {
      motionKeys += track.keys.length;
      for (const key of track.keys) {
        seeNumber(key.t);
        seeNumber(key.v);
        if (key.ease.type === "bezier") key.ease.cp.forEach(seeNumber);
      }
    }
  }
  let physicsInputs = 0;
  let physicsOutputs = 0;
  if (model.physics) {
    seeNumber(model.physics.fps);
    for (const chain of model.physics.chains) {
      physicsInputs += chain.inputs.length;
      physicsOutputs += chain.outputs.length;
      chain.gravity.forEach(seeNumber);
      chain.wind.forEach(seeNumber);
      for (const input of chain.inputs) seeNumber(input.weight);
      for (const link of chain.links) {
        seeNumber(link.length);
        seeNumber(link.damping);
        seeNumber(link.stiffness);
      }
      for (const output of chain.outputs) {
        seeNumber(output.link);
        seeNumber(output.multiplier);
      }
    }
  }
  let variantOptions = 0;
  let variantMemberships = 0;
  for (const slot of model.variantSlots) {
    variantOptions += slot.options.length;
    for (const option of slot.options) variantMemberships += option.nodes.length;
  }
  for (const rect of model.atlas?.rects.values() ?? []) rect.forEach(seeNumber);
  const rawAtlas =
    typeof container.raw.atlas === "object" &&
    container.raw.atlas !== null &&
    !Array.isArray(container.raw.atlas)
      ? (container.raw.atlas as Record<string, unknown>)
      : null;
  const rawRects =
    typeof rawAtlas?.rects === "object" && rawAtlas.rects !== null && !Array.isArray(rawAtlas.rects)
      ? (rawAtlas.rects as Record<string, unknown>)
      : null;
  const atlasRectEntries = rawRects ? Object.keys(rawRects).length : 0;

  let textureFileBytes = 0;
  for (const id of textures.keys()) {
    const path = `textures/${id}.png`;
    if (source.has(path)) textureFileBytes = Math.max(textureFileBytes, source.size(path));
  }
  if (model.atlas && source.has(model.atlas.image)) {
    textureFileBytes = Math.max(textureFileBytes, source.size(model.atlas.image));
  }

  let textureDimension = 0;
  let texturePixels = 0;
  let totalTexturePixels = 0;
  for (const img of textures.values()) {
    textureDimension = Math.max(textureDimension, img.width, img.height);
    const pixels = img.width * img.height;
    texturePixels = Math.max(texturePixels, pixels);
    totalTexturePixels += pixels;
  }
  if (atlasImage) {
    textureDimension = Math.max(textureDimension, atlasImage.width, atlasImage.height);
    const pixels = atlasImage.width * atlasImage.height;
    texturePixels = Math.max(texturePixels, pixels);
    totalTexturePixels += pixels;
  }

  return {
    containerFiles: files.length,
    containerUncompressedBytes: totalBytes,
    jsonFileBytes: jsonBytes,
    jsonDocumentsBytes,
    idLength: maxIdLength(model),
    authoredNumberMagnitude,
    capabilities: listedCapabilities,
    params: model.params.length,
    nodes: model.nodesById.size,
    treeDepth: treeDepth(model.root),
    gridColsRows,
    totalMeshPoints,
    totalMeshTriangles,
    explicitMeshPoints,
    explicitMeshTriangles,
    maskSources,
    maskReferences,
    bindings: model.bindings.length,
    bindingAxes,
    keysPerAxis,
    valueScalarsPerBinding: valueScalars,
    totalBindingValueScalars,
    expressions: model.expressions.length,
    expressionEntries,
    motions: model.motions.length,
    motionTracks,
    motionKeys,
    atlasRects: atlasRectEntries,
    textureFileBytes,
    textureDimension,
    texturePixels,
    totalTexturePixels,
    canvasDimension: Math.max(model.canvas.width, model.canvas.height),
    canvasPixels: model.canvas.width * model.canvas.height,
    physicsChains: model.physics?.chains.length ?? 0,
    linksPerChain: Math.max(0, ...(model.physics?.chains.map((c) => c.links.length) ?? [])),
    physicsInputs,
    physicsOutputs,
    physicsFps: model.physics?.fps ?? 0,
    variantSlots: model.variantSlots.length,
    variantOptions,
    variantMemberships,
  };
}

/** Element-wise maximum across models (corpus aggregation). */
export function mergeStats(all: ModelStats[]): ModelStats {
  const keys = Object.keys(QUANTITY_LABELS) as Array<keyof typeof LIMITS>;
  const out = {} as ModelStats;
  for (const k of keys) out[k] = Math.max(0, ...all.map((s) => s[k]));
  return out;
}

export function statsMarkdown(stats: ModelStats, title: string): string {
  const keys = Object.keys(QUANTITY_LABELS) as Array<keyof typeof LIMITS>;
  const rows = keys.map((key) => ({
    quantity: QUANTITY_LABELS[key],
    ceiling: LIMITS[key].toLocaleString("en-US"),
    observed: stats[key].toLocaleString("en-US"),
  }));
  const quantityWidth = Math.max("§16 quantity".length, ...rows.map((row) => row.quantity.length));
  const ceilingWidth = Math.max("ceiling".length, ...rows.map((row) => row.ceiling.length));
  const observedWidth = Math.max("observed max".length, ...rows.map((row) => row.observed.length));
  const lines = [
    `# ${title}`,
    "",
    `| ${"§16 quantity".padEnd(quantityWidth)} | ${"ceiling".padStart(ceilingWidth)} | ${"observed max".padStart(observedWidth)} |`,
    `| ${"-".repeat(quantityWidth)} | ${"-".repeat(ceilingWidth - 1)}: | ${"-".repeat(observedWidth - 1)}: |`,
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.quantity.padEnd(quantityWidth)} | ${row.ceiling.padStart(ceilingWidth)} | ${row.observed.padStart(observedWidth)} |`,
    );
  }
  return lines.join("\n") + "\n";
}
