import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PNG } from "pngjs";
import {
  computeExcludedNodes,
  fixedStepCount,
  LIMITS,
  parseLyreJson,
  type AnyNode,
  type Model,
  type PhysicsChain,
  type SurfaceRenderer,
} from "@refrain-lyre/core";
import { CONFORMANCE_TIMELINE_LIMITS, runTimeline, readTimeline } from "./timeline.js";
import {
  decodePngBufferStraight,
  inspectPngBuffer,
  loadContainerDir,
  type LoadedContainer,
} from "./container.js";
import { runTimelineSteps, type StepResult, type Timeline } from "./steps.js";

/** §12 render tolerance: per-channel ±2/255 on ≥ 99.9% of pixels. */
export const CHANNEL_TOLERANCE = 2;
export const PIXEL_PASS_RATIO = 0.999;
/** Pixels above this error participate in the connected-region guard. */
export const CATASTROPHIC_CHANNEL_TOLERANCE = 16;
/** Isolated raster-edge outliers are tolerated; a feature-sized 3×3 region is not. */
export const CATASTROPHIC_REGION_PIXEL_LIMIT = 8;
/** §9 physics trace tolerance, degrees per link per step. */
export const TRACE_TOLERANCE = 0.1;
/** §12 admission: 1e-9 px perturbation must stay within 10% of tolerance. */
export const ADMISSION_PERTURBATION = 1e-9;
export const ADMISSION_MARGIN = TRACE_TOLERANCE * 0.1;

const EMPTY_SURFACE = new Uint8Array();
const TRACE_ONLY_RENDERER: SurfaceRenderer = {
  setTexture() {},
  render() {},
  readSurface: () => EMPTY_SURFACE,
};

/** Run the admission perturbation without allocating a render target or retaining captures. */
export function runAdmissionPerturbation(
  model: Model,
  timeline: Timeline,
  renderer: SurfaceRenderer = TRACE_ONLY_RENDERER,
): StepResult {
  return runTimelineSteps(
    model,
    renderer,
    { ...timeline, captures: [] },
    { perturb: ADMISSION_PERTURBATION },
  );
}

export interface SurfaceComparison {
  pass: boolean;
  maxChannelDiff: number;
  outOfTolerancePixels: number;
  catastrophicPixels: number;
  largestCatastrophicRegion: number;
  totalPixels: number;
}

/** Largest 8-connected catastrophic component, capped at limit + 1. */
function largestCatastrophicRegion(mask: Uint8Array, width: number): number {
  let largest = 0;
  const height = mask.length / width;
  const queue = new Int32Array(CATASTROPHIC_REGION_PIXEL_LIMIT + 1);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0) continue;
    let head = 0;
    let tail = 1;
    let count = 0;
    queue[0] = start;
    mask[start] = 0;
    while (head < tail) {
      const pixel = queue[head++]!;
      count++;
      if (count > CATASTROPHIC_REGION_PIXEL_LIMIT) return count;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] === 0) continue;
          mask[neighbor] = 0;
          queue[tail++] = neighbor;
          if (tail > CATASTROPHIC_REGION_PIXEL_LIMIT) {
            return CATASTROPHIC_REGION_PIXEL_LIMIT + 1;
          }
        }
      }
    }
    if (count > largest) largest = count;
  }
  return largest;
}

export function compareSurfaces(a: Uint8Array, b: Uint8Array, width: number): SurfaceComparison {
  if (a.length !== b.length) {
    return {
      pass: false,
      maxChannelDiff: 255,
      outOfTolerancePixels: -1,
      catastrophicPixels: -1,
      largestCatastrophicRegion: -1,
      totalPixels: -1,
    };
  }
  const totalPixels = a.length / 4;
  if (!Number.isSafeInteger(width) || width < 1 || totalPixels % width !== 0) {
    throw new RangeError(`surface width ${String(width)} does not divide ${totalPixels} pixels`);
  }
  let maxDiff = 0;
  let badPixels = 0;
  let catastrophicPixels = 0;
  const catastrophicMask = new Uint8Array(totalPixels);
  for (let o = 0; o < a.length; o += 4) {
    let pixelBad = false;
    let pixelCatastrophic = false;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[o + c]! - b[o + c]!);
      if (d > maxDiff) maxDiff = d;
      if (d > CHANNEL_TOLERANCE) pixelBad = true;
      if (d > CATASTROPHIC_CHANNEL_TOLERANCE) pixelCatastrophic = true;
    }
    if (pixelBad) badPixels++;
    if (pixelCatastrophic) {
      catastrophicPixels++;
      catastrophicMask[o / 4] = 1;
    }
  }
  const largestRegion = largestCatastrophicRegion(catastrophicMask, width);
  return {
    pass:
      badPixels / totalPixels <= 1 - PIXEL_PASS_RATIO &&
      largestRegion <= CATASTROPHIC_REGION_PIXEL_LIMIT,
    maxChannelDiff: maxDiff,
    outOfTolerancePixels: badPixels,
    catastrophicPixels,
    largestCatastrophicRegion: largestRegion,
    totalPixels,
  };
}

/** Captures are stored as PNGs whose bytes ARE the premultiplied surface dump. */
export function encodeSurfacePng(width: number, height: number, surface: Uint8Array): Uint8Array {
  requireSurfaceShape(width, height, surface.byteLength, "surface");
  const png = new PNG({ width, height });
  Buffer.from(surface).copy(png.data);
  return PNG.sync.write(png, { deflateLevel: 9, filterType: 0 });
}

export function decodeSurfacePng(bytes: Uint8Array): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const info = inspectPngBuffer(bytes, "golden capture");
  requireSurfaceShape(info.width, info.height, info.width * info.height * 4, "golden capture");
  return decodePngBufferStraight(bytes, "golden capture");
}

function requireSurfaceShape(
  width: number,
  height: number,
  byteLength: number,
  label: string,
): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.canvasDimension ||
    height > LIMITS.canvasDimension ||
    width * height > LIMITS.canvasPixels
  ) {
    throw new RangeError(
      `${label} dimensions must fit ${LIMITS.canvasDimension}px per axis and ${LIMITS.canvasPixels} total pixels`,
    );
  }
  const expected = width * height * 4;
  if (byteLength !== expected) {
    throw new RangeError(`${label} has ${byteLength} RGBA8 bytes; expected ${expected}`);
  }
}

export interface ConformanceIssue {
  timeline: string;
  message: string;
}

export interface ConformanceReport {
  ran: string[];
  issues: ConformanceIssue[];
}

interface TraceFile {
  /** Internal physics solver rate; trace samples are indexed by solver step. */
  fps: number;
  chains: Record<string, number[][]>;
}

const PHYSICS_TRACE_SECONDS = 10;

function expectedPhysicsTraceSteps(fps: number): number {
  return fixedStepCount(PHYSICS_TRACE_SECONDS, 1 / fps);
}

function isExcluded(excludedRoots: ReadonlySet<AnyNode>, node: AnyNode): boolean {
  for (let current: AnyNode | null = node; current; current = current.parent) {
    if (excludedRoots.has(current)) return true;
  }
  return false;
}

function chainIsSkippable(
  model: Model,
  chain: PhysicsChain,
  activeOptions: ReadonlyMap<string, string>,
): boolean {
  const outputParams = new Set(chain.outputs.map((output) => output.param));
  if (outputParams.size === 0) return true;
  const excluded = computeExcludedNodes(model, activeOptions);
  return model.bindings.every(
    (binding) =>
      !binding.params.some((param) => outputParams.has(param.id)) ||
      isExcluded(excluded, binding.target),
  );
}

/** Validate selective traces against §10.3 rule 5 for every scripted variant state. */
function traceChainSelectionProblem(model: Model, timeline: Timeline): string | null {
  const physics = model.physics;
  if (!physics || timeline.trace_chains === undefined) return null;
  if (!Array.isArray(timeline.trace_chains) || timeline.trace_chains.length === 0) {
    return `trace_chains must contain at least one physics chain id`;
  }
  if (timeline.trace_chains.some((id) => typeof id !== "string" || id.length === 0)) {
    return `trace_chains must contain non-empty string ids`;
  }
  const selected = new Set(timeline.trace_chains);
  if (selected.size !== timeline.trace_chains.length) {
    return `trace_chains must not contain duplicate ids`;
  }
  const known = new Set(physics.chains.map((chain) => chain.id));
  const unknown = timeline.trace_chains.find((id) => !known.has(id));
  if (unknown !== undefined) return `trace_chains references unknown physics chain "${unknown}"`;

  const omitted = physics.chains.filter((chain) => !selected.has(chain.id));
  if (omitted.length === 0) return null;

  const active = new Map<string, string>();
  const problemAtState = (description: string): string | null => {
    const chain = omitted.find((candidate) => !chainIsSkippable(model, candidate, active));
    return chain
      ? `trace_chains omits non-skippable physics chain "${chain.id}" ${description}`
      : null;
  };

  const variantEvents = (timeline.events ?? [])
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.variant !== undefined &&
        Number.isInteger(event.step) &&
        event.step >= 0 &&
        event.step < timeline.steps,
    )
    .sort((left, right) => left.event.step - right.event.step || left.index - right.index);

  if (variantEvents.length === 0 || variantEvents[0]!.event.step > 0) {
    const problem = problemAtState(`in the default variant state`);
    if (problem) return problem;
  }

  for (let offset = 0; offset < variantEvents.length;) {
    const step = variantEvents[offset]!.event.step;
    let end = offset;
    while (end < variantEvents.length && variantEvents[end]!.event.step === step) {
      const selection = variantEvents[end]!.event.variant!;
      const slot = model.variantSlots.find((candidate) => candidate.id === selection.slot);
      if (!slot) return `variant event at step ${step} references unknown slot "${selection.slot}"`;
      if (!slot.options.some((option) => option.id === selection.option)) {
        return `variant event at step ${step} references unknown option "${selection.option}" for slot "${selection.slot}"`;
      }
      active.set(selection.slot, selection.option);
      end++;
    }
    const problem = problemAtState(`at scripted variant step ${step}`);
    if (problem) return problem;
    offset = end;
  }
  return null;
}

const CORPUS_ISSUE = "<corpus>";

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface AnchoredDirectory {
  fd: number;
  anchor: string;
  identity: DirectoryIdentity;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one untrusted golden without following its final symlink or trusting a stale size. */
function readStableRegularFile(path: string, maxBytes: number, label: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`${label} is not a regular file`);
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    }
    const expectedSize = Number(before.size);
    const bytes = Buffer.allocUnsafe(expectedSize);
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
      throw new Error(`${label} changed while being read`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function strictChildPath(parent: string, name: string, label: string): string {
  if (name.length === 0 || name === "." || name === ".." || basename(name) !== name) {
    throw new Error(`${label} ${JSON.stringify(name)} is not a safe path component`);
  }
  const child = resolve(parent, name);
  const fromParent = relative(parent, child);
  if (
    fromParent.length === 0 ||
    fromParent === ".." ||
    fromParent.startsWith(`..${sep}`) ||
    isAbsolute(fromParent)
  ) {
    throw new Error(`${label} ${JSON.stringify(name)} escapes ${parent}`);
  }
  return child;
}

function directoryIdentity(stats: Stats): DirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectCanonicalDirectory(path: string, label: string): DirectoryIdentity {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`);
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
  const canonical = realpathSync(path);
  if (resolve(canonical) !== resolve(path)) {
    throw new Error(`${label} resolves outside its canonical location: ${path} -> ${canonical}`);
  }
  return directoryIdentity(stats);
}

function assertDirectoryIdentity(path: string, expected: DirectoryIdentity, label: string): void {
  const actual = inspectCanonicalDirectory(path, label);
  if (!sameDirectoryIdentity(actual, expected)) {
    throw new Error(`${label} changed while regenerating goldens: ${path}`);
  }
}

const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function descriptorAnchor(fd: number, expected: DirectoryIdentity, label: string): string {
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = join(root, String(fd));
    try {
      const stats = statSync(candidate);
      if (stats.isDirectory() && sameDirectoryIdentity(directoryIdentity(stats), expected)) {
        return candidate;
      }
    } catch {
      // Try the next platform descriptor filesystem.
    }
  }
  throw new Error(
    `${label} cannot be securely anchored through /proc/self/fd or /dev/fd; refusing regeneration`,
  );
}

function openAnchoredDirectory(
  path: string,
  label: string,
  expected?: DirectoryIdentity,
): AnchoredDirectory {
  const fd = openSync(path, DIRECTORY_OPEN_FLAGS);
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
    const identity = directoryIdentity(stats);
    if (expected && !sameDirectoryIdentity(identity, expected)) {
      throw new Error(`${label} changed while it was being opened: ${path}`);
    }
    return { fd, anchor: descriptorAnchor(fd, identity, label), identity };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertAnchoredDirectory(directory: AnchoredDirectory, label: string): void {
  const descriptorStats = fstatSync(directory.fd);
  if (
    !descriptorStats.isDirectory() ||
    !sameDirectoryIdentity(directoryIdentity(descriptorStats), directory.identity)
  ) {
    throw new Error(`${label} descriptor changed while regenerating goldens`);
  }
  const anchorStats = statSync(directory.anchor);
  if (
    !anchorStats.isDirectory() ||
    !sameDirectoryIdentity(directoryIdentity(anchorStats), directory.identity)
  ) {
    throw new Error(`${label} descriptor anchor changed while regenerating goldens`);
  }
}

/**
 * Guard every regeneration mutation with canonical containment and open
 * directory descriptors. Mutating through the descriptor filesystem keeps the
 * operation rooted in the directory that was checked even if an attacker swaps
 * its ordinary pathname for a symlink during rmSync/mkdirSync/writeFileSync.
 */
class GoldenMutationGuard {
  private closed = false;

  private constructor(
    readonly corpusDir: string,
    readonly goldensDir: string,
    private readonly corpus: AnchoredDirectory,
    private readonly goldens: AnchoredDirectory,
  ) {}

  /** Takes ownership of an already-open corpus descriptor, even on failure. */
  static create(corpusDir: string, corpus: AnchoredDirectory): GoldenMutationGuard {
    const goldensDir = strictChildPath(corpusDir, "goldens", "goldens directory");
    let goldens: AnchoredDirectory | undefined;
    try {
      assertAnchoredDirectory(corpus, "corpus directory");
      assertDirectoryIdentity(corpusDir, corpus.identity, "corpus directory");
      const anchoredGoldensPath = strictChildPath(corpus.anchor, "goldens", "goldens directory");

      let stats: Stats;
      try {
        stats = lstatSync(anchoredGoldensPath);
      } catch (error) {
        if (!isMissingPath(error)) throw error;
        assertAnchoredDirectory(corpus, "corpus directory");
        assertDirectoryIdentity(corpusDir, corpus.identity, "corpus directory");
        mkdirSync(anchoredGoldensPath);
        assertAnchoredDirectory(corpus, "corpus directory");
        assertDirectoryIdentity(corpusDir, corpus.identity, "corpus directory");
        stats = lstatSync(anchoredGoldensPath);
      }

      if (stats.isSymbolicLink()) {
        throw new Error(`goldens directory must not be a symbolic link: ${goldensDir}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`goldens path must be a directory: ${goldensDir}`);
      }
      const goldensIdentity = directoryIdentity(stats);
      goldens = openAnchoredDirectory(anchoredGoldensPath, "goldens directory", goldensIdentity);
      assertDirectoryIdentity(goldensDir, goldens.identity, "goldens directory");
      assertDirectoryIdentity(corpusDir, corpus.identity, "corpus directory");
      return new GoldenMutationGuard(corpusDir, goldensDir, corpus, goldens);
    } catch (error) {
      if (goldens) {
        try {
          closeSync(goldens.fd);
        } catch {
          // Preserve the setup failure while still attempting every close.
        }
      }
      try {
        closeSync(corpus.fd);
      } catch {
        // Preserve the setup failure.
      }
      throw error;
    }
  }

  private assertStable(): void {
    if (this.closed) throw new Error(`golden mutation guard is already closed`);
    assertAnchoredDirectory(this.corpus, "corpus directory");
    assertAnchoredDirectory(this.goldens, "goldens directory");
    assertDirectoryIdentity(this.corpusDir, this.corpus.identity, "corpus directory");
    assertDirectoryIdentity(this.goldensDir, this.goldens.identity, "goldens directory");
  }

  private entryPath(name: string): string {
    return strictChildPath(this.goldens.anchor, name, "golden entry");
  }

  entries(): string[] {
    this.assertStable();
    const entries = readdirSync(this.goldens.anchor);
    this.assertStable();
    return entries;
  }

  removeEntry(name: string): void {
    const path = this.entryPath(name);
    this.assertStable();
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
    this.assertStable();

    // A symlink in the final component is unlinked as an object; it is never
    // resolved. Real directories must themselves resolve beneath goldens.
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      const canonicalGoldens = realpathSync(this.goldens.anchor);
      const canonical = realpathSync(path);
      const fromGoldens = relative(canonicalGoldens, canonical);
      if (
        fromGoldens.length === 0 ||
        fromGoldens === ".." ||
        fromGoldens.startsWith(`..${sep}`) ||
        isAbsolute(fromGoldens)
      ) {
        throw new Error(`golden entry resolves outside goldens: ${path} -> ${canonical}`);
      }
      this.assertStable();
      rmSync(path, { recursive: true, force: true });
    } else {
      this.assertStable();
      rmSync(path, { force: true });
    }
    this.assertStable();
  }

  removeTimeline(id: string): void {
    this.removeEntry(id);
  }

  recreateTimeline(id: string): AnchoredDirectory {
    const path = this.entryPath(id);
    this.removeEntry(id);
    this.assertStable();
    mkdirSync(path);
    this.assertStable();
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`golden directory for ${JSON.stringify(id)} was replaced during creation`);
    }
    return openAnchoredDirectory(
      path,
      `golden directory for ${JSON.stringify(id)}`,
      directoryIdentity(stats),
    );
  }

  writeTimelineFile(
    id: string,
    timeline: AnchoredDirectory,
    name: string,
    data: Uint8Array | string,
  ): void {
    const path = strictChildPath(timeline.anchor, name, "golden file");
    this.assertStable();
    assertAnchoredDirectory(timeline, `golden directory for ${JSON.stringify(id)}`);
    const current = lstatSync(this.entryPath(id));
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameDirectoryIdentity(directoryIdentity(current), timeline.identity)
    ) {
      throw new Error(`golden directory for ${JSON.stringify(id)} changed during regeneration`);
    }
    // Exclusive creation refuses a concurrently planted final-component
    // symlink instead of following or truncating it.
    writeFileSync(path, data, { flag: "wx" });
    this.assertStable();
    assertAnchoredDirectory(timeline, `golden directory for ${JSON.stringify(id)}`);
    const after = lstatSync(this.entryPath(id));
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameDirectoryIdentity(directoryIdentity(after), timeline.identity)
    ) {
      throw new Error(`golden directory for ${JSON.stringify(id)} changed during regeneration`);
    }
  }

  closeTimeline(timeline: AnchoredDirectory): void {
    closeSync(timeline.fd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let firstError: unknown;
    try {
      closeSync(this.goldens.fd);
    } catch (error) {
      firstError = error;
    }
    try {
      closeSync(this.corpus.fd);
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }
}

/**
 * Run (or regenerate) the conformance suite of a corpus directory laid out as
 * `timelines/*.timeline.json`, `models/*.lyre/`, `goldens/<timeline-id>/`.
 */
export function runConformance(
  corpusDir: string,
  opts: { regen?: boolean; filter?: string } = {},
): ConformanceReport {
  const report: ConformanceReport = { ran: [], issues: [] };
  const corpusIssue = (message: string) => report.issues.push({ timeline: CORPUS_ISSUE, message });

  let canonicalCorpusDir: string;
  let initialCorpusIdentity: DirectoryIdentity;
  try {
    canonicalCorpusDir = realpathSync(corpusDir);
    initialCorpusIdentity = inspectCanonicalDirectory(canonicalCorpusDir, "corpus directory");
  } catch (error) {
    corpusIssue(`could not open conformance corpus: ${errorDetail(error)}`);
    return report;
  }
  let pinnedCorpus: AnchoredDirectory | undefined;
  let pinnedTimelines: AnchoredDirectory | undefined;
  const releasePinnedDiscovery = () => {
    let firstError: unknown;
    if (pinnedTimelines) {
      try {
        closeSync(pinnedTimelines.fd);
      } catch (error) {
        firstError = error;
      }
      pinnedTimelines = undefined;
    }
    if (pinnedCorpus) {
      try {
        closeSync(pinnedCorpus.fd);
      } catch (error) {
        firstError ??= error;
      }
      pinnedCorpus = undefined;
    }
    if (firstError) throw firstError;
  };
  const logicalTimelinesDir = join(canonicalCorpusDir, "timelines");
  if (opts.regen) {
    try {
      pinnedCorpus = openAnchoredDirectory(
        canonicalCorpusDir,
        "corpus directory",
        initialCorpusIdentity,
      );
      pinnedTimelines = openAnchoredDirectory(
        strictChildPath(pinnedCorpus.anchor, "timelines", "timelines directory"),
        "timelines directory",
      );
      assertDirectoryIdentity(logicalTimelinesDir, pinnedTimelines.identity, "timelines directory");
    } catch (error) {
      corpusIssue(`refusing unsafe golden regeneration: ${errorDetail(error)}`);
      releasePinnedDiscovery();
      return report;
    }
  }
  const timelinesDir = pinnedTimelines?.anchor ?? logicalTimelinesDir;
  const timelineModelBaseDir = join(pinnedCorpus?.anchor ?? canonicalCorpusDir, "timelines");
  const goldensDir = join(canonicalCorpusDir, "goldens");

  let allFiles: string[];
  try {
    allFiles = readdirSync(timelinesDir)
      .filter((f) => f.endsWith(".timeline.json"))
      .sort();
    if (pinnedCorpus) {
      assertAnchoredDirectory(pinnedCorpus, "corpus directory");
      assertDirectoryIdentity(canonicalCorpusDir, pinnedCorpus.identity, "corpus directory");
    }
    if (pinnedTimelines) {
      assertAnchoredDirectory(pinnedTimelines, "timelines directory");
      assertDirectoryIdentity(logicalTimelinesDir, pinnedTimelines.identity, "timelines directory");
    }
  } catch (error) {
    corpusIssue(`could not read timelines directory: ${errorDetail(error)}`);
    releasePinnedDiscovery();
    return report;
  }
  if (allFiles.length === 0) {
    corpusIssue(`conformance corpus contains no *.timeline.json files`);
    releasePinnedDiscovery();
    return report;
  }

  const files = allFiles.filter((f) => opts.filter === undefined || f.includes(opts.filter));
  if (opts.filter !== undefined && files.length === 0) {
    corpusIssue(`filter ${JSON.stringify(opts.filter)} matched no timeline files`);
    releasePinnedDiscovery();
    return report;
  }

  const idsByFile = new Map<string, string>();
  try {
    for (const file of allFiles) {
      const id = basename(file, ".timeline.json");
      strictChildPath(goldensDir, id, "timeline id");
      idsByFile.set(file, id);
    }
  } catch (error) {
    corpusIssue(`invalid conformance timeline filename: ${errorDetail(error)}`);
    releasePinnedDiscovery();
    return report;
  }

  let goldenGuard: GoldenMutationGuard | undefined;
  let mutationFailed = false;
  if (opts.regen) {
    const corpusForGuard = pinnedCorpus!;
    pinnedCorpus = undefined;
    try {
      goldenGuard = GoldenMutationGuard.create(canonicalCorpusDir, corpusForGuard);
    } catch (error) {
      corpusIssue(`refusing unsafe golden regeneration: ${errorDetail(error)}`);
      releasePinnedDiscovery();
      return report;
    }
  }

  try {
    if (pinnedTimelines) {
      try {
        assertAnchoredDirectory(pinnedTimelines, "timelines directory");
        assertDirectoryIdentity(
          logicalTimelinesDir,
          pinnedTimelines.identity,
          "timelines directory",
        );
      } catch (error) {
        corpusIssue(`refusing changed conformance corpus: ${errorDetail(error)}`);
        return report;
      }
    }

    // A full regeneration is a mirror operation, not an append operation:
    // timeline removals/renames must remove their stale golden directories.
    // Filtered regeneration deliberately leaves unrelated goldens untouched.
    if (goldenGuard && opts.filter === undefined) {
      const liveIds = new Set(idsByFile.values());
      try {
        for (const entry of goldenGuard.entries()) {
          if (!liveIds.has(entry)) goldenGuard.removeEntry(entry);
        }
      } catch (error) {
        corpusIssue(`could not safely clean stale goldens: ${errorDetail(error)}`);
        return report;
      }
    }

    for (const file of files) {
      if (mutationFailed) break;
      const id = idsByFile.get(file)!;
      const path = join(timelinesDir, file);
      const goldenDir = join(goldensDir, id);
      report.ran.push(id);
      const issue = (message: string) => report.issues.push({ timeline: id, message });
      const cleanupGolden = () => {
        if (!goldenGuard) return;
        try {
          goldenGuard.removeTimeline(id);
        } catch (error) {
          mutationFailed = true;
          issue(`could not safely clean golden directory: ${errorDetail(error)}`);
        }
      };

      let container: LoadedContainer | undefined;
      try {
        const { timeline, modelDir } = readTimeline(path, {
          modelBaseDir: timelineModelBaseDir,
        });
        container = loadContainerDir(modelDir);
        const retainedCaptureBytes =
          (timeline.captures?.length ?? 0) *
          container.model.canvas.width *
          container.model.canvas.height *
          4;
        if (retainedCaptureBytes > CONFORMANCE_TIMELINE_LIMITS.retainedCaptureBytes) {
          issue(
            `captures would retain ${retainedCaptureBytes} surface bytes (fixture limit ${CONFORMANCE_TIMELINE_LIMITS.retainedCaptureBytes})`,
          );
          cleanupGolden();
          continue;
        }

        if (timeline.physics_trace) {
          if (!container.model.physics) {
            issue(`physics_trace requires a model with physics`);
            cleanupGolden();
            continue;
          }
          const duration = timeline.steps / timeline.fps;
          if (
            !Number.isInteger(timeline.steps) ||
            timeline.steps < 1 ||
            !Number.isFinite(timeline.fps) ||
            timeline.fps <= 0 ||
            !Number.isFinite(duration) ||
            Math.abs(duration - PHYSICS_TRACE_SECONDS) > 1e-9
          ) {
            issue(
              `physics trace must cover exactly ${PHYSICS_TRACE_SECONDS} simulated seconds; timeline covers ${String(duration)} s`,
            );
            cleanupGolden();
            continue;
          }
          const selectionProblem = traceChainSelectionProblem(container.model, timeline);
          if (selectionProblem) {
            issue(selectionProblem);
            cleanupGolden();
            continue;
          }
          const selectedChains = new Set(
            timeline.trace_chains ?? container.model.physics.chains.map((chain) => chain.id),
          );
          const linksPerSample = container.model.physics.chains
            .filter((chain) => selectedChains.has(chain.id))
            .reduce((total, chain) => total + chain.links.length, 0);
          const retainedTraceScalars =
            2 * expectedPhysicsTraceSteps(container.model.physics.fps) * linksPerSample;
          if (retainedTraceScalars > CONFORMANCE_TIMELINE_LIMITS.retainedTraceScalars) {
            issue(
              `baseline and perturbation traces would retain ${retainedTraceScalars} angle scalars (fixture limit ${CONFORMANCE_TIMELINE_LIMITS.retainedTraceScalars})`,
            );
            cleanupGolden();
            continue;
          }
        }

        const result = runTimeline(path, { container });

        if (result.trace && container.model.physics) {
          const expectedSteps = expectedPhysicsTraceSteps(container.model.physics.fps);
          const badChain = Object.entries(result.trace).find(
            ([, samples]) => samples.length !== expectedSteps,
          );
          if (badChain) {
            issue(
              `physics trace for chain "${badChain[0]}" has ${badChain[1].length} internal-step samples; expected ${expectedSteps} over ${PHYSICS_TRACE_SECONDS} s at ${container.model.physics.fps} fps`,
            );
            cleanupGolden();
            continue;
          }
        }

        // §12 admission criterion for physics scenarios (both modes: a corpus
        // whose scenarios stopped being stable must fail loudly, not silently).
        if (result.trace) {
          const perturbed = runAdmissionPerturbation(container.model, timeline);
          const dev = maxTraceDeviation(result.trace, perturbed.trace!);
          if (dev > ADMISSION_MARGIN) {
            issue(
              `physics scenario is not perturbation-stable: 1e-9 px displacement drifts ${dev.toFixed(6)}° (> ${ADMISSION_MARGIN}°); chaotic configurations are excluded by construction (§12)`,
            );
            cleanupGolden();
            continue;
          }
        }

        if (goldenGuard) {
          const timelineDirectory = goldenGuard.recreateTimeline(id);
          try {
            for (const [step, surface] of result.captures) {
              goldenGuard.writeTimelineFile(
                id,
                timelineDirectory,
                `${step}.png`,
                encodeSurfacePng(result.width, result.height, surface),
              );
            }
            if (result.trace) {
              const traceFile: TraceFile = {
                fps: container.model.physics!.fps,
                chains: result.trace,
              };
              goldenGuard.writeTimelineFile(
                id,
                timelineDirectory,
                "trace.json",
                JSON.stringify(traceFile) + "\n",
              );
            }
          } finally {
            goldenGuard.closeTimeline(timelineDirectory);
          }
          continue;
        }

        // Compare against committed goldens.
        for (const [step, surface] of result.captures) {
          const goldenPath = join(goldenDir, `${step}.png`);
          if (!existsSync(goldenPath)) {
            issue(`missing golden ${id}/${step}.png (run with --regen?)`);
            continue;
          }
          const golden = decodeSurfacePng(
            readStableRegularFile(goldenPath, LIMITS.textureFileBytes, `golden ${id}/${step}.png`),
          );
          if (golden.width !== result.width || golden.height !== result.height) {
            issue(
              `capture ${step}: golden dimensions ${golden.width}×${golden.height} do not match model canvas ${result.width}×${result.height}`,
            );
            continue;
          }
          const cmp = compareSurfaces(golden.data, surface, result.width);
          if (!cmp.pass) {
            issue(
              `capture ${step}: ${cmp.outOfTolerancePixels}/${cmp.totalPixels} pixels out of ±${CHANNEL_TOLERANCE}/255; ${cmp.catastrophicPixels} pixels exceed ±${CATASTROPHIC_CHANNEL_TOLERANCE}/255, largest 8-connected region ${cmp.largestCatastrophicRegion}/${CATASTROPHIC_REGION_PIXEL_LIMIT} pixels (max channel diff ${cmp.maxChannelDiff})`,
            );
          }
        }
        if (result.trace) {
          const goldenTracePath = join(goldenDir, "trace.json");
          if (!existsSync(goldenTracePath)) {
            issue(`missing golden trace (run with --regen?)`);
          } else {
            const bytes = readStableRegularFile(
              goldenTracePath,
              LIMITS.jsonFileBytes,
              `golden trace ${id}/trace.json`,
            );
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch {
              throw new Error(`golden trace ${id}/trace.json is not valid UTF-8 JSON`);
            }
            const golden = parseLyreJson(text, `golden trace ${id}/trace.json`) as TraceFile;
            const physicsFps = container.model.physics!.fps;
            if (!Number.isFinite(golden.fps) || golden.fps !== physicsFps) {
              issue(
                `physics trace fps ${String(golden.fps)} does not match model physics fps ${physicsFps}`,
              );
            }
            const dev = maxTraceDeviation(golden.chains, result.trace);
            if (dev > TRACE_TOLERANCE) {
              issue(
                `physics trace deviates ${dev.toFixed(6)}° (> ±${TRACE_TOLERANCE}°) from golden`,
              );
            }
          }
        }
      } catch (error) {
        issue(`could not run timeline: ${errorDetail(error)}`);
        cleanupGolden();
      } finally {
        container?.source.close();
      }
    }
  } finally {
    let firstError: unknown;
    if (pinnedTimelines) {
      try {
        closeSync(pinnedTimelines.fd);
      } catch (error) {
        firstError = error;
      }
      pinnedTimelines = undefined;
    }
    if (goldenGuard) {
      try {
        goldenGuard.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) {
      corpusIssue(`could not close conformance directory descriptors: ${errorDetail(firstError)}`);
    }
  }
  return report;
}

export function maxTraceDeviation(
  a: Record<string, number[][]>,
  b: Record<string, number[][]>,
): number {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return Infinity;
  }
  const aIds = Object.keys(a);
  const bIds = Object.keys(b);
  if (aIds.length !== bIds.length) return Infinity;

  let max = 0;
  for (const id of aIds) {
    if (!Object.prototype.hasOwnProperty.call(b, id)) return Infinity;
    const ca = a[id]!;
    const cb = b[id];
    if (!Array.isArray(ca) || !Array.isArray(cb) || cb.length !== ca.length) return Infinity;
    for (let s = 0; s < ca.length; s++) {
      const la = ca[s]!;
      const lb = cb[s]!;
      if (!Array.isArray(la) || !Array.isArray(lb) || la.length !== lb.length) return Infinity;
      for (let i = 0; i < la.length; i++) {
        const av = la[i];
        const bv = lb[i];
        if (
          typeof av !== "number" ||
          !Number.isFinite(av) ||
          typeof bv !== "number" ||
          !Number.isFinite(bv)
        ) {
          return Infinity;
        }
        const d = Math.abs(av - bv);
        if (d > max) max = d;
      }
    }
  }
  return max;
}
