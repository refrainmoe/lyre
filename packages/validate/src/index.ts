// @refrain-lyre/validate — validator library surface.

export {
  loadContainer,
  loadContainerDir,
  loadContainerFromSource,
  dirFileSource,
  zipFileSource,
  readRawDocs,
  decodePngFile,
  decodePngBuffer,
  checkContainerPath,
  type LoadedContainer,
  type FileSource,
} from "./container.js";
export {
  runTimeline,
  readTimeline,
  runTimelineSteps,
  CONFORMANCE_TIMELINE_LIMITS,
  type Timeline,
  type TimelineEvent,
  type StepResult,
  type StepOptions,
  type RunResult,
  type RunOptions,
  type ReadTimelineOptions,
} from "./timeline.js";
export {
  runConformance,
  compareSurfaces,
  encodeSurfacePng,
  decodeSurfacePng,
  maxTraceDeviation,
  CHANNEL_TOLERANCE,
  CATASTROPHIC_CHANNEL_TOLERANCE,
  CATASTROPHIC_REGION_PIXEL_LIMIT,
  PIXEL_PASS_RATIO,
  TRACE_TOLERANCE,
  ADMISSION_PERTURBATION,
  ADMISSION_MARGIN,
  type ConformanceReport,
  type ConformanceIssue,
  type SurfaceComparison,
} from "./conformance.js";
export { validateModelPath } from "./validate.js";
export { validateSchemas } from "./schema.js";
export { lintModel } from "./lints.js";
export { checkRestPose, referenceComposite, restPoseRender } from "./restpose.js";
export { computeStats, mergeStats, statsMarkdown, type ModelStats } from "./stats.js";
export type { ValidationIssue, ValidationReport } from "./report.js";
