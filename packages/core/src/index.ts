// @refrain-lyre/core — dependency-free Lyre evaluation core.

export * from "./types/model.js";
export { LyreLoadError, type LoadErrorCode } from "./errors.js";
export { LIMITS, RUNTIME_LIMITS } from "./limits.js";
export { LYRE_REGISTRY, KNOWN_CAPABILITIES, type RegistryEntry } from "./registry.js";
export { clampOrWrap, posMod } from "./params.js";
export {
  propertyClass,
  isScalarProperty,
  isVec2Property,
  sampleAxis,
  evalBinding,
} from "./bindings.js";
export { loadModel, SUPPORTED_SPEC, type ModelFiles, type LoadOptions } from "./load.js";
export * from "./types/frame.js";
export { assertRasterWorkWithinLimit } from "./raster-work.js";
export { buildMesh, meshPointCount, type MeshData } from "./mesh.js";
export {
  applyRotator,
  applyWarp,
  warpRestPoints,
  type RotatorState,
  type WarpState,
} from "./deform.js";
export { computeExcludedNodes } from "./variants.js";
export { premultiplyStraightRGBA8 } from "./pm.js";
export { hitTestGeometry } from "./hittest.js";
export {
  createRuntime,
  LyreRuntime,
  resolveEffectiveOpacity,
  resolveEffectiveZ,
  roundEffectiveZ,
  type SlotInfo,
} from "./runtime.js";
export { applyExpressionEntry } from "./expressions.js";
export { cubicBezierEase, sampleTrack, motionLocalTime } from "./motions.js";
export { PhysicsEngine, fixedStepCount, normalizedInput, restDirection } from "./physics.js";
export { deterministicSum, deterministicProduct } from "./accumulate.js";
export { parseLyreJson } from "./json.js";
