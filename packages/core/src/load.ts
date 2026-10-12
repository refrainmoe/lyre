import { LyreLoadError } from "./errors.js";
import { LIMITS, RUNTIME_LIMITS } from "./limits.js";
import { KNOWN_CAPABILITIES, LYRE_REGISTRY } from "./registry.js";
import { propertyClass, isScalarProperty, isVec2Property } from "./bindings.js";
import type {
  AnyNode,
  AtlasDef,
  BindableProperty,
  Binding,
  BlendMode,
  ExpressionDef,
  GroupNode,
  MaskMode,
  MeshSpec,
  Model,
  MotionDef,
  MotionEase,
  MotionKey,
  ParamDef,
  PhysicsChain,
  PhysicsDef,
  RotatorNode,
  SpriteNode,
  VariantSlot,
  WarpNode,
} from "./types/model.js";

const ID_RE = /^[a-z][a-z0-9_]*$/;
const PARAM_ID_RE = /^(Lyre\.[A-Za-z][A-Za-z0-9]*|[a-z][a-z0-9_]*)$/;
const VERSION_RE = /^([0-9]+)\.([0-9]+)$/;
// Indexed by untrusted JSON text. A Map prevents inherited Object prototype
// names from masquerading as binding-property entries.
const BINDING_TARGET_TYPES: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["angle", ["rotator"]],
  ["scale", ["rotator"]],
  ["pivot_offset", ["rotator"]],
  ["opacity", ["group", "sprite"]],
  ["z", ["group", "sprite"]],
  ["offset", ["sprite"]],
  ["verts", ["sprite"]],
  ["grid", ["warp"]],
]);

/** Construction-only mutable view used while resolving a sprite's mask cycle. */
type MutableSpriteNode = { -readonly [Key in keyof SpriteNode]: SpriteNode[Key] };

/** Spec version implemented by this runtime. */
export const SUPPORTED_SPEC = { major: 0, minor: 1 } as const;

/**
 * Parsed JSON documents of a container (§3). I/O belongs to callers: pass the
 * result of `parseLyreJson()` per file so duplicate object members remain a
 * load error (§2). `expressions`/`motions` are keyed by their manifest-listed
 * paths (used only for error messages).
 */
export interface ModelFiles {
  manifest: unknown;
  rig: unknown;
  physics?: unknown;
  variants?: unknown;
  atlas?: unknown;
  expressions?: Readonly<Record<string, unknown>>;
  motions?: Readonly<Record<string, unknown>>;
}

export interface LoadOptions {
  /**
   * Capabilities this runtime supports; defaults to every §15 capability of
   * spec 0.1. A model listing anything outside this set is refused (§3.1).
   */
  supportedCapabilities?: ReadonlyArray<string>;
  /**
   * Host escape hatch (§3.1): load despite unsupported capabilities. The
   * refusal becomes a warning and rendering is not claimed conforming.
   */
  allowCapabilityOverride?: boolean;
}

// ---------------------------------------------------------------------------
// small JSON accessors

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function fail(
  code: ConstructorParameters<typeof LyreLoadError>[0],
  msg: string,
  id?: string,
): never {
  throw new LyreLoadError(code, msg, id);
}

function reqObj(x: unknown, what: string): Record<string, unknown> {
  if (!isObj(x)) fail("bad_shape", `${what} must be a JSON object`);
  return x;
}

function reqArr(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) fail("bad_shape", `${what} must be a JSON array`);
  return x;
}

function reqString(x: unknown, what: string): string {
  if (typeof x !== "string") fail("bad_shape", `${what} must be a string`);
  return x;
}

/** Allocation-free UTF-8 ceiling check (lone surrogates encode as U+FFFD). */
function exceedsUtf8Bytes(value: string, limit: number): boolean {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      i + 1 < value.length &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

/** §16 path syntax shared by directory and ZIP-backed container readers. */
function reqContainerPath(x: unknown, what: string): string {
  const path = reqString(x, what);
  if (path.length === 0 || path.includes("\0")) {
    fail("bad_shape", `${what} must be a non-empty, NUL-free relative container path (§16)`);
  }
  if (exceedsUtf8Bytes(path, RUNTIME_LIMITS.containerPathBytes)) {
    fail(
      "limit_exceeded",
      `${what} exceeds ${RUNTIME_LIMITS.containerPathBytes} UTF-8 path bytes (§16)`,
    );
  }
  // Reject POSIX/UNC roots and Windows drive-relative prefixes (`C:foo`) on
  // every host so one model cannot acquire platform-dependent path meaning.
  if (/^([a-zA-Z]:|[\\/])/.test(path)) {
    fail("bad_shape", `${what} must be relative (§16)`);
  }
  if (path.split(/[\\/]/).some((segment) => segment === "..")) {
    fail("bad_shape", `${what} must not contain ".." segments (§16)`);
  }
  return path;
}

function reqNum(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    fail("bad_shape", `${what} must be a finite number`);
  }
  if (Math.abs(x) > LIMITS.authoredNumberMagnitude) {
    fail(
      "limit_exceeded",
      `${what} exceeds the ±${LIMITS.authoredNumberMagnitude} authored-number ceiling (§16)`,
    );
  }
  return x;
}

function reqInt(x: unknown, what: string): number {
  const n = reqNum(x, what);
  if (!Number.isInteger(n)) fail("bad_shape", `${what} must be an integer`);
  return n;
}

function optNum(x: unknown, what: string, dflt: number): number {
  return x === undefined ? dflt : reqNum(x, what);
}

function optBool(x: unknown, what: string, dflt: boolean): boolean {
  if (x === undefined) return dflt;
  if (typeof x !== "boolean") fail("bad_shape", `${what} must be a boolean`);
  return x;
}

function reqVec2(x: unknown, what: string): readonly [number, number] {
  const a = reqArr(x, what);
  if (a.length !== 2) fail("bad_shape", `${what} must be [x, y]`);
  return [reqNum(a[0], `${what}[0]`), reqNum(a[1], `${what}[1]`)];
}

function reqRect(x: unknown, what: string): readonly [number, number, number, number] {
  const a = reqArr(x, what);
  if (a.length !== 4) fail("bad_shape", `${what} must be [x, y, w, h]`);
  const r = [
    reqNum(a[0], `${what}[0]`),
    reqNum(a[1], `${what}[1]`),
    reqNum(a[2], `${what}[2]`),
    reqNum(a[3], `${what}[3]`),
  ] as const;
  if (r[2] < 0 || r[3] < 0) fail("bad_shape", `${what} must have non-negative size`);
  return r;
}

function reqAtlasRect(x: unknown, what: string): readonly [number, number, number, number] {
  const a = reqArr(x, what);
  if (a.length !== 4) fail("bad_shape", `${what} must be [x, y, w, h]`);
  const r = [
    reqNum(a[0], `${what}[0]`),
    reqNum(a[1], `${what}[1]`),
    reqNum(a[2], `${what}[2]`),
    reqNum(a[3], `${what}[3]`),
  ] as const;
  if (!r.every(Number.isInteger) || r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0) {
    fail("bad_atlas", `${what} must contain non-negative integer x/y and positive integer w/h`);
  }
  return r;
}

function reqId(x: unknown, what: string): string {
  const s = reqString(x, what);
  if (s.length > LIMITS.idLength) {
    fail("limit_exceeded", `${what} exceeds the ${LIMITS.idLength}-char id ceiling (§16)`);
  }
  if (!ID_RE.test(s)) fail("bad_id", `${what} must match [a-z][a-z0-9_]* — got "${s}"`);
  return s;
}

function reqParamId(x: unknown, what: string): string {
  const s = reqString(x, what);
  if (s.length > LIMITS.idLength) {
    fail("limit_exceeded", `${what} exceeds the ${LIMITS.idLength}-char id ceiling (§16)`);
  }
  if (!PARAM_ID_RE.test(s)) {
    fail("bad_id", `${what} must be snake_case or a Lyre.* registry id — got "${s}"`);
  }
  return s;
}

function opacity01(x: unknown, what: string, dflt: number): number {
  const v = optNum(x, what, dflt);
  if (v < 0 || v > 1) fail("bad_shape", `${what} must be within 0..1`);
  return v;
}

function boundedOwnKeys(
  value: Readonly<Record<string, unknown>> | undefined,
  limit: number,
  what: string,
): string[] {
  const keys: string[] = [];
  for (const key in value ?? {}) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (keys.length >= limit) {
      fail("limit_exceeded", `${what} exceeds ${limit} entries (§16)`);
    }
    keys.push(key);
  }
  return keys;
}

// ---------------------------------------------------------------------------

export function loadModel(files: ModelFiles, opts: LoadOptions = {}): Model {
  const warnings: string[] = [];

  // ----- manifest (§3.1)
  const manifest = reqObj(files.manifest, "manifest.json");
  const versionStr = reqString(manifest.lyre, "manifest.lyre");
  const vm = VERSION_RE.exec(versionStr);
  if (!vm) fail("bad_shape", `manifest.lyre must be "MAJOR.MINOR" — got "${versionStr}"`);
  const specVersion = { major: Number(vm[1]), minor: Number(vm[2]) };
  if (specVersion.major !== SUPPORTED_SPEC.major) {
    fail(
      "unsupported_spec_version",
      `spec MAJOR ${specVersion.major} is not supported (runtime implements ${SUPPORTED_SPEC.major}.${SUPPORTED_SPEC.minor}); refusing (§3.1)`,
    );
  }
  if (specVersion.minor > SUPPORTED_SPEC.minor) {
    warnings.push(
      `model declares spec ${versionStr}, newer than the implemented ${SUPPORTED_SPEC.major}.${SUPPORTED_SPEC.minor}; unknown MINOR features may be ignored (§3.1)`,
    );
  }

  const modelId = reqId(manifest.id, "manifest.id");
  const name = manifest.name === undefined ? null : reqString(manifest.name, "manifest.name");

  // `manifest.files` is authoritative even for this parsed-document API.
  // Keeping this check here prevents callers that bypass a container reader
  // from silently injecting an unlisted optional document.
  const manifestFiles =
    manifest.files === undefined ? {} : reqObj(manifest.files, "manifest.files");
  const listedSingle = (key: "rig" | "physics" | "variants" | "atlas"): string | undefined => {
    const value = manifestFiles[key];
    if (value === undefined) return key === "rig" ? "rig.json" : undefined;
    return reqContainerPath(value, `manifest.files.${key}`);
  };
  const listedMany = (key: "expressions" | "motions"): string[] => {
    const value = manifestFiles[key];
    if (value === undefined) return [];
    const raw = reqArr(value, `manifest.files.${key}`);
    if (raw.length > LIMITS.containerFiles) {
      fail("limit_exceeded", `manifest.files.${key} exceeds ${LIMITS.containerFiles} paths (§16)`);
    }
    const paths = raw.map((entry, i) => {
      return reqContainerPath(entry, `manifest.files.${key}[${i}]`);
    });
    if (new Set(paths).size !== paths.length) {
      fail("bad_shape", `manifest.files.${key} must not contain duplicate paths`);
    }
    return paths;
  };
  const listedRig = listedSingle("rig")!;
  const listedPhysics = listedSingle("physics");
  const listedVariants = listedSingle("variants");
  const listedAtlas = listedSingle("atlas");
  const listedExpressions = listedMany("expressions");
  const listedMotions = listedMany("motions");
  const listedJsonPaths = new Set([
    listedRig,
    ...(listedPhysics ? [listedPhysics] : []),
    ...(listedVariants ? [listedVariants] : []),
    ...(listedAtlas ? [listedAtlas] : []),
    ...listedExpressions,
    ...listedMotions,
  ]);
  if (listedJsonPaths.size > LIMITS.containerFiles) {
    fail(
      "limit_exceeded",
      `manifest lists more than ${LIMITS.containerFiles} distinct JSON documents (§16)`,
    );
  }
  const requireExactSingle = (
    key: "physics" | "variants" | "atlas",
    listed: string | undefined,
    supplied: unknown,
  ): void => {
    if ((listed !== undefined) !== (supplied !== undefined)) {
      fail(
        "bad_shape",
        listed === undefined
          ? `${key} document was supplied but manifest.files.${key} does not list it (§3.1)`
          : `manifest.files.${key} lists "${listed}" but no parsed ${key} document was supplied (§3.1)`,
      );
    }
  };
  const requireExactMany = (
    key: "expressions" | "motions",
    listed: string[],
    supplied: Readonly<Record<string, unknown>> | undefined,
  ): void => {
    const limit = key === "expressions" ? LIMITS.expressions : LIMITS.motions;
    const actual = boundedOwnKeys(supplied, limit, `parsed ${key} documents`);
    const wanted = new Set(listed);
    if (actual.length !== listed.length || actual.some((path) => !wanted.has(path))) {
      fail("bad_shape", `parsed ${key} documents must exactly match manifest.files.${key} (§3.1)`);
    }
  };
  requireExactSingle("physics", listedPhysics, files.physics);
  requireExactSingle("variants", listedVariants, files.variants);
  requireExactSingle("atlas", listedAtlas, files.atlas);
  requireExactMany("expressions", listedExpressions, files.expressions);
  requireExactMany("motions", listedMotions, files.motions);

  const canvasObj = reqObj(manifest.canvas, "manifest.canvas");
  const width = reqInt(canvasObj.width, "canvas.width");
  const height = reqInt(canvasObj.height, "canvas.height");
  if (
    width < 1 ||
    height < 1 ||
    width > LIMITS.canvasDimension ||
    height > LIMITS.canvasDimension
  ) {
    fail("limit_exceeded", `canvas dimensions must be 1..${LIMITS.canvasDimension} px (§16)`);
  }
  if (width * height > LIMITS.canvasPixels) {
    fail("limit_exceeded", `canvas exceeds ${LIMITS.canvasPixels} total pixels (§16)`);
  }
  const origin = reqVec2(canvasObj.origin, "canvas.origin");
  const canvas = { width, height, origin };

  const supported = new Set(opts.supportedCapabilities ?? [...KNOWN_CAPABILITIES]);
  supported.add("core");
  const capabilities = new Set<string>(["core"]);
  if (manifest.capabilities !== undefined) {
    const capabilitiesRaw = reqArr(manifest.capabilities, "manifest.capabilities");
    if (capabilitiesRaw.length > LIMITS.capabilities) {
      fail("limit_exceeded", `model exceeds ${LIMITS.capabilities} capabilities (§16)`);
    }
    const listedCapabilities = new Set<string>();
    for (const c of capabilitiesRaw) {
      const capability = reqString(c, "capability");
      if (capability.length > LIMITS.idLength) {
        fail("limit_exceeded", `capability exceeds ${LIMITS.idLength} characters (§16)`);
      }
      if (listedCapabilities.has(capability)) {
        fail("bad_shape", `manifest.capabilities must not contain duplicates`);
      }
      listedCapabilities.add(capability);
      capabilities.add(capability);
    }
  }
  for (const c of capabilities) {
    if (!supported.has(c)) {
      if (opts.allowCapabilityOverride) {
        warnings.push(
          `capability "${c}" is not supported by this runtime; loaded via host override — rendering is NOT conforming (§3.1)`,
        );
      } else {
        fail("unsupported_capability", `model requires unsupported capability "${c}" (§3.1)`);
      }
    }
  }
  const requireDeclaredCapability = (capability: string, shippedFeature: string): void => {
    if (!capabilities.has(capability)) {
      fail(
        "unsupported_capability",
        `model ships ${shippedFeature} but manifest.capabilities does not list "${capability}" (§3.1)`,
      );
    }
  };
  if (listedMotions.length > 0) {
    requireDeclaredCapability("motion", "motion files");
  }
  if (files.physics !== undefined) {
    requireDeclaredCapability("physics", "physics.json");
  }
  if (files.variants !== undefined) {
    requireDeclaredCapability("variants", "variants.json");
  }

  // ----- rig: params (§6)
  const rig = reqObj(files.rig, "rig.json");
  const paramsById = new Map<string, ParamDef>();
  const params: ParamDef[] = [];
  const paramsRaw = reqArr(rig.params, "rig.params");
  if (paramsRaw.length > LIMITS.params) {
    fail("limit_exceeded", `model exceeds ${LIMITS.params} parameters (§16)`);
  }
  for (const [i, raw] of paramsRaw.entries()) {
    const p = reqObj(raw, `params[${i}]`);
    const id = reqParamId(p.id, `params[${i}].id`);
    if (paramsById.has(id)) fail("duplicate_id", `duplicate parameter id`, id);
    const min = reqNum(p.min, `param min`);
    const max = reqNum(p.max, `param max`);
    const dflt = reqNum(p.default, `param default`);
    if (min > max) fail("bad_param", `param min must be ≤ max`, id);
    if (!Number.isFinite(max - min)) {
      fail("bad_param", `parameter range must have a finite span`, id);
    }
    if (dflt < min || dflt > max) fail("bad_param", `param default outside [min, max]`, id);
    const wrap = optBool(p.wrap, `param wrap`, false);
    if (wrap && max <= min) {
      fail("bad_param", `wrapping parameter range must have a finite positive span`, id);
    }
    const reg = LYRE_REGISTRY.get(id);
    if (id.startsWith("Lyre.")) {
      if (!reg) {
        fail(
          "bad_param",
          `"${id}" uses the reserved Lyre. prefix but is not a registry parameter (§6)`,
          id,
        );
      } else {
        if (reg.min !== min || reg.max !== max || reg.default !== dflt) {
          fail(
            "bad_param",
            `"${id}" must use the registry range/default [${reg.min}, ${reg.max}] / ${reg.default} (Annex A)`,
            id,
          );
        }
        if (wrap) {
          fail("bad_param", `registry parameter "${id}" must not declare wrap (§6)`, id);
        }
      }
    }
    const def: ParamDef = { id, min, max, default: dflt, wrap };
    params.push(def);
    paramsById.set(id, def);
  }

  // ----- rig: nodes (§5)
  const nodesRaw = reqArr(rig.nodes, "rig.nodes");
  if (nodesRaw.length !== 1) fail("bad_root", `rig.nodes must hold exactly one root group (§5)`);

  const nodesById = new Map<string, AnyNode>();
  const sprites: SpriteNode[] = [];
  const pendingMasks: Array<{ sprite: MutableSpriteNode; mode: MaskMode; sources: string[] }> = [];
  let nodeCount = 0;
  let totalMeshPoints = 0;
  let totalMeshTriangles = 0;
  let totalMaskReferences = 0;
  let order = 0;

  function addMeshPoints(count: number, nodeId: string): void {
    totalMeshPoints += count;
    if (totalMeshPoints > LIMITS.totalMeshPoints) {
      fail(
        "limit_exceeded",
        `model exceeds ${LIMITS.totalMeshPoints} total sprite-mesh and warp control points (§16)`,
        nodeId,
      );
    }
  }

  function addMeshTriangles(count: number, nodeId: string): void {
    totalMeshTriangles += count;
    if (totalMeshTriangles > LIMITS.totalMeshTriangles) {
      fail(
        "limit_exceeded",
        `model exceeds ${LIMITS.totalMeshTriangles} total sprite-mesh triangles (§16)`,
        nodeId,
      );
    }
  }

  function parseMesh(raw: unknown, nodeId: string): MeshSpec {
    if (raw === undefined) {
      addMeshPoints(4, nodeId);
      addMeshTriangles(2, nodeId);
      return { type: "grid", cols: 1, rows: 1 };
    }
    const m = reqObj(raw, `mesh of "${nodeId}"`);
    if (m.type === "grid" || m.type === undefined) {
      const cols = m.cols === undefined ? 1 : reqInt(m.cols, "mesh.cols");
      const rows = m.rows === undefined ? 1 : reqInt(m.rows, "mesh.rows");
      if (cols < 1 || rows < 1 || cols > LIMITS.gridColsRows || rows > LIMITS.gridColsRows) {
        fail("limit_exceeded", `mesh cols/rows must be 1..${LIMITS.gridColsRows} (§16)`, nodeId);
      }
      addMeshPoints((cols + 1) * (rows + 1), nodeId);
      addMeshTriangles(2 * cols * rows, nodeId);
      return { type: "grid", cols, rows };
    }
    if (m.type === "explicit") {
      const pointsRaw = reqArr(m.points, "mesh.points");
      if (pointsRaw.length > LIMITS.explicitMeshPoints) {
        fail(
          "limit_exceeded",
          `explicit mesh exceeds ${LIMITS.explicitMeshPoints} points (§16)`,
          nodeId,
        );
      }
      addMeshPoints(pointsRaw.length, nodeId);
      const points = pointsRaw.map((p, i) => reqVec2(p, `mesh.points[${i}]`));
      const trisRaw = reqArr(m.tris, "mesh.tris");
      if (trisRaw.length > LIMITS.explicitMeshTriangles) {
        fail(
          "limit_exceeded",
          `explicit mesh exceeds ${LIMITS.explicitMeshTriangles} triangles (§16)`,
          nodeId,
        );
      }
      addMeshTriangles(trisRaw.length, nodeId);
      const tris = trisRaw.map((t, i) => {
        const a = reqArr(t, `mesh.tris[${i}]`);
        if (a.length !== 3) fail("bad_shape", `mesh.tris[${i}] must be [i, j, k]`, nodeId);
        const tri = [
          reqInt(a[0], `tris[${i}][0]`),
          reqInt(a[1], `tris[${i}][1]`),
          reqInt(a[2], `tris[${i}][2]`),
        ] as const;
        for (const ix of tri) {
          if (ix < 0 || ix >= points.length) {
            fail("bad_shape", `mesh.tris[${i}] indexes outside points`, nodeId);
          }
        }
        return tri;
      });
      return { type: "explicit", points, tris };
    }
    fail("bad_shape", `mesh.type must be "grid" or "explicit"`, nodeId);
  }

  function parseNode(
    raw: unknown,
    parent: GroupNode | WarpNode | RotatorNode | null,
    depth: number,
  ): AnyNode {
    if (depth > LIMITS.treeDepth) {
      fail("limit_exceeded", `node tree exceeds depth ${LIMITS.treeDepth} (§16)`);
    }
    if (++nodeCount > LIMITS.nodes) {
      fail("limit_exceeded", `model exceeds ${LIMITS.nodes} nodes (§16)`);
    }
    const n = reqObj(raw, "node");
    const id = reqId(n.id, "node.id");
    if (nodesById.has(id)) fail("duplicate_id", `duplicate node id`, id);
    const type = reqString(n.type, `node.type of "${id}"`);
    const myOrder = order++;

    if (type === "group") {
      const children: AnyNode[] = [];
      const node: GroupNode = {
        id,
        type,
        parent,
        order: myOrder,
        opacity: opacity01(n.opacity, `opacity of "${id}"`, 1),
        children,
      };
      nodesById.set(id, node);
      for (const c of childrenOf(n, id)) children.push(parseNode(c, node, depth + 1));
      return node;
    }

    if (type === "sprite") {
      if (n.children !== undefined && reqArr(n.children, "sprite.children").length > 0) {
        fail("sprite_children", `sprite must not have children (§5)`, id);
      }
      const textureRaw = n.texture === undefined ? id : reqId(n.texture, `texture of "${id}"`);
      const blend = (n.blend ?? "normal") as BlendMode;
      if (blend !== "normal" && blend !== "additive" && blend !== "multiply") {
        fail("bad_shape", `blend must be normal|additive|multiply`, id);
      }
      const rect = reqRect(n.rect, `rect of "${id}"`);
      const mesh = parseMesh(n.mesh, id);
      if (mesh.type === "explicit") {
        const [rx, ry, rw, rh] = rect;
        for (const [x, y] of mesh.points) {
          const u = rw === 0 ? 0 : (x - rx) / rw;
          const v = rh === 0 ? 0 : (y - ry) / rh;
          if (!Number.isFinite(u) || !Number.isFinite(v)) {
            fail(
              "bad_shape",
              `explicit mesh UV derivation must remain finite for sprite "${id}" (§5.4)`,
              id,
            );
          }
        }
      }
      const node: MutableSpriteNode = {
        id,
        type,
        parent,
        order: myOrder,
        rect,
        texture: textureRaw,
        z: n.z === undefined ? 0 : reqInt(n.z, `z of "${id}"`),
        opacity: opacity01(n.opacity, `opacity of "${id}"`, 1),
        blend,
        mesh,
        mask: null,
        spriteOrder: sprites.length,
      };
      if (n.mask !== undefined) {
        const m = reqObj(n.mask, `mask of "${id}"`);
        const mode = m.mode as MaskMode;
        if (mode !== "alpha" && mode !== "inverted") {
          fail("bad_shape", `mask.mode must be alpha|inverted`, id);
        }
        const sourcesRaw = reqArr(m.sources, `mask.sources of "${id}"`);
        if (sourcesRaw.length > LIMITS.maskSources) {
          fail(
            "limit_exceeded",
            `mask.sources exceeds ${LIMITS.maskSources} sources per sprite (§16)`,
            id,
          );
        }
        const sources = sourcesRaw.map((s, i) => reqId(s, `mask.sources[${i}]`));
        if (sources.length === 0) fail("bad_shape", `mask.sources must not be empty`, id);
        if (new Set(sources).size !== sources.length) {
          fail("bad_shape", `mask.sources must not contain duplicate sprite ids`, id);
        }
        totalMaskReferences += sources.length;
        if (totalMaskReferences > LIMITS.maskReferences) {
          fail(
            "limit_exceeded",
            `model exceeds ${LIMITS.maskReferences} aggregate mask references (§16)`,
            id,
          );
        }
        pendingMasks.push({ sprite: node, mode, sources });
      }
      nodesById.set(id, node);
      sprites.push(node);
      return node;
    }

    if (type === "warp") {
      const cols = reqInt(n.cols, `cols of "${id}"`);
      const rows = reqInt(n.rows, `rows of "${id}"`);
      if (cols < 1 || rows < 1 || cols > LIMITS.gridColsRows || rows > LIMITS.gridColsRows) {
        fail("limit_exceeded", `warp cols/rows must be 1..${LIMITS.gridColsRows} (§16)`, id);
      }
      const rect = reqRect(n.rect, `rect of "${id}"`);
      if (rect[2] <= 0 || rect[3] <= 0) {
        fail("bad_shape", `warp rect must have strictly positive width and height`, id);
      }
      addMeshPoints((cols + 1) * (rows + 1), id);
      const children: AnyNode[] = [];
      const node: WarpNode = {
        id,
        type,
        parent,
        order: myOrder,
        rect,
        cols,
        rows,
        children,
      };
      nodesById.set(id, node);
      for (const c of childrenOf(n, id)) children.push(parseNode(c, node, depth + 1));
      return node;
    }

    if (type === "rotator") {
      const children: AnyNode[] = [];
      const node: RotatorNode = {
        id,
        type,
        parent,
        order: myOrder,
        pivot: reqVec2(n.pivot, `pivot of "${id}"`),
        angle: optNum(n.angle, `angle of "${id}"`, 0),
        scale: optNum(n.scale, `scale of "${id}"`, 1),
        children,
      };
      nodesById.set(id, node);
      for (const c of childrenOf(n, id)) children.push(parseNode(c, node, depth + 1));
      return node;
    }

    fail("unknown_node_type", `unknown node type "${type}" is a load error (§2)`, id);
  }

  function childrenOf(n: Record<string, unknown>, id: string): unknown[] {
    return n.children === undefined ? [] : reqArr(n.children, `children of "${id}"`);
  }

  const root = parseNode(nodesRaw[0], null, 1);
  if (root.type !== "group") fail("bad_root", `the root node must be a group (§5)`, root.id);

  // Masks: resolve sources, forbid recursion (§8.4).
  const maskEdges = new Map<SpriteNode, SpriteNode[]>();
  for (const { sprite, mode, sources } of pendingMasks) {
    const resolved = sources.map((sid) => {
      const src = nodesById.get(sid);
      if (!src) fail("bad_reference", `mask source "${sid}" does not exist`, sprite.id);
      if (src.type !== "sprite")
        fail("bad_reference", `mask source "${sid}" is not a sprite (§8.4)`, sprite.id);
      return src;
    });
    sprite.mask = { mode, sources: resolved };
    maskEdges.set(sprite, resolved);
  }
  {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2;
    const color = new Map<SpriteNode, number>();
    for (const start of maskEdges.keys()) {
      if ((color.get(start) ?? WHITE) === BLACK) continue;
      color.set(start, GRAY);
      const stack: Array<{ sprite: SpriteNode; next: number }> = [{ sprite: start, next: 0 }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1]!;
        const edges = maskEdges.get(frame.sprite) ?? [];
        if (frame.next >= edges.length) {
          color.set(frame.sprite, BLACK);
          stack.pop();
          continue;
        }
        const target = edges[frame.next++]!;
        const targetColor = color.get(target) ?? WHITE;
        if (targetColor === GRAY) {
          fail("recursive_mask", `mask chain is recursive (§8.4)`, target.id);
        }
        if (targetColor === WHITE) {
          color.set(target, GRAY);
          stack.push({ sprite: target, next: 0 });
        }
      }
    }
  }

  // ----- rig: bindings (§7)
  const bindings: Binding[] = [];
  const bindingsRaw = reqArr(rig.bindings, "rig.bindings");
  if (bindingsRaw.length > LIMITS.bindings) {
    fail("limit_exceeded", `model exceeds ${LIMITS.bindings} bindings (§16)`);
  }
  let totalBindingValueScalars = 0;
  for (const [bi, raw] of bindingsRaw.entries()) {
    const b = reqObj(raw, `bindings[${bi}]`);
    const where = `bindings[${bi}]`;
    const targetId = reqId(b.target, `${where}.target`);
    const target = nodesById.get(targetId);
    if (!target) fail("bad_reference", `${where}: target "${targetId}" does not exist`);
    const propertyName = reqString(b.property, `${where}.property`);

    const allowedTypes = BINDING_TARGET_TYPES.get(propertyName);
    if (!allowedTypes) fail("bad_binding", `${where}: unknown property "${propertyName}"`);
    const property = propertyName as BindableProperty;
    if (!allowedTypes.includes(target.type)) {
      fail(
        "bad_binding",
        `${where}: property "${property}" does not apply to a ${target.type}`,
        targetId,
      );
    }

    const paramIdsRaw = reqArr(b.params, `${where}.params`);
    if (paramIdsRaw.length < 1 || paramIdsRaw.length > LIMITS.bindingAxes) {
      fail("limit_exceeded", `${where}: bindings take 1..${LIMITS.bindingAxes} params (§16)`);
    }
    const paramIds = paramIdsRaw.map((p, i) => reqParamId(p, `${where}.params[${i}]`));
    if (new Set(paramIds).size !== paramIds.length) {
      fail("bad_binding", `${where}: params must be distinct`);
    }
    const bparams = paramIds.map((pid) => {
      const def = paramsById.get(pid);
      if (!def) fail("bad_reference", `${where}: param "${pid}" is not declared in rig.params`);
      return def;
    });

    const axesRaw = reqArr(b.axes, `${where}.axes`);
    if (axesRaw.length !== bparams.length) {
      fail("bad_binding", `${where}: axes count must equal params count`);
    }
    const axes = axesRaw.map((axisRaw, ai) => {
      const rawAxis = reqArr(axisRaw, `${where}.axes[${ai}]`);
      if (rawAxis.length < 1 || rawAxis.length > LIMITS.keysPerAxis) {
        fail("limit_exceeded", `${where}: axes carry 1..${LIMITS.keysPerAxis} keys (§16)`);
      }
      const axis = rawAxis.map((k, ki) => reqNum(k, `${where}.axes[${ai}][${ki}]`));
      for (let k = 1; k < axis.length; k++) {
        if (axis[k]! <= axis[k - 1]!) {
          fail("bad_binding", `${where}.axes[${ai}] must be strictly increasing (§7)`);
        }
        if (!Number.isFinite(axis[k]! - axis[k - 1]!)) {
          fail("bad_binding", `${where}.axes[${ai}] has an unrepresentable key span`);
        }
      }
      if (!Number.isFinite(axis[axis.length - 1]! - axis[0]!)) {
        fail("bad_binding", `${where}.axes[${ai}] has an unrepresentable total span`);
      }
      if (
        bparams[ai]!.wrap &&
        (axis[0]! < bparams[ai]!.min || axis[axis.length - 1]! >= bparams[ai]!.max)
      ) {
        fail(
          "bad_binding",
          `${where}.axes[${ai}] keys for a wrapping parameter must lie in its half-open range [min, max)`,
        );
      }
      return axis;
    });

    // Expected entry arity from the property/target.
    let arity: number;
    if (isScalarProperty(property)) arity = 1;
    else if (isVec2Property(property)) arity = 2;
    else if (property === "grid") {
      const w = target as WarpNode;
      arity = 2 * (w.cols + 1) * (w.rows + 1);
    } else {
      // verts
      const s = target as SpriteNode;
      const count =
        s.mesh.type === "grid" ? (s.mesh.cols + 1) * (s.mesh.rows + 1) : s.mesh.points.length;
      arity = 2 * count;
    }

    const expectedCount = axes.reduce((n, a) => n * a.length, 1);
    const valuesRaw = reqArr(b.values, `${where}.values`);
    if (valuesRaw.length !== expectedCount) {
      fail(
        "bad_binding",
        `${where}: values must hold ${expectedCount} entries (product of axis lengths), got ${valuesRaw.length} (§7)`,
      );
    }
    if (expectedCount * arity > LIMITS.valueScalarsPerBinding) {
      fail(
        "limit_exceeded",
        `${where}: exceeds ${LIMITS.valueScalarsPerBinding} value scalars (§16)`,
      );
    }
    totalBindingValueScalars += expectedCount * arity;
    if (totalBindingValueScalars > LIMITS.totalBindingValueScalars) {
      fail(
        "limit_exceeded",
        `model exceeds ${LIMITS.totalBindingValueScalars} aggregate binding value scalars (§16)`,
      );
    }

    const values = new Float64Array(expectedCount * arity);
    for (let ei = 0; ei < valuesRaw.length; ei++) {
      const entryRaw = valuesRaw[ei];
      const offset = ei * arity;
      if (arity === 1) {
        values[offset] = reqNum(entryRaw, `${where}.values[${ei}]`);
      } else if (arity === 2 && isVec2Property(property)) {
        const v = reqVec2(entryRaw, `${where}.values[${ei}]`);
        values[offset] = v[0];
        values[offset + 1] = v[1];
      } else {
        const list = reqArr(entryRaw, `${where}.values[${ei}]`);
        if (list.length * 2 !== arity) {
          fail(
            "bad_binding",
            `${where}.values[${ei}]: expected ${arity / 2} [dx,dy] deltas for "${property}", got ${list.length} — mesh/warp declaration mismatch (§5.4)`,
            targetId,
          );
        }
        for (let i = 0; i < list.length; i++) {
          const v = reqVec2(list[i], `${where}.values[${ei}][${i}]`);
          values[offset + 2 * i] = v[0];
          values[offset + 2 * i + 1] = v[1];
        }
      }
    }

    bindings.push({
      target,
      property,
      params: bparams,
      axes,
      values,
      arity,
      kind: propertyClass(property),
    });
  }

  // ----- expressions (§10.1)
  const expressions: ExpressionDef[] = [];
  {
    const paths = listedExpressions;
    const seen = new Set<string>();
    let totalEntries = 0;
    for (const path of paths) {
      const raw = files.expressions![path];
      const e = reqObj(raw, `expression "${path}"`);
      const id = reqId(e.id, `expression id in "${path}"`);
      if (seen.has(id)) fail("duplicate_id", `duplicate expression id`, id);
      seen.add(id);
      const entriesRaw = reqArr(e.params, `expression "${id}" params`);
      totalEntries += entriesRaw.length;
      if (totalEntries > LIMITS.expressionEntries) {
        fail(
          "limit_exceeded",
          `model exceeds ${LIMITS.expressionEntries} aggregate expression entries (§16)`,
        );
      }
      const entryTargets = new Set<string>();
      const entries = entriesRaw.map((rawEntry, i) => {
        const en = reqObj(rawEntry, `expression "${id}" params[${i}]`);
        const pid = reqParamId(en.id, `expression "${id}" params[${i}].id`);
        if (!paramsById.has(pid)) {
          fail("bad_reference", `expression "${id}" targets undeclared param "${pid}"`);
        }
        if (entryTargets.has(pid)) {
          fail(
            "bad_expression",
            `expression "${id}" must not target parameter "${pid}" more than once (§10.1)`,
            id,
          );
        }
        entryTargets.add(pid);
        const blend = en.blend as "add" | "multiply" | "overwrite";
        if (blend !== "add" && blend !== "multiply" && blend !== "overwrite") {
          fail(
            "bad_expression",
            `expression "${id}" params[${i}].blend must be add|multiply|overwrite`,
          );
        }
        return { id: pid, value: reqNum(en.value, "expression value"), blend };
      });
      const fadeIn = optNum(e.fade_in, "fade_in", 0);
      const fadeOut = optNum(e.fade_out, "fade_out", 0);
      if (fadeIn < 0 || fadeOut < 0) {
        fail("bad_expression", `expression "${id}" fade durations must be non-negative`, id);
      }
      expressions.push({ id, fadeIn, fadeOut, params: entries });
    }
  }

  // ----- motions (§10.2)
  const motions: MotionDef[] = [];
  {
    const paths = listedMotions;
    const seen = new Set<string>();
    let totalTracks = 0;
    let totalKeys = 0;
    for (const path of paths) {
      const raw = files.motions![path];
      const m = reqObj(raw, `motion "${path}"`);
      const id = reqId(m.id, `motion id in "${path}"`);
      if (seen.has(id)) fail("duplicate_id", `duplicate motion id`, id);
      seen.add(id);
      const duration = reqNum(m.duration, `motion "${id}" duration`);
      if (duration <= 0) fail("bad_motion", `motion duration must be > 0`, id);
      const tracksRaw = reqArr(m.tracks, `motion "${id}" tracks`);
      totalTracks += tracksRaw.length;
      if (totalTracks > LIMITS.motionTracks) {
        fail(
          "limit_exceeded",
          `model exceeds ${LIMITS.motionTracks} aggregate motion tracks (§16)`,
        );
      }
      const trackTargets = new Set<string>();
      const tracks = tracksRaw.map((trackRaw, ti) => {
        const t = reqObj(trackRaw, `motion "${id}" tracks[${ti}]`);
        const pid = reqParamId(t.param, `motion "${id}" tracks[${ti}].param`);
        if (!paramsById.has(pid)) {
          fail("bad_reference", `motion "${id}" targets undeclared param "${pid}"`);
        }
        if (trackTargets.has(pid)) {
          fail(
            "bad_motion",
            `motion "${id}" must not contain more than one track for parameter "${pid}" (§10.2)`,
            id,
          );
        }
        trackTargets.add(pid);
        const keysRaw = reqArr(t.keys, `tracks[${ti}].keys`);
        totalKeys += keysRaw.length;
        if (totalKeys > LIMITS.motionKeys) {
          fail("limit_exceeded", `model exceeds ${LIMITS.motionKeys} aggregate motion keys (§16)`);
        }
        const keys: MotionKey[] = keysRaw.map((keyRaw, ki) => {
          const k = reqObj(keyRaw, `keys[${ki}]`);
          const kt = reqNum(k.t, `keys[${ki}].t`);
          const kv = reqNum(k.v, `keys[${ki}].v`);
          let ease: MotionEase = { type: "linear" };
          if (k.ease !== undefined) {
            if (k.ease === "linear" || k.ease === "step") ease = { type: k.ease };
            else if (k.ease === "bezier") {
              const cp = reqArr(k.cp, `keys[${ki}].cp`);
              if (cp.length !== 4) fail("bad_motion", `bezier cp must be [x1,y1,x2,y2]`, id);
              const c = [
                reqNum(cp[0], "cp[0]"),
                reqNum(cp[1], "cp[1]"),
                reqNum(cp[2], "cp[2]"),
                reqNum(cp[3], "cp[3]"),
              ] as const;
              if (c[0] < 0 || c[0] > 1 || c[2] < 0 || c[2] > 1) {
                fail("bad_motion", `bezier cp x components must lie in [0,1] (§10.2)`, id);
              }
              ease = { type: "bezier", cp: c };
            } else fail("bad_motion", `ease must be linear|step|bezier`, id);
          }
          return { t: kt, v: kv, ease };
        });
        if (keys.length === 0) fail("bad_motion", `tracks[${ti}] has no keys`, id);
        for (let ki = 0; ki < keys.length; ki++) {
          const kt = keys[ki]!.t;
          if (kt < 0 || kt > duration) fail("bad_motion", `key t outside [0, duration]`, id);
          if (ki > 0 && kt <= keys[ki - 1]!.t) {
            fail("bad_motion", `key times must be strictly increasing`, id);
          }
        }
        return { param: pid, keys };
      });
      motions.push({ id, duration, loop: optBool(m.loop, "loop", false), tracks });
    }
  }

  // ----- physics (§9)
  let physics: PhysicsDef | null = null;
  if (files.physics !== undefined) {
    const p = reqObj(files.physics, "physics.json");
    const fps = reqNum(p.fps, "physics.fps");
    if (fps <= 0) fail("bad_physics", `physics.fps must be > 0`);
    const physicsStep = 1 / fps;
    if (!Number.isFinite(physicsStep) || !Number.isFinite(physicsStep * physicsStep)) {
      fail(
        "bad_physics",
        `physics.fps is too small to produce a finite fixed timestep and squared timestep`,
      );
    }
    if (fps > LIMITS.physicsFps) {
      fail("limit_exceeded", `physics.fps exceeds ${LIMITS.physicsFps} (§16)`);
    }
    const chainsRaw = reqArr(p.chains, "physics.chains");
    if (chainsRaw.length > LIMITS.physicsChains) {
      fail("limit_exceeded", `physics exceeds ${LIMITS.physicsChains} chains (§16)`);
    }
    const seen = new Set<string>();
    const overwriteTargets = new Map<string, string>();
    let totalInputs = 0;
    let totalOutputs = 0;
    const chains: PhysicsChain[] = chainsRaw.map((chainRaw, ci) => {
      const c = reqObj(chainRaw, `chains[${ci}]`);
      const id = reqId(c.id, `chains[${ci}].id`);
      if (seen.has(id)) fail("duplicate_id", `duplicate chain id`, id);
      seen.add(id);
      const inputsRaw = reqArr(c.inputs, `chain "${id}" inputs`);
      totalInputs += inputsRaw.length;
      if (totalInputs > LIMITS.physicsInputs) {
        fail("limit_exceeded", `physics exceeds ${LIMITS.physicsInputs} aggregate inputs (§16)`);
      }
      const inputs = inputsRaw.map((inRaw, i) => {
        const inp = reqObj(inRaw, `inputs[${i}]`);
        const pid = reqParamId(inp.param, `inputs[${i}].param`);
        if (!paramsById.has(pid))
          fail("bad_reference", `chain "${id}" reads undeclared param "${pid}"`);
        const type = inp.type as "x" | "y" | "angle";
        if (type !== "x" && type !== "y" && type !== "angle") {
          fail("bad_physics", `inputs[${i}].type must be x|y|angle`, id);
        }
        return { param: pid, type, weight: reqNum(inp.weight, `inputs[${i}].weight`) };
      });
      const linksRaw = reqArr(c.links, `chain "${id}" links`);
      if (linksRaw.length < 1 || linksRaw.length > LIMITS.linksPerChain) {
        fail("limit_exceeded", `chains carry 1..${LIMITS.linksPerChain} links (§16)`, id);
      }
      const links = linksRaw.map((linkRaw, i) => {
        const l = reqObj(linkRaw, `links[${i}]`);
        const length = reqNum(l.length, `links[${i}].length`);
        if (length <= 0) fail("bad_physics", `link length must be > 0`, id);
        const damping = reqNum(l.damping, `links[${i}].damping`);
        const stiffness = reqNum(l.stiffness, `links[${i}].stiffness`);
        if (damping < 0 || damping > 1 || stiffness < 0 || stiffness > 1) {
          fail("bad_physics", `damping/stiffness must lie in [0,1]`, id);
        }
        return { length, damping, stiffness };
      });
      const outputsRaw = reqArr(c.outputs, `chain "${id}" outputs`);
      totalOutputs += outputsRaw.length;
      if (totalOutputs > LIMITS.physicsOutputs) {
        fail("limit_exceeded", `physics exceeds ${LIMITS.physicsOutputs} aggregate outputs (§16)`);
      }
      const outputs = outputsRaw.map((outRaw, i) => {
        const o = reqObj(outRaw, `outputs[${i}]`);
        const link = reqInt(o.link, `outputs[${i}].link`);
        if (link < 0 || link >= links.length) {
          fail("bad_reference", `outputs[${i}].link ${link} outside 0..${links.length - 1}`, id);
        }
        const pid = reqParamId(o.param, `outputs[${i}].param`);
        if (!paramsById.has(pid)) {
          fail("bad_reference", `chain "${id}" writes undeclared param "${pid}"`);
        }
        const blend = (o.blend ?? "overwrite") as "overwrite" | "add";
        if (blend !== "overwrite" && blend !== "add") {
          fail("bad_physics", `outputs[${i}].blend must be overwrite|add`, id);
        }
        if (blend === "overwrite") {
          const owner = overwriteTargets.get(pid);
          if (owner !== undefined) {
            fail(
              "bad_physics",
              `parameter "${pid}" has overwrite outputs in chains "${owner}" and "${id}"; only one overwrite output per target is permitted (§9)`,
              id,
            );
          }
          overwriteTargets.set(pid, id);
        }
        return { link, param: pid, multiplier: optNum(o.multiplier, "multiplier", 1), blend };
      });
      return {
        id,
        inputs,
        links,
        gravity: c.gravity === undefined ? ([0, 0] as const) : reqVec2(c.gravity, "gravity"),
        wind: c.wind === undefined ? ([0, 0] as const) : reqVec2(c.wind, "wind"),
        outputs,
      };
    });
    physics = { fps, chains };
  }

  // ----- variants (§10.3)
  const variantSlots: VariantSlot[] = [];
  if (files.variants !== undefined) {
    const v = reqObj(files.variants, "variants.json");
    const slotIds = new Set<string>();
    const nodeToSlot = new Map<string, string>();
    const slotsRaw = reqArr(v.slots, "variants.slots");
    if (slotsRaw.length > LIMITS.variantSlots) {
      fail("limit_exceeded", `model exceeds ${LIMITS.variantSlots} variant slots (§16)`);
    }
    let totalOptions = 0;
    let totalMemberships = 0;
    for (const [si, slotRaw] of slotsRaw.entries()) {
      const s = reqObj(slotRaw, `slots[${si}]`);
      const id = reqId(s.id, `slots[${si}].id`);
      if (slotIds.has(id)) fail("duplicate_id", `duplicate slot id`, id);
      slotIds.add(id);
      const optionIds = new Set<string>();
      const optionsRaw = reqArr(s.options, `slot "${id}" options`);
      totalOptions += optionsRaw.length;
      if (totalOptions > LIMITS.variantOptions) {
        fail("limit_exceeded", `model exceeds ${LIMITS.variantOptions} variant options (§16)`);
      }
      const options = optionsRaw.map((optRaw, oi) => {
        const o = reqObj(optRaw, `options[${oi}]`);
        const oid = reqId(o.id, `options[${oi}].id`);
        if (optionIds.has(oid)) fail("bad_variants", `duplicate option id "${oid}" in slot`, id);
        optionIds.add(oid);
        const optionNodes = reqArr(o.nodes, `option "${oid}" nodes`);
        totalMemberships += optionNodes.length;
        if (totalMemberships > LIMITS.variantMemberships) {
          fail(
            "limit_exceeded",
            `model exceeds ${LIMITS.variantMemberships} variant node memberships (§16)`,
          );
        }
        const nodes = optionNodes.map((nid, ni) => {
          const nodeId = reqId(nid, `option "${oid}" nodes[${ni}]`);
          const node = nodesById.get(nodeId);
          if (!node) fail("bad_reference", `variant option lists unknown node "${nodeId}"`, id);
          const owner = nodeToSlot.get(nodeId);
          if (owner !== undefined && owner !== id) {
            fail(
              "bad_variants",
              `node "${nodeId}" appears under two different slots ("${owner}", "${id}") (§10.3)`,
            );
          }
          nodeToSlot.set(nodeId, id);
          return node;
        });
        return { id: oid, nodes };
      });
      const dflt = reqId(s.default, `slot "${id}" default`);
      if (!optionIds.has(dflt)) fail("bad_variants", `slot default "${dflt}" is not an option`, id);
      variantSlots.push({ id, default: dflt, options });
    }
  }

  // ----- atlas (§3.2)
  let atlas: AtlasDef | null = null;
  if (files.atlas !== undefined) {
    const a = reqObj(files.atlas, "atlas.json");
    const image = reqContainerPath(a.image, "atlas.image");
    const rectsObj = reqObj(a.rects, "atlas.rects");
    const rects = new Map<string, readonly [number, number, number, number]>();
    let rectProperties = 0;
    for (const tid in rectsObj) {
      if (!Object.prototype.hasOwnProperty.call(rectsObj, tid)) continue;
      if (++rectProperties > LIMITS.atlasRects) {
        fail("limit_exceeded", `atlas exceeds ${LIMITS.atlasRects} rect/annotation entries (§16)`);
      }
      // `$` keys are always annotations (§1.3), including inside id-keyed
      // maps. `x_*`, however, is also a valid texture-id shape here, so in
      // this namespace it denotes a texture and must carry a real rect.
      if (tid.startsWith("$")) continue;
      const textureId = reqId(tid, `atlas texture key`);
      rects.set(textureId, reqAtlasRect(rectsObj[tid], `atlas.rects["${textureId}"]`));
    }
    atlas = { image, rects };
  }

  return {
    specVersion,
    id: modelId,
    name,
    canvas,
    capabilities,
    params,
    paramsById,
    root,
    nodesById,
    sprites,
    bindings,
    expressions,
    motions,
    physics,
    variantSlots,
    atlas,
    warnings,
  };
}
