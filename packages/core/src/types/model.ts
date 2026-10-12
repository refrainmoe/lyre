// Normalized in-memory model types. Raw container JSON is parsed and checked by
// load.ts; everything downstream (evaluation, rendering, validation) consumes
// these shapes and can assume the §16 ceilings and referential integrity hold.
// A normalized Model is a borrowed, read-only object graph: callers must not
// mutate it while any runtime, validator, or renderer can still observe it.
// This ownership rule includes nested arrays, Maps/Sets, and typed buffers.

type TypedArrayMutator = "copyWithin" | "fill" | "reverse" | "set" | "sort";

/** A typed-array view with writes, in-place mutators, and backing-store access omitted. */
type ReadonlyTypedArray<T extends Float64Array | Uint32Array> = Omit<
  T,
  number | TypedArrayMutator | "buffer" | "subarray"
> & {
  readonly [index: number]: number;
  subarray(begin?: number, end?: number): ReadonlyTypedArray<T>;
};

export type ReadonlyFloat64Array = ReadonlyTypedArray<Float64Array>;
export type ReadonlyUint32Array = ReadonlyTypedArray<Uint32Array>;

export interface CanvasInfo {
  readonly width: number;
  readonly height: number;
  /** Model origin in canvas pixels (§4): model space places (0,0) here. */
  readonly origin: readonly [number, number];
}

export interface ParamDef {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  /** Wrap modulo [min, max) instead of clamping (§6). */
  readonly wrap: boolean;
}

export type BlendMode = "normal" | "additive" | "multiply";
export type MaskMode = "alpha" | "inverted";

export interface MaskSpec {
  readonly mode: MaskMode;
  /** Resolved mask source sprites (§8.4). */
  readonly sources: ReadonlyArray<SpriteNode>;
}

export type MeshSpec =
  | { readonly type: "grid"; readonly cols: number; readonly rows: number }
  | {
      readonly type: "explicit";
      readonly points: ReadonlyArray<readonly [number, number]>;
      readonly tris: ReadonlyArray<readonly [number, number, number]>;
    };

interface NodeBase {
  readonly id: string;
  readonly parent: GroupNode | WarpNode | RotatorNode | null;
  /** Depth-first pre-order index over the whole tree (document order, §8.1). */
  readonly order: number;
}

export interface GroupNode extends NodeBase {
  readonly type: "group";
  readonly opacity: number;
  readonly children: ReadonlyArray<AnyNode>;
}

export interface SpriteNode extends NodeBase {
  readonly type: "sprite";
  /** [x, y, w, h] in model space (§5.3). */
  readonly rect: readonly [number, number, number, number];
  readonly texture: string;
  readonly z: number;
  readonly opacity: number;
  readonly blend: BlendMode;
  readonly mesh: MeshSpec;
  readonly mask: MaskSpec | null;
  /** Index among sprites in document order (§8.1 step 6 tie-break). */
  readonly spriteOrder: number;
}

export interface WarpNode extends NodeBase {
  readonly type: "warp";
  readonly rect: readonly [number, number, number, number];
  readonly cols: number;
  readonly rows: number;
  readonly children: ReadonlyArray<AnyNode>;
}

export interface RotatorNode extends NodeBase {
  readonly type: "rotator";
  readonly pivot: readonly [number, number];
  readonly angle: number;
  readonly scale: number;
  readonly children: ReadonlyArray<AnyNode>;
}

export type AnyNode = GroupNode | SpriteNode | WarpNode | RotatorNode;
export type NodeType = AnyNode["type"];

export type BindableProperty =
  "angle" | "scale" | "pivot_offset" | "opacity" | "z" | "offset" | "verts" | "grid";

/** Additive properties sum; factor properties multiply (§7 rule 5). */
export type PropertyClass = "additive" | "factor";

export interface Binding {
  readonly target: AnyNode;
  readonly property: BindableProperty;
  readonly params: ReadonlyArray<ParamDef>;
  /** One strictly-increasing key array per param (§7 rule 1). */
  readonly axes: ReadonlyArray<ReadonlyArray<number>>;
  /**
   * Flat entry scalars for every Cartesian-product point, row-major with the
   * first param slowest (§7 rule 2). Entry `i` begins at `i * arity`.
   */
  readonly values: ReadonlyFloat64Array;
  /** Scalars per value entry: 1 (scalar), 2 ([dx,dy]) or 2·n (grid/verts). */
  readonly arity: number;
  readonly kind: PropertyClass;
}

export interface ExpressionParamEntry {
  readonly id: string;
  readonly value: number;
  readonly blend: "add" | "multiply" | "overwrite";
}

export interface ExpressionDef {
  readonly id: string;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly params: ReadonlyArray<ExpressionParamEntry>;
}

export type MotionEase =
  | { readonly type: "linear" }
  | { readonly type: "step" }
  | { readonly type: "bezier"; readonly cp: readonly [number, number, number, number] };

export interface MotionKey {
  readonly t: number;
  readonly v: number;
  /** Easing of the segment ending at this key (§10.2). */
  readonly ease: MotionEase;
}

export interface MotionTrack {
  readonly param: string;
  readonly keys: ReadonlyArray<MotionKey>;
}

export interface MotionDef {
  readonly id: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly tracks: ReadonlyArray<MotionTrack>;
}

export interface PhysicsInput {
  readonly param: string;
  readonly type: "x" | "y" | "angle";
  readonly weight: number;
}

export interface PhysicsLink {
  readonly length: number;
  readonly damping: number;
  readonly stiffness: number;
}

export interface PhysicsOutput {
  /** 0-based index into the chain's links. */
  readonly link: number;
  readonly param: string;
  readonly multiplier: number;
  readonly blend: "overwrite" | "add";
}

export interface PhysicsChain {
  readonly id: string;
  readonly inputs: ReadonlyArray<PhysicsInput>;
  readonly links: ReadonlyArray<PhysicsLink>;
  readonly gravity: readonly [number, number];
  readonly wind: readonly [number, number];
  readonly outputs: ReadonlyArray<PhysicsOutput>;
}

export interface PhysicsDef {
  readonly fps: number;
  readonly chains: ReadonlyArray<PhysicsChain>;
}

export interface VariantOption {
  readonly id: string;
  readonly nodes: ReadonlyArray<AnyNode>;
}

export interface VariantSlot {
  readonly id: string;
  readonly default: string;
  readonly options: ReadonlyArray<VariantOption>;
}

export interface AtlasDef {
  readonly image: string;
  readonly rects: ReadonlyMap<string, readonly [number, number, number, number]>;
}

export interface Model {
  readonly specVersion: { readonly major: number; readonly minor: number };
  readonly id: string;
  readonly name: string | null;
  readonly canvas: CanvasInfo;
  readonly capabilities: ReadonlySet<string>;
  readonly params: ReadonlyArray<ParamDef>;
  readonly paramsById: ReadonlyMap<string, ParamDef>;
  readonly root: GroupNode;
  readonly nodesById: ReadonlyMap<string, AnyNode>;
  /** All sprites in document order. */
  readonly sprites: ReadonlyArray<SpriteNode>;
  readonly bindings: ReadonlyArray<Binding>;
  readonly expressions: ReadonlyArray<ExpressionDef>;
  readonly motions: ReadonlyArray<MotionDef>;
  readonly physics: PhysicsDef | null;
  readonly variantSlots: ReadonlyArray<VariantSlot>;
  readonly atlas: AtlasDef | null;
  /** Non-fatal issues found at load (e.g. higher MINOR version). */
  readonly warnings: ReadonlyArray<string>;
}
