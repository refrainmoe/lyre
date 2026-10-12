// §12 rest-pose check: the all-defaults render must equal a reference
// composite of the exported layers under §8.3 semantics (±2/255 on ≥99.9% of
// pixels, plus the bounded connected-region guard for >16/255 outliers). The reference frame is
// deliberately NOT the evaluation pipeline:
// every sprite is rebuilt as a flat rect, with no authored mesh or deformer.
// Opacity and z are rest-evaluated because scalar bindings legitimately select
// which exported layers make up the default artwork.

import {
  clampOrWrap,
  computeExcludedNodes,
  createRuntime,
  deterministicProduct,
  deterministicSum,
  evalBinding,
  assertRasterWorkWithinLimit,
  resolveEffectiveOpacity,
  resolveEffectiveZ,
  roundEffectiveZ,
  RUNTIME_LIMITS,
  type AnyNode,
  type DeformedGeometry,
  type DrawItem,
  type EvalFrame,
  type GroupNode,
  type MaskGroup,
  type Model,
  type SpriteNode,
} from "@refrain-lyre/core";
import { createSoftRenderer } from "@refrain-lyre/render-soft";
import { compareSurfaces, type SurfaceComparison } from "./conformance.js";
import type { LoadedContainer } from "./container.js";

interface RestScalarEffects {
  opacityFactor: number;
  zAdd: number;
}

/** §7 scalar contributions at the stage-6 default parameter values. */
function buildRestScalarEffects(
  model: Model,
  excluded: ReadonlySet<AnyNode>,
): ReadonlyMap<AnyNode, RestScalarEffects> {
  const pending = new Map<AnyNode, { opacityFactors: number[]; zAdds: number[] }>();
  for (const binding of model.bindings) {
    if (binding.property !== "opacity" && binding.property !== "z") continue;
    // §7 rule 7: a binding below an excluded default-variant root evaluates
    // to nothing. In particular, an otherwise overflowing scalar binding on
    // an inactive outfit must not make rest-reference validation fail.
    if (isUnder(excluded, binding.target)) continue;
    const value = evalBinding(
      binding,
      binding.params.map((param) => clampOrWrap(param, param.default)),
    )[0]!;
    const contributions = pending.get(binding.target) ?? { opacityFactors: [], zAdds: [] };
    if (binding.property === "opacity" && binding.kind === "factor") {
      contributions.opacityFactors.push(value);
    } else if (binding.property === "z" && binding.kind !== "factor") {
      contributions.zAdds.push(value);
    }
    pending.set(binding.target, contributions);
  }

  const effects = new Map<AnyNode, RestScalarEffects>();
  for (const [node, contributions] of pending) {
    const opacityFactor = deterministicProduct(contributions.opacityFactors);
    const zAdd = deterministicSum(contributions.zAdds);
    if (!Number.isFinite(opacityFactor) || !Number.isFinite(zAdd)) {
      throw new RangeError(`non-finite rest scalar binding result for node "${node.id}"`);
    }
    effects.set(node, { opacityFactor, zAdd });
  }
  return effects;
}

/** Rest effective opacity: per-node factor product clamped once, ancestor product (§6–§7). */
function restEffectiveOpacity(
  effects: ReadonlyMap<AnyNode, RestScalarEffects>,
  sprite: SpriteNode,
): number {
  const ownOpacity = Math.min(
    1,
    Math.max(0, sprite.opacity * (effects.get(sprite)?.opacityFactor ?? 1)),
  );
  const ancestors: GroupNode[] = [];
  for (let parent: AnyNode | null = sprite.parent; parent; parent = parent.parent) {
    if (parent.type === "group") ancestors.push(parent);
  }
  let ancestorOpacity = 1;
  // Match the runtime's root-to-parent traversal and final own × ancestors
  // grouping exactly; even identity-preserving products can straddle a byte
  // quantization boundary if evaluated in the opposite order.
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i]!;
    ancestorOpacity *= Math.min(
      1,
      Math.max(0, parent.opacity * (effects.get(parent)?.opacityFactor ?? 1)),
    );
  }
  return resolveEffectiveOpacity(ownOpacity, ancestorOpacity);
}

/** Rest effective z: authored z plus additive contributions up the chain (§8.1). */
function restEffectiveZ(
  effects: ReadonlyMap<AnyNode, RestScalarEffects>,
  sprite: SpriteNode,
): number {
  const ancestors: GroupNode[] = [];
  for (let parent: AnyNode | null = sprite.parent; parent; parent = parent.parent) {
    if (parent.type === "group") ancestors.push(parent);
  }
  let ancestorGroupZ = 0;
  // The runtime visits groups root-to-parent, then combines the sprite's rest
  // and own delta with that separately accumulated sum.
  for (let i = ancestors.length - 1; i >= 0; i--) {
    ancestorGroupZ += effects.get(ancestors[i]!)?.zAdd ?? 0;
  }
  return resolveEffectiveZ(sprite.z, effects.get(sprite)?.zAdd ?? 0, ancestorGroupZ);
}

function isUnder(roots: ReadonlySet<AnyNode>, node: AnyNode): boolean {
  for (let parent: AnyNode | null = node; parent; parent = parent.parent) {
    if (roots.has(parent)) return true;
  }
  return false;
}

/** A sprite's exported layer: a single flat rect independent of its authored mesh. */
function flatGeometry(model: Model, sprite: SpriteNode): DeformedGeometry {
  const [x, y, width, height] = sprite.rect;
  const [originX, originY] = model.canvas.origin;
  return {
    sprite,
    texture: sprite.texture,
    positions: new Float64Array([
      x + originX,
      y + originY,
      x + width + originX,
      y + originY,
      x + originX,
      y + height + originY,
      x + width + originX,
      y + height + originY,
    ]),
    uvs: new Float64Array([0, 0, 1, 0, 0, 1, 1, 1]),
    indices: new Uint32Array([0, 1, 3, 0, 3, 2]),
  };
}

/** Build the independent flat-layer frame consumed by the canonical rasterizer. */
function referenceFrame(model: Model): EvalFrame {
  const excluded = computeExcludedNodes(model, new Map());
  const effects = buildRestScalarEffects(model, excluded);
  const geometryBySprite = new Map<SpriteNode, DeformedGeometry>();
  const items: Array<{
    sprite: SpriteNode;
    geometry: DeformedGeometry;
    opacity: number;
    z: number;
  }> = [];

  for (const sprite of model.sprites) {
    if (isUnder(excluded, sprite)) continue;
    const geometry = flatGeometry(model, sprite);
    geometryBySprite.set(sprite, geometry);
    items.push({
      sprite,
      geometry,
      opacity: restEffectiveOpacity(effects, sprite),
      z: roundEffectiveZ(restEffectiveZ(effects, sprite)),
    });
  }
  items.sort(
    (left, right) => left.z - right.z || left.sprite.spriteOrder - right.sprite.spriteOrder,
  );

  const groupIndex = new Map<string, number>();
  const maskGroups: MaskGroup[] = [];
  const drawList: DrawItem[] = items.map(({ sprite, geometry, opacity, z }) => {
    let mask: DrawItem["mask"] = null;
    if (sprite.mask) {
      const activeSources = sprite.mask.sources
        .filter((source) => geometryBySprite.has(source))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const key = activeSources.map((source) => source.id).join(" ");
      let group = groupIndex.get(key);
      if (group === undefined) {
        group = maskGroups.length;
        groupIndex.set(key, group);
        maskGroups.push({ sources: activeSources.map((source) => geometryBySprite.get(source)!) });
      }
      mask = { mode: sprite.mask.mode, group };
    }
    return {
      ...geometry,
      opacity,
      blend: sprite.blend,
      effectiveZ: z,
      mask,
    };
  });

  return {
    canvas: { width: model.canvas.width, height: model.canvas.height },
    drawList,
    maskGroups,
  };
}

/** Translate a flat reference frame into one tile's local pixel coordinates. */
function referenceTile(
  frame: EvalFrame,
  x: number,
  y: number,
  width: number,
  height: number,
): EvalFrame {
  const shifted = new Map<DeformedGeometry, DeformedGeometry>();
  const shift = <T extends DeformedGeometry>(geometry: T): T => {
    const cached = shifted.get(geometry);
    if (cached) return cached as T;
    const positions = new Float64Array(geometry.positions.length);
    for (let i = 0; i < positions.length; i += 2) {
      positions[i] = geometry.positions[i]! - x;
      positions[i + 1] = geometry.positions[i + 1]! - y;
    }
    const result = { ...geometry, positions } as T;
    shifted.set(geometry, result);
    return result;
  };
  return {
    canvas: { width, height },
    drawList: frame.drawList.map((item) => shift(item)),
    maskGroups: frame.maskGroups.map((group) => ({ sources: group.sources.map(shift) })),
  };
}

function throwReferenceLimit(): never {
  throw new RangeError(
    `rest-pose reference exceeds ${RUNTIME_LIMITS.restPoseReferenceCandidateTests} raster candidate tests`,
  );
}

interface ReferenceTilePlan {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Exact, deterministic tile preflight. Split only a tile whose measured work
 * exceeds the ordinary frame ceiling, so small/off-canvas quads cannot force
 * needless subdivision through a whole-tile worst-case estimate.
 */
function referenceTilePlan(
  frame: EvalFrame,
  width: number,
  height: number,
  totalWork: number,
): ReferenceTilePlan[] {
  const plans: ReferenceTilePlan[] = [];
  let aggregateWork = 0;

  const visit = (plan: ReferenceTilePlan, work: number): void => {
    if (work <= RUNTIME_LIMITS.rasterSampleTestsPerFrame) {
      if (work > RUNTIME_LIMITS.restPoseReferenceCandidateTests - aggregateWork) {
        throwReferenceLimit();
      }
      aggregateWork += work;
      plans.push(plan);
      return;
    }

    if (plan.width === 1 && plan.height === 1) {
      throw new RangeError(
        `rest-pose reference cannot fit a tile within ${RUNTIME_LIMITS.rasterSampleTestsPerFrame} raster candidate tests`,
      );
    }

    const children: ReferenceTilePlan[] = [];
    if (plan.width >= plan.height && plan.width > 1) {
      const firstWidth = Math.floor(plan.width / 2);
      children.push(
        { ...plan, width: firstWidth },
        {
          x: plan.x + firstWidth,
          y: plan.y,
          width: plan.width - firstWidth,
          height: plan.height,
        },
      );
    } else {
      const firstHeight = Math.floor(plan.height / 2);
      children.push(
        { ...plan, height: firstHeight },
        {
          x: plan.x,
          y: plan.y + firstHeight,
          width: plan.width,
          height: plan.height - firstHeight,
        },
      );
    }

    for (const child of children) {
      const tile = referenceTile(frame, child.x, child.y, child.width, child.height);
      const childWork = assertRasterWorkWithinLimit(
        tile,
        child.width,
        child.height,
        RUNTIME_LIMITS.restPoseReferenceCandidateTests,
      );
      visit(child, childWork);
    }
  };

  visit({ x: 0, y: 0, width, height }, totalWork);
  return plans;
}

/** Flat exported-layer composite at defaults (§8.3/§8.4 semantics). */
export function referenceComposite(container: LoadedContainer): Uint8Array {
  const { model, textures } = container;
  const width = model.canvas.width;
  const height = model.canvas.height;
  const frame = referenceFrame(model);
  const totalWork = assertRasterWorkWithinLimit(
    frame,
    width,
    height,
    RUNTIME_LIMITS.restPoseReferenceCandidateTests,
  );

  if (totalWork <= RUNTIME_LIMITS.rasterSampleTestsPerFrame) {
    const renderer = createSoftRenderer(width, height);
    for (const [id, image] of textures) renderer.setTexture(id, image);
    renderer.render(frame);
    return renderer.readSurface();
  }

  // Complete the exact per-tile and aggregate preflight before allocating a
  // destination or rasterizing any part of the reference.
  const plans = referenceTilePlan(frame, width, height, totalWork);
  const renderer = createSoftRenderer(plans[0]!.width, plans[0]!.height);
  for (const [id, image] of textures) renderer.setTexture(id, image);
  const surface = new Uint8Array(width * height * 4);
  for (const plan of plans) {
    renderer.resize(plan.width, plan.height);
    renderer.render(referenceTile(frame, plan.x, plan.y, plan.width, plan.height));
    const tileSurface = renderer.readSurface();
    for (let tileY = 0; tileY < plan.height; tileY++) {
      const sourceOffset = tileY * plan.width * 4;
      const destinationOffset = ((plan.y + tileY) * width + plan.x) * 4;
      surface.set(
        tileSurface.subarray(sourceOffset, sourceOffset + plan.width * 4),
        destinationOffset,
      );
    }
  }
  return surface;
}

/** Render the rest pose through the real pipeline (runtime + soft renderer). */
export function restPoseRender(container: LoadedContainer): Uint8Array {
  const { model, textures } = container;
  const runtime = createRuntime(model);
  const renderer = createSoftRenderer(model.canvas.width, model.canvas.height);
  for (const [id, image] of textures) renderer.setTexture(id, image);
  renderer.render(runtime.evaluate());
  return renderer.readSurface();
}

export function checkRestPose(container: LoadedContainer): SurfaceComparison {
  // Reject an excessive authored frame before spending the validator-only
  // budget on its synthetic flat-layer reference.
  const actual = restPoseRender(container);
  return compareSurfaces(referenceComposite(container), actual, container.model.canvas.width);
}
