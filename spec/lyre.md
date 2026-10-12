# Lyrical Refrain Specification — 0.1

> **Version 0.1 (2026-10-12).** First release. Versioning going forward follows §15; the version history is this repository's git history. This specification and its reference implementation are public domain under [the Unlicense](../LICENSE).

## 1. Introduction

Lyrical Refrain (Lyre) is an open specification for layered 2D puppet models: layered illustrations (typically authored as PSDs) deformed in real time by a small set of named parameters, suitable for VTubing, visual-novel and game sprites, and interactive characters.

Lyrical Refrain exists because building the *engine* for such models is no longer scarce — modern LLMs can produce one in minutes — but a shared *format* is. Without one, the community fragments into thousands of similar-but-incompatible runtimes. Lyre aims to be the interchange layer: one format, one normative evaluation model, many runtimes.

### 1.1 Goals

1. **Open and complete.** Everything needed to render a model identically is in this document. No opaque binary blobs, no reverse-engineered behavior.
2. **LLM-first authoring.** The format is designed to be *written and edited by language models* as much as by humans: small text files, semantic names, sparse deltas, deterministic derivation of everything bulky.
3. **Ecosystem compatibility.** Parameter semantics deliberately align with widely used face-tracking conventions and ARKit blendshapes so that tracking bridges and avatar hosts are straightforward.
4. **Normative math.** Interpolation, deformer composition, draw order, and physics are specified precisely enough that two independent runtimes produce visually identical output, verified by a conformance suite.

### 1.2 Non-goals

- Replacing raster authoring. Artists still draw layered PSDs; Lyre consumes them.
- 3D, skeletal 3D-in-2D (Spine-style bone meshes), or video formats. (A bone extension may come later; see §15.)
- Specifying a UI or an editor. Lyre assumes rigs may be authored *without* a GUI, by humans or LLMs writing JSON.

### 1.3 LLM-first design principles (informative)

These principles motivated the normative choices below:

- **Derive, don't store.** Meshes are generated deterministically from small declarations (§5.4). Rigs never contain raw triangle soups unless explicitly opted into.
- **Deltas from rest.** All animation data is expressed as offsets from the rest pose. A binding that does nothing is empty, not a copy of the base geometry.
- **Small files, stable IDs.** The container is a directory of focused JSON files. Every entity has a stable, human/LLM-meaningful `snake_case` id.
- **Annotations are first-class.** Any JSON key beginning with `$` is reserved for annotations and MUST be ignored by runtimes. Rigging harnesses SHOULD record rationale in `$note` fields; this materially improves iterative LLM editing.
- **Low-precision friendly.** Runtimes MUST accept finite numbers within the numeric safety requirements of §16; writers SHOULD round to at most 4 decimal places. Nothing in the format depends on high-precision round-tripping.
- **Convention over configuration.** A standard parameter registry (§6.3, Annex A) and a standard PSD layer-naming convention (Annex B) mean a rigging harness can go from PSD to moving model with near-zero questions.

## 2. Conventions and terminology

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, **MAY** are to be interpreted as described in RFC 2119.

- **Model** — the complete deliverable: manifest, rig, assets, and optional physics/expressions/motions.
- **Rig** — the scene graph, parameters, and bindings.
- **Node** — an element of the scene graph: `group`, `sprite`, `warp`, or `rotator`.
- **Parameter** — a named scalar input (e.g. `Lyre.AngleX`) with a declared range and default.
- **Binding** — a mapping from one or more parameters to keyed deltas on a node property.
- **Rest pose** — the model state when every parameter equals its default, every variant slot is at its default option (§10.3), and no physics/motions are active. The rest pose is defined by Lyre's own compositing semantics (§8) applied to the rest scene graph. It SHOULD visually reproduce the source artwork composited with the default options; exact reproduction is guaranteed only when the source respects the fidelity constraints of Annex B (all groups at 100% opacity; layer blend modes limited to those of §8.3).
- **Runtime** — software that loads and renders a Lyre model.
- **Harness** — software (typically LLM-driven) that authors or edits a Lyre model.

**Identifiers.** All ids MUST match `[a-z][a-z0-9_]*` and MUST be unique within their namespace (node ids share one namespace; parameter ids another; etc.). The single exception is the standard parameter registry: a registry parameter id matches `Lyre\.[A-Za-z][A-Za-z0-9]*` — the `Lyre.` prefix followed by a CamelCase name, as in `Lyre.AngleX` — and MUST be one of the ids listed in Annex A (§6). Dots appear in no other id; outside registry ids they are reserved for property paths.

**JSON.** All text files are UTF-8 JSON without comments. Member names MUST be unique within each object after JSON string-escape decoding; a duplicate is a load error, never first- or last-wins. Unknown keys in structural objects MUST be ignored (forward compatibility), except that unknown *node types* and unknown *manifest-listed capabilities* (§3.1, §15) are load errors. Keys beginning with `$` are annotations (§1.3) and MUST be ignored even inside an id-keyed map. Keys beginning with `x_` are vendor extensions only when they occur as members of a structural object; inside an id-keyed map such as `atlas.rects`, an `x_…` key is an ordinary id and its value MUST be processed.

## 3. Container and file layout

A Lyre model is a directory (or a ZIP archive of that directory with the extension `.lyre`). Layout:

```
mymodel.lyre/
  manifest.json          REQUIRED  model metadata, spec version, file index
  rig document           REQUIRED  parameters, scene graph, bindings (`rig.json` by default)
  physics.json           optional  physics chains (§9)
  variants.json          optional  outfit/part variant slots (§10.3)
  expressions/*.exp.json optional  expressions (§10.1)
  motions/*.motion.json  optional  keyframed motions (§10.2)
  textures/<t>.png       REQUIRED  one straight-alpha PNG per referenced texture id <t> (a sprite's `texture` key, defaulting to its node id; sprites MAY share one; premultiplied at load; §3.2)
  atlas.json             optional  packed-atlas index (optimization; §3.2)
  source/                optional  original PSD and provenance
```

### 3.1 manifest.json

```json
{
  "lyre": "0.1",
  "id": "example_v1",
  "name": "Example Model",
  "canvas": { "width": 2048, "height": 3072, "origin": [1024, 1536] },
  "capabilities": ["core", "physics", "motion", "variants"],
  "files": {
    "rig": "rig.json",
    "physics": "physics.json",
    "variants": "variants.json",
    "atlas": "atlas.json",
    "expressions": ["expressions/smile.exp.json"],
    "motions": ["motions/idle.motion.json"]
  },
  "author": "…",
  "$note": "Rigged automatically from source.psd."
}
```

- `lyre` — spec version, `"MAJOR.MINOR"`. Runtimes MUST refuse a higher MAJOR and SHOULD warn on a higher MINOR.
- `canvas` — the pixel dimensions of the source artwork and the model origin (§4).
- `capabilities` — every capability this model uses (§15); entries MUST be distinct. `core` is implied and MAY be listed. If `capabilities` is absent, it defaults to an empty list (and therefore the model still has the implied `core` capability). A runtime lacking (or not recognizing) a listed capability MUST refuse to load the model. A host MAY offer an explicit user override to load anyway, in which case the runtime MUST surface a warning and MUST NOT claim conforming rendering of that model. (Silently degraded rendering is dialect fragmentation by another name; see D.0.2.)
- `files` — the authoritative index of model JSON documents. An absent `files` object is equivalent to an empty one. `rig` is a single path and defaults to `rig.json` when absent. `physics`, `variants`, and `atlas` are single paths; `expressions` and `motions` are arrays of distinct paths, and absent optional entries mean no such document (equivalently, an empty array for `expressions`/`motions`). Optional documents are loaded only when listed here, and every listed path MUST exist and have the corresponding document shape. Shipping `physics`, `variants`, or any motion document without declaring its capability is a load error. Files not listed here are opaque container payload and MUST NOT silently alter model evaluation.

### 3.2 Textures

Each `sprite` node references `textures/<t>.png`, where `<t>` is the sprite's optional `texture` key, defaulting to the node id (§5.3). Multiple sprites MAY share one texture file (mirrored parts, pieces reused across variant outfits); each sprite still places the crop independently via its own `rect`. The explicit `texture` key also decouples asset filenames from node ids, so renaming a node — a routine LLM refactor — is a one-key JSON edit rather than a file move. Per-layer PNGs keep the container LLM-navigable. Harnesses MUST NOT need to read pixel data to edit a rig.

`atlas.json` MAY additionally provide packed-atlas rectangles for the same texture ids; runtimes MAY prefer the atlas, but atlas rendering MUST be indistinguishable from per-file rendering within conformance tolerance (§12). Every rect for a referenced texture MUST have the same dimensions and premultiplied pixels as its per-file PNG; validators MUST compare them. To prevent filtering bleed, packed rects MUST additionally be separated by a gutter of at least 2 texels, and the gutter MUST replicate the rect's edge texels (in premultiplied space) — or the runtime MUST clamp sampling to the rect interior.

```json
{ "image": "atlas.png", "rects": { "hair_back": [2, 2, 100, 90], "iris": [106, 2, 12, 12] } }
```

`image` is a container-relative path to the packed PNG; `rects` maps texture ids to `[x, y, w, h]` texel rectangles inside it. `x` and `y` MUST be non-negative integers, and `w` and `h` MUST be positive integers. A texture id absent from `rects` falls back to its per-file PNG.

PNG is the sole required texture codec (rationale and reopening condition in Annex D.0.5). Runtimes MUST accept the standard static PNG color types (grayscale, truecolor, indexed, grayscale+alpha, and truecolor+alpha), their legal bit depths, `tRNS`, and either non-interlaced or Adam7-interlaced data. Animated-PNG timing is not part of Lyre; the default image is the texture. Color-profile and transfer metadata (`iCCP`, `sRGB`, `gAMA`, `cHRM`) MUST NOT transform samples. Decode to straight RGBA8 by mapping an `n`-bit sample `s` to `floor(s·255/(2ⁿ−1) + 0.5)` (palette samples are already bytes), then premultiply as §8.3.1 defines. Writers SHOULD emit 8-bit truecolor+alpha PNGs for the smallest common implementation path.

Before inflation or decoded-image allocation, runtimes MUST validate the PNG signature and legal chunk structure: exactly one first `IHDR`; at most one legal `PLTE` and `tRNS` in their required order; consecutive `IDAT` chunks; exactly one final `IEND`; legal chunk lengths for the selected color type/bit depth; and the chunk ceilings of §16. Chunk type codes contain four ASCII letters and their reserved third letter MUST be uppercase. The ignored `iCCP`, `sRGB`, `gAMA`, and `cHRM` chunks still MUST have legal cardinality, placement, and framing. Because `iCCP` cannot transform Lyre samples, validators MUST NOT inflate its profile: its framing is a legal 1–79 byte PNG keyword, compression method 0, and a non-empty payload, whose compressed-stream validity and profile semantics are otherwise opaque to Lyre. CRC errors are load errors.

PNGs store straight (non-premultiplied) alpha per the PNG specification. Runtimes MUST premultiply at load time and perform all texture filtering and blending in premultiplied space; filtering straight-alpha textures bleeds transparent-texel color into silhouette edges (dark fringing) and produces nonconforming output.

## 4. Coordinate system and units

- Units are **source pixels** of the declared canvas.
- **+x is right, +y is down**, matching PSD/image space. (Renderers flip internally as needed. This choice minimizes translation errors for harnesses reading PSD layer coordinates.)
- **Model space** places `(0,0)` at `canvas.origin` (conventionally the visual center of the character, around the sternum). All node positions and deformer geometry are in model space unless stated otherwise.
- Angles are in **degrees, positive clockwise** (consistent with +y down).
- Opacity is 0..1.

## 5. The scene graph

`rig.json` top level:

```json
{
  "params": [ … §6 … ],
  "nodes": [ … tree, exactly one root group … ],
  "bindings": [ … §7 … ]
}
```

Nodes form a single tree. Every node has:

| key | type | notes |
|---|---|---|
| `id` | string | unique among nodes |
| `type` | `"group" \| "sprite" \| "warp" \| "rotator"` | |
| `children` | node[] | defaults to `[]`; MUST be absent/empty on `sprite` |
| `$note` | string | ignored by runtimes |

Deformation flows **down** the tree: a node's deformers are those of its ancestors, composed **nearest-ancestor-first** (parent first, root last; §8.1). Sprites are the only nodes that draw.

### 5.1 group

Organizational + shared opacity.

```json
{ "id": "head", "type": "group", "opacity": 1.0, "children": [ … ] }
```

`opacity` is optional and defaults to `1`. Animatable properties: `opacity` (multiplied down the subtree), `z` (real-valued delta added to every descendant sprite before the one global rounding step; a group has no rest `z` of its own). Group `z` deltas let a multi-sprite assembly (an arm, a braid) jump in front of or behind another region with a single binding while preserving its internal layering.

### 5.2 rotator

A rigid transform deformer: rotation and uniform scale about a pivot.

```json
{ "id": "head_rot", "type": "rotator",
  "pivot": [0, -820], "angle": 0, "scale": 1.0, "children": [ … ] }
```

`angle` and `scale` are optional rest values and default to `0` degrees and `1`, respectively. Animatable: `angle` (deg, additive), `scale` (multiplicative), `pivot_offset` `[dx,dy]` (additive translation of the pivot and the whole subtree).

### 5.3 sprite

A drawable referencing one texture.

```json
{ "id": "eye_l_iris", "type": "sprite",
  "rect": [812, 640, 180, 180],
  "z": 340,
  "opacity": 1.0,
  "blend": "normal",
  "mesh": { "type": "grid", "cols": 1, "rows": 1 },
  "mask": { "mode": "alpha", "sources": ["eye_l_white"] }
}
```

- `rect` — `[x, y, w, h]`: where the texture's crop sits on the canvas, in model space (top-left corner + size). The rest-pose mesh spans this rect.
- `texture` — optional; the texture file id (`textures/<texture>.png`). Defaults to the node id. Multiple sprites MAY reference the same texture (§3.2).
- `z` — optional integer draw order, default `0`; higher draws later (on top). Ties are broken by sprite document order: depth-first preorder through each node's `children` array, equivalently the lexical occurrence order of sprite objects in `rig.json`.
- `opacity` — optional rest opacity, default `1`.
- `blend` — optional `"normal" | "additive" | "multiply"`, default `"normal"` (§8.3).
- `mask` — optional clipping (§8.4); when absent, the sprite is not clipped by a mask.

Animatable: `offset` `[dx,dy]`, `opacity`, `z` (delta; accumulated as a real number and rounded once in the global sort, §8.1 step 6), `verts` (per-control-point deltas of its own mesh; §5.4).

### 5.4 Deterministic meshes

A sprite's mesh is derived, never stored:

- `{"type":"grid","cols":C,"rows":R}` — control points at the `(C+1)×(R+1)` uniform grid over `rect`, indexed row-major from the top-left. Cells are emitted in row-major order; each cell emits `(top-left, top-right, bottom-right)` followed by `(top-left, bottom-right, bottom-left)`, splitting it along the ↘ diagonal. Omitting `mesh` or its `type` selects this form, and omitted `cols` or `rows` default to `1`, producing a quad when all three are absent.
- `{"type":"explicit","points":[…],"tris":[…]}` — escape hatch for imported content. Points retain their array order, and triangles retain their `tris` array order. Harnesses SHOULD NOT emit it; Core runtimes MUST load and render it. The `"explicit"` type is never inferred and therefore MUST be present.

Texture coordinates are derived in double precision. A grid point at `(col,row)` has `(u,v) = (col/C,row/R)`. An explicit point `(x,y)` has `(u,v) = ((x−rect.x)/rect.w,(y−rect.y)/rect.h)`; a zero rect dimension maps that coordinate to zero. A model whose explicit-coordinate derivation is non-finite is a load error. Because grid meshes are fully determined by `(rect, cols, rows)`, per-vertex deltas (`verts` bindings) are portable across runtimes. Changing `cols/rows` invalidates `verts` bindings on that sprite; validators MUST flag mismatched delta lengths.

### 5.5 warp

A free-form deformation grid, the workhorse deformer for non-rigid transforms.

```json
{ "id": "hair_front_warp", "type": "warp",
  "rect": [640, 120, 800, 900],
  "cols": 4, "rows": 6,
  "children": [ … ] }
```

Rest control points form the uniform `(cols+1)×(rows+1)` grid over `rect`, row-major from top-left. The rectangle's width and height MUST both be positive. Animatable: `grid` — an array of `(cols+1)×(rows+1)` `[dx,dy]` deltas.

**Mapping (normative).** A point `p` in the warp's rest space with normalized cell coordinates maps through **bilinear interpolation** of the four displaced control points of the cell containing it. Equivalently, and preferably for numerical stability, evaluate `p + bilinear(control-point deltas)`; this preserves an all-zero rest warp as the exact identity. Points outside `rect` are extrapolated by clamping the point's fractional cell indices to the grid's index range and evaluating that cell's bilinear function (diagonally outside a corner this selects the corner cell). Note (informative): bilinear extrapolation of a strongly displaced edge cell can fold space back over itself; keep large deformations away from sprites that overhang the warp's rect. Warps compose with other ancestors nearest-ancestor-first (§8.1).

**Corner-pin idiom (informative).** Rotators are deliberately rigid (rotation + uniform scale only). All non-rigid transforms — non-uniform squash/stretch, shear, perspective-like distortion — are expressed with warps; the degenerate `cols:1, rows:1` warp is a four-corner pin and is the intended replacement for non-uniform scale. Harness recipe: rotation → rotator, everything else → warp.

## 6. Parameters

```json
{ "id": "Lyre.AngleX", "min": -30, "max": 30, "default": 0, "$note": "head yaw" }
```

- `wrap` is optional and defaults to `false`. Runtimes MUST clamp parameter values to `[min, max]` before binding evaluation — unless the parameter declares `"wrap": true`, in which case values wrap modulo `[min, max)` instead. Wrapping is for circular quantities (a spinning pinwheel, a rolling wheel); `Lyre.*` registry parameters MUST NOT declare it.
- `min`, `max`, and `default` MUST satisfy the authored-number ceiling (§16), and `max − min` MUST be finite. A wrapping parameter additionally requires `max > min`.
- Ids beginning `Lyre.` are reserved for the standard registry (Annex A). A `Lyre.`-prefixed id that Annex A does not list is a load error. A listed id MUST declare exactly the registered `min`, `max`, and `default` — any other values are a load error — and MUST carry the registered semantics. Model-specific parameters use unprefixed ids (`hair_ribbon_bounce`).
- A model MUST render its rest pose when all parameters are at `default` and all variant slots are at their default options.

The observable rest-pose value is the result after stage 6 below. In particular, a wrapping parameter whose authored `default` equals `max` has the same rest-pose value as `min`; initial runtime reads, binding evaluation, and rest-pose validation MUST all use that wrapped value consistently.

### 6.1 Value sources and priority

At each frame, a parameter's value is composed in this order (later stages see the result of earlier ones):

1. `default`
2. Active **motions** (§10.2), layered by weight
3. **Host input** (face tracking, sliders, API) — overwrites
4. Active **expressions** (§10.1), applied by their blend mode
5. **Physics outputs** (§9) — applied by chain blend mode
6. Clamp to `[min, max]` (wrap modulo `[min, max)` for wrapping parameters)

Expressions apply **after** host input by design: an expression hotkey (a wink, a smile) must beat live face tracking on the parameters it touches, or expressions would be inert precisely when tracking runs (rationale: D.8). The ordering encodes intent priority — ambient motions lowest, live capture above them, deliberate expressions above capture, derived physics last. A host that wants tracking back simply deactivates the expression.

### 6.2 Smoothing

Runtimes SHOULD offer critically-damped smoothing of host inputs but MUST NOT apply hidden smoothing to motion/expression/physics outputs; determinism of stages 1–2 and 4–5 is required for conformance testing.

### 6.3 Standard registry

Annex A defines the `Lyre.*` registry and an informative ARKit mapping so existing tracking pipelines port mechanically.

## 7. Bindings

A binding maps 1–3 parameters to deltas on one animatable property of one node.

```json
{
  "target": "head_rot", "property": "angle",
  "params": ["Lyre.AngleX"],
  "axes": [[-30, 0, 30]],
  "values": [-22, 0, 22],
  "$note": "head yaw follows AngleX nearly 1:1"
}
```

Multi-parameter binding grid:

```json
{
  "target": "face_warp", "property": "grid",
  "params": ["Lyre.AngleX", "Lyre.AngleY"],
  "axes": [[-30, 0, 30], [-30, 0, 30]],
  "values": [ g00, g01, g02, g10, "…row-major over axes[0] × axes[1]…" ]
}
```

Rules (normative):

1. A binding's `params` entries MUST be distinct. `axes[i]` MUST be strictly increasing, every adjacent and total key span MUST be finite, and it SHOULD include the parameter's stage-6 default. For a wrapping parameter every key MUST lie in `[min, max)`; `max` is the same modulo point as `min` and MUST NOT appear as a distinct key.
2. `values` has one entry per point of the Cartesian product of the axes, row-major with the **first** parameter as the slowest-varying index. Each entry's shape matches the property: scalar for `angle`/`opacity`/`scale`/`z`, `[dx,dy]` for `offset`/`pivot_offset`, array of `[dx,dy]` for `grid`/`verts`.
3. **Interpolation is multilinear** (linear per axis, composed). Outside the axis range, the boundary value is held (clamp) — except on a wrapping parameter's axis, where the interval past the last key wraps around to the first key, interpolating across the seam. Runtimes MUST NOT smooth or ease binding interpolation; easing belongs in motions.
4. All values are **deltas from rest**, except: `opacity` and `scale` entries are **factors** (rest = 1).
5. Multiple bindings on the same `(target, property)` combine per property class: additive properties **sum**; factor properties **multiply**. Combination is performed independently for every evaluated scalar component, using the following binary64 order so permuting the binding array cannot change rounding, overflow, or underflow behavior:
   - For an additive component, sort contributions by descending absolute value, then ascending numeric value, with `−0` before `+0`. Apply Neumaier summation in that order: start `s = c = 0`; for each `x`, set `t = s + x`, then `c += |s| ≥ |x| ? (s − t) + x : (x − t) + s`, then `s = t`; the result is `s + c`.
   - For a factor component, first retain the parity of every negative sign (including `−0`). Any zero magnitude makes the unsigned result zero. Otherwise omit unit magnitudes, sort the remaining positive magnitudes descending, and consume them largest, smallest, next-largest, next-smallest, and so on. Decompose each exactly as `x = mₓ·2ᵉˣ`, `0.5 ≤ mₓ < 1`; start `m = 1, e = 0`, then for each factor set `m = m·mₓ`, `e = e + eₓ`, and, when `m < 0.5`, set `m = 2m, e = e − 1`. Scale `m·2ᵉ` only after the last factor using a range-safe binary64 scale operation, then apply the retained sign. This avoids a non-representable intermediate when the final product is representable.

   Every arithmetic operation above rounds to IEEE-754 binary64 in the written order; a non-finite final result is an evaluation error. After all bindings combine, effective `opacity` is clamped to `[0, 1]` — once, at the end; individual factors MAY exceed 1 (e.g. to raise a sub-unit rest opacity toward full). The §16 binding and value-scalar ceilings bound the temporary contribution storage and canonical-sort work.
6. A validator MUST reject bindings whose value shapes don't match the target (e.g., wrong grid length).
7. A binding whose target node is excluded by the active variant selection (§10.3) evaluates to nothing; this is not an error.

**Why deltas (informative).** Deltas make the empty binding a no-op, keep files sparse, make `git diff` meaningful, and let an LLM reason locally ("push these four points down 30px when the mouth opens") without restating untouched geometry.

## 8. Evaluation and rendering

### 8.1 Per-frame pipeline (normative order)

1. Compose parameter values (§6.1).
2. Evaluate all bindings; accumulate deltas/factors per `(node, property)`.
3. Resolve node state: rest + accumulated deltas (or × factors).
4. Transform geometry: for each sprite, take its rest mesh points, apply its own `verts` then `offset`, then apply ancestor deformers **innermost-first** — nearest ancestor first, root last. Formally, with ancestors `A1 (root-side) … Ak (parent)`, the world position of point `p` is `A1(A2(…Ak(p_local)…))`.
5. Compute effective opacity per sprite: accumulate ancestor `opacity` values from the root toward the parent starting at 1, then multiply the sprite's own opacity by that ancestor product. This grouping defines the reference double-precision result.
6. Sort **all sprites in one flat, global pass** by effective `z` = sprite rest `z` + its own `z` delta + the sum of all ancestor group `z` deltas. For the reference double-precision grouping, accumulate the ancestor sum from the root toward the parent starting at 0, evaluate `sprite rest z + own z delta`, then add the ancestor sum. Round the total once to the nearest integer, with an exact half-integer rounded toward positive infinity: `zᵢ = floor(z + 0.5)` (so `0.5 → 1` and `−0.5 → 0`). Ties are broken by document order. There are no hierarchical sorting scopes: cross-group interleaving is permitted by design.
7. Render into the model surface with blending and masks (§8.3–8.4).

### 8.2 Rotator math

With rest pivot `c₀`, accumulated `pivot_offset` translation `t`, angle `θ`, and scale `s`:
`f(p) = c₀ + t + s · R(θ) · (p − c₀)`, where `R` is the clockwise rotation matrix (+y down). Thus `f(c₀) = c₀ + t`: `pivot_offset` moves the deformed pivot and translates every child by `t`, including when `θ = 0` and `s = 1`. It does not replace `c₀` inside `(p − c₀)`.
When `θ = 0` and `s = 1`, runtimes MUST evaluate the equivalent `f(p) = p + t` directly, preserving `t = 0` as the exact binary64 identity even when `c₀` is far from `p`.

### 8.3 The model surface and blending

Rendering is defined against a canonical **model surface**: an extended-premultiplied-alpha RGBA buffer at canvas resolution, cleared to `(0,0,0,0)`. "Extended" means additive blending MAY produce RGB greater than alpha, including nonzero RGB at zero alpha; hosts MUST preserve those components rather than enforce `rgb ≤ a`. Sprites are drawn into the surface in sorted order; the finished surface is the model's output, which hosts composite over their own background with standard premultiplied `over`. Conformance goldens are raw RGBA8 readbacks of this surface under §8.3.1, without a host background, making them background-independent.

An RGBA8 readback is a conformance/debug artifact, not the host-compositing handoff: it clamps extended components. A backend MUST expose or directly composite its unquantized extended surface for host presentation (for example, the reference CPU renderer's float buffer or the WebGL renderer's float texture).

#### 8.3.1 Canonical rasterization

The following rules are normative. They define the reference result; implementations MAY use a GPU, lower-precision intermediates, or other algorithms when their final RGBA8 surface remains within the §12 conformance tolerance.

1. PNG channel bytes are treated as numeric values exactly as stored; no sRGB/linear conversion, dithering, or other color management is applied. Convert each straight-alpha color byte `C` and alpha byte `A` to a premultiplied byte `Cₚ = floor((C·A + 127)/255)`; preserve `A`. All later filtering and blending is premultiplied.
2. Process a sprite's triangles in the mesh order defined by §5.4; if deformation makes triangles overlap, fragments blend in that order. Canvas pixel `(x,y)` is sampled once at its center `(x+0.5,y+0.5)`; there is no multisample antialiasing. Define the directed-edge function `E(a,b,p) = (bₓ−aₓ)(pᵧ−aᵧ) − (bᵧ−aᵧ)(pₓ−aₓ)`. For each triangle, swap its second and third vertices when its signed area is negative, so its three edge functions have positive interior; this normalization does not change the triangle's position in mesh order. An exactly zero-area triangle emits no fragments; triangles are otherwise never culled, including after a deformer flips them.
3. A sample is covered when all three edge functions are positive. An edge where `E = 0` is covered only when its directed endpoints satisfy `(aᵧ = bᵧ and bₓ > aₓ) or (aᵧ ≠ bᵧ and bᵧ < aᵧ)`. This is the top-left rule in Lyre's +y-down coordinates and makes a shared mesh edge rasterize exactly once.
4. Interpolate normalized `u,v` affinely from the three vertex values using edge-function barycentric weights; there is no perspective correction. Let the selected texture crop be the positive integer texel rectangle `[rₓ,rᵧ,r_w,r_h]` (the whole per-file image when no atlas crop is selected). First clamp each finite interpolated coordinate to `[0,1]`, then map to texel-center coordinates `tₓ = rₓ + u·r_w − 0.5`, `tᵧ = rᵧ + v·r_h − 0.5`. Set `x₀=floor(tₓ)`, `y₀=floor(tᵧ)`, `fₓ=tₓ−x₀`, and `fᵧ=tᵧ−y₀`; bilinearly sample the four indices `(x₀,y₀)`, `(x₀+1,y₀)`, `(x₀,y₀+1)`, `(x₀+1,y₀+1)` with weights `(1−fₓ)(1−fᵧ)`, `fₓ(1−fᵧ)`, `(1−fₓ)fᵧ`, `fₓfᵧ`. Clamp each index independently to the crop's inclusive texel bounds before fetching, without changing `fₓ,fᵧ`. Apply this rule independently to all four premultiplied RGBA channels.
5. Evaluate mask coverage and the blend equations below without intermediate RGBA8 quantization. The reference renderer uses IEEE-754 double precision. At final readback only, convert every premultiplied surface component `v` to `clamp(floor(255·v + 0.5), 0, 255)`.

#### 8.3.2 Blending

All equations below are in **premultiplied space**. `src` is the sprite's fragment after texture sampling, tinted by effective opacity `o`: `src.rgba = sample.rgba · o` (a single multiply, since the sample is already premultiplied — §3.2).

- `normal`:   `out.rgba = src.rgba + dst.rgba · (1 − src.a)`
- `additive`: `out.rgb = dst.rgb + src.rgb` ; `out.a = dst.a`
- `multiply`: `out.rgb = dst.rgb · (src.rgb + (1 − src.a))` ; `out.a = dst.a`

Only `normal` contributes alpha coverage: `additive` and `multiply` leave destination alpha unchanged. A multiply fragment over `(0,0,0,0)` is a no-op. An additive fragment over `(0,0,0,0)` instead leaves emissive `(src.rgb,0)` in the extended-premultiplied model surface; standard premultiplied `over` subsequently adds that RGB to the host background, so the glow remains visible despite contributing no alpha. Hosts MUST NOT convert the model surface through straight alpha, because RGB at zero alpha has no straight-alpha representation. These fixed-function equations preserve familiar rigger intuition about blush (multiply) and glow (additive) layers.

**Fixed-function mapping (informative).** Each blend equation is one `blendFuncSeparate` call and needs no advanced-blending extension. Preserving the extended target may still require an ordinary float-render-target/blend extension on APIs such as WebGL.

| mode | RGB factors (src, dst) | A factors (src, dst) |
|---|---|---|
| normal | `ONE, ONE_MINUS_SRC_ALPHA` | `ONE, ONE_MINUS_SRC_ALPHA` |
| additive | `ONE, ONE` | `ZERO, ONE` |
| multiply | `DST_COLOR, ONE_MINUS_SRC_ALPHA` | `ZERO, ONE` |

**Compatibility halo (informative).** A soft `normal`-blended halo beneath an additive glow gives that region ordinary alpha coverage. It is useful when exporting through a nonconforming system that cannot preserve emissive RGB at zero alpha, but it also changes how the host background is attenuated; conforming Lyre hosts do not require this workaround.

### 8.4 Masks

`mask.sources` is a non-empty list of distinct sprite ids whose combined alpha clips this sprite. The combined mask value at a pixel is `m = 1 − ∏ᵢ(1 − aᵢ)` over all active sources — the mathematical coverage union of their alphas. For the reference binary64 evaluation, active sources are processed by ascending id (ASCII/code-point order), making authored source order immaterial. `mode:"alpha"` multiplies the clipped sprite's premultiplied fragment by `m`; `"inverted"` multiplies by `1 − m`.

Mask evaluation uses each source's **deformed geometry and raw texture alpha only**: the source's opacity — its own or inherited — does **not** affect its mask contribution. Setting a mask source's opacity to 0 is the standard idiom for an invisible sprite that still clips; at nonzero opacity the source also draws normally as a sprite. A source excluded by the active variant selection (§10.3) contributes nothing to the union (the validator warns about this configuration, §12). Mask chains MUST NOT be recursive.

## 9. Physics (capability `physics`)

Deterministic pendulum chains: parameters in, parameters out. `physics.json`:

```json
{
  "fps": 60,
  "chains": [{
    "id": "hair_back",
    "inputs": [
      { "param": "Lyre.AngleX", "type": "x", "weight": 10 },
      { "param": "Lyre.AngleZ", "type": "angle", "weight": 0.6 }
    ],
    "links": [
      { "length": 120, "damping": 0.10, "stiffness": 0.06 },
      { "length": 140, "damping": 0.12, "stiffness": 0.03 }
    ],
    "gravity": [0, 900], "wind": [0, 0],
    "outputs": [
      { "link": 0, "param": "hair_back_sway1", "multiplier": 1.0, "blend": "overwrite" },
      { "link": 1, "param": "hair_back_sway2", "multiplier": 1.2, "blend": "overwrite" }
    ]
  }]
}
```

**Units and defaults.** `gravity` and `wind` are accelerations in canvas pixels/s²; the conventional gravity is `[0, 900]` (+y is down). Both are optional and default to `[0, 0]`. Link `length` is in canvas pixels. An output's optional `multiplier` defaults to `1`, and its optional `blend` defaults to `"overwrite"`.

**Simulation (normative).** Fixed timestep `dt = 1/fps` with an accumulator; runtimes SHOULD interpolate rendering between steps (conformance runs use whole steps only). Simulation MUST be carried out in IEEE-754 double precision — the state is a few dozen scalars per chain, so the cost is negligible, and cross-implementation agreement within the tolerance below is otherwise unattainable. Per chain:

`1/fps` and `(1/fps)²` MUST be finite. To count completed steps from an accumulated duration `A`, compute `q = A/(1/fps)` in binary64. Let `n` be the nearest integer to `q`; if `|q−n| ≤ 8·ε·max(1, |q|, |n|)`, where `ε = 2⁻⁵²`, replace `q` with `n`, then take `floor(q)`. This narrow boundary convention admits binary64 division noise without turning a materially incomplete interval into a completed step: for example, `fps = 0.99999999995` over 10 seconds still produces `floor(9.9999999995) = 9` steps. Motion and expression clocks advance chronologically to each fixed-step boundary, and the stage-1–4 inputs are sampled at that boundary. Consequently one accepted `update(N/fps)` from an empty accumulator MUST produce the same step sequence as `N` accepted calls to `update(1/fps)`. The update work ceilings in §16 are preflight checks: a call that exceeds either ceiling MUST throw before changing the accumulator, physics state, motion clocks, or expression fades.

- `normalized(param)` first holds an out-of-range stage-4 value at the nearest declared boundary, then maps it piecewise-linearly with the **default at zero**: `[min, default] → [−1, 0]` and `[default, max] → [0, 1]` (a degenerate half-interval maps to 0). This guarantees the rest pose exerts no input displacement even for asymmetric ranges like `0..1` and keeps any finite host input bounded for physics.
- The **anchor** `p₀` sits at the model origin displaced by inputs. Starting with zero x displacement, zero y displacement, and `φ = 0`, process inputs in their document-array order using binary64 addition: each input of `type:"x"|"y"` adds `weight · normalized(param)` pixels on that axis; each `type:"angle"` input adds `weight · normalized(param) · 30°` to `φ`.
- Rest direction `d̂(φ)` of every link is `(0,1)` (straight down) rotated by `φ`. The **rest chain** from the current anchor is `r₀ = p₀`, `rᵢ = rᵢ₋₁ + lengthᵢ · d̂(φ)` — a function of the anchor and `φ` alone, never of current link positions.
- **Initialization (and reset):** at load, `pᵢ = qᵢ = rᵢ` evaluated at the then-current parameter values; velocities are therefore zero.
- Each link `i ≥ 1` keeps position `pᵢ` and previous position `qᵢ`. Per step:
  1. Verlet: `v = (pᵢ − qᵢ)·(1 − dampingᵢ)`; `qᵢ = pᵢ`; `pᵢ += v + (gravity + wind)·dt²`.
  2. Stiffness: `pᵢ = lerp(pᵢ, rᵢ, stiffnessᵢ)` with `rᵢ` from the rest chain above.
  3. Constraint, root→tip, one iteration: `pᵢ = pᵢ₋₁ + lengthᵢ · normalize(pᵢ − pᵢ₋₁)`; if `pᵢ = pᵢ₋₁` exactly, the direction is taken as `d̂(φ)`.
- **Output** of link `i`: the signed angle (degrees) between `(pᵢ − pᵢ₋₁)` and `d̂(φ)`.
- **Output composition is by target parameter, not file order.** A target MAY receive any number of `add` outputs but MUST receive at most one `overwrite` output across the entire model; loaders MUST reject a second overwrite. The overwrite contribution, when present, is `parameter default + angle · multiplier` and replaces the stage-4 value as the base. Every `add` contribution is `angle · multiplier`; all are summed onto that base. For bitwise-deterministic accumulation, add contributions are ordered by chain id lexicographically, then link index ascending, then multiplier ascending; entries with the same three keys have the same numeric contribution and need no further ordering. Stage 6 then clamps or wraps the composed result (§6.1).

Conformance: a scripted run covers exactly 10 simulated seconds, and inputs are sampled once per simulation step; every link output MUST match the reference trace within ±0.1° **at every completed fixed-step boundary** in that interval. A harness computes outer scripting endpoints from integer indices as `k/script_fps`, rather than repeatedly adding or subtracting `1/script_fps`, so the final endpoint is the declared duration even at a non-integral cadence. It MUST record internal boundaries even when that cadence differs from `physics.fps`, yielding the boundary-adjusted fixed-step count defined above for `A = 10` (ordinarily `floor(10·physics.fps)`; only raw binary64 results within the specified eight-ULP window are snapped) for every traced chain. A selective trace list MUST be non-empty, contain only unique known chain ids, and may omit a chain only when §10.3 rule 5 permits skipping it in every variant state reached by the script. (A per-step trace comparison, not an endpoint check: dissipative chains cannot hide transient divergence.)

Physics outputs SHOULD target model-specific parameters that ordinary bindings then consume (as in the example) — this keeps simulation and deformation decoupled and lets a harness test deformation by scrubbing the sway parameter directly.

## 10. Expressions, motions, and variants

### 10.1 Expressions (capability `core`)

```json
{ "id": "smile", "fade_in": 0.3, "fade_out": 0.3,
  "params": [
    { "id": "Lyre.MouthForm", "value": 1.0, "blend": "overwrite" },
    { "id": "Lyre.EyeLOpen", "value": 0.2, "blend": "multiply" }
  ] }
```

`blend`: `add` | `multiply` | `overwrite`. Within one expression, `params` entries MUST target distinct parameter ids; a repeated target is a load error. An expression applies at a weight `w ∈ [0, 1]` (0 fully out, 1 fully in), defined per mode: `overwrite` → `v ← lerp(v, value, w)`; `add` → `v ← v + w · value`; `multiply` → `v ← v · lerp(1, value, w)`. At `w = 0` every mode is exactly a no-op. When several expressions are active they apply in first-activation order; re-activating an already-active expression keeps its position. A completed `setExpression(id, false)` deactivation removes that activation, so a later activation appends after expressions that remained active. `fade_in` and `fade_out` are optional and independently default to `0`; fades animate `w` linearly at `1/fade_in` or `1/fade_out` weight units per second. Reversing a fade starts from its current weight, so reaching the opposite endpoint takes the corresponding duration multiplied by the remaining weight distance. Hosts MAY also hold an expression at any constant weight directly (`setExpressionWeight`, §11), which cancels any in-progress fade; a held weight of zero retains its activation position — e.g. `w = 0.5` blends live tracking and a held expression half-and-half, since stage-4 application at fractional weight reads through to the stage-3 host value beneath it (§6.1).

### 10.2 Motions (capability `motion`)

```json
{ "id": "idle", "duration": 4.0, "loop": true,
  "tracks": [{
    "param": "Lyre.Breath",
    "keys": [
      { "t": 0.0, "v": 0.0 },
      { "t": 2.0, "v": 1.0, "ease": "bezier", "cp": [0.4, 0.0, 0.6, 1.0] },
      { "t": 4.0, "v": 0.0, "ease": "bezier", "cp": [0.4, 0.0, 0.6, 1.0] }
    ]
  }]
}
```

- A key's `ease` describes the segment **ending** at that key: `linear` (default), `step`, or `bezier` with CSS-style control points `[x1,y1,x2,y2]` in normalized segment space (x = time). `x1` and `x2` MUST lie in `[0, 1]` so the curve is a function of time; validators MUST reject control points outside that range. Bezier x(t) is solved to within 1e-4.
- Tracks within one motion MUST target distinct parameter ids; a repeated target is a load error.
- `loop` is optional and defaults to `false`. Each active motion has a host-assigned weight `w ∈ [0, 1]` (default 1). Active motions apply **in the order they were started**: for every parameter a motion's tracks target, `value ← lerp(value, track_value, w)`. A single full-weight motion overwrites; fractional weights blend toward the motion; later-started motions layer over earlier ones. No normalization, no tie rule — the recursion is fully determined by start order. A looping motion wraps `t` modulo `duration`; a non-looping motion clamps `t` to `duration`, holding its final keyed values until stopped.

### 10.3 Variants (capability `variants`)

Declarative outfit/part sets for models with alternative costumes, hairstyles, or accessories (typical of visual-novel sprites). `variants.json`:

```json
{
  "slots": [
    { "id": "outfit", "default": "school",
      "options": [
        { "id": "school", "nodes": ["outfit_school"] },
        { "id": "casual", "nodes": ["outfit_casual"] }
      ] },
    { "id": "glasses", "default": "none",
      "options": [
        { "id": "none",  "nodes": [] },
        { "id": "round", "nodes": ["glasses_round"] }
      ] }
  ]
}
```

Semantics (normative):

1. Exactly one option per slot is **active** at any time; initially the slot's `default`.
2. A node listed by any option **exists only while a listing option is active**: excluded nodes (and their subtrees) are not evaluated, not rendered, and their textures need not be loaded. Nodes listed by no option are unaffected.
3. A node id MAY appear in multiple options of the *same* slot (shared pieces, e.g. a collar common to two outfits) but MUST NOT appear under two different slots.
4. Switching is instantaneous and takes effect at the start of the next frame's pipeline (§8.1); hosts wanting fades implement them host-side.
5. Runtimes MAY skip simulating a physics chain whose outputs are consumed only by bindings targeting excluded nodes.

Variants are deliberately *not* animatable: no parameter or expression can change a slot. This is what allows runtimes to treat inactive options as unloaded. (Contrast with the opacity-toggle convention, which forces every texture resident.)

## 11. Host integration (input-domain rules normative; other text informative)

A tracking host maps face capture to `Lyre.*` parameters (Annex A gives the ARKit mapping). Hosts SHOULD write host input at stage 3 (§6.1) and leave physics-target parameters alone. Held expressions override tracked parameters by design (§6.1, D.8); toggle the expression off to return them to tracking, or hold it at a fractional weight (§10.1) to blend the two.

**Input domain (normative).** Host-supplied parameter values, weights, and elapsed times MUST be finite; `update(dt)` requires `dt ≥ 0`, and `update(0)` is an exact no-op. Motion clocks MUST remain bounded (looping motions retain only their phase; non-looping motions clamp at `duration`) so repeated finite updates cannot overflow time. Evaluation that would produce a non-finite intermediate is an error, never a partially rendered frame.

**Audio lipsync (informative).** Because the registry is normative, no per-model routing declaration is needed: hosts drive `Lyre.MouthOpen` directly. The field-standard baseline is audio RMS amplitude with attack/release smoothing mapped to 0..1; hosts MAY additionally drive `Lyre.MouthForm` from spectral or viseme analysis. Viseme sophistication is entirely a host concern; the format never sees it.

**Minimal host API surface (informative):** `load(model)`, `setParam(id, v)`, `listSlots()`, `setVariant(slot, option)`, `playMotion(id, weight = 1)`, `setMotionWeight(id, w)`, `stopMotion(id)`, `setExpression(id, active)`, `setExpressionWeight(id, w)`, `update(dt)`, `render(target)`, `hitTest(x, y) → sprite ids` (point-in-deformed-triangle; texture alpha is ignored, so transparent texels still hit).

## 12. Validation

The reference implementation ships `lyre-validate`:

- Schema validation (published JSON Schema per file type).
- Resource-limit checks (§16): models exceeding any normative ceiling are rejected.
- Referential integrity (ids, mask sources, binding targets, texture files, variant node references).
- Variant rules: option ids unique per slot, `default` exists, no node under two different slots (§10.3 rule 3); performs a bounded, best-effort search for jointly feasible slot selections that exclude a mask source while its clipped sprite remains active, and emits an explicit truncation warning if the candidate-selection or report budget is exhausted.
- Shape checks (grid/verts delta lengths vs. mesh declarations).
- Draw-order lints: warn when a sprite carries a `z` binding on the same parameter as an ancestor group (likely stale/conflicting), and conservatively flag pairs whose rounded effective-`z` ranges overlap. The latter is a bounded, best-effort possible-tie warning, not a proof that one correlated parameter assignment reaches the tie: constant or provably identical functions are skipped, candidate-pair and report work is capped, and the validator emits an explicit truncation warning when it stops early.
- Rest-pose check: the all-defaults render (parameters and variant slots) equals a reference composite of the exported layers under §8.3 semantics, with the same tolerance as the conformance renders below (±2/255 on ≥99.9% of pixels plus the 8-connected catastrophic-region guard). Divergence of that reference composite from the original PSD render (group opacity, exotic blend modes) is the importer's to warn about (Annex B), not the runtime's to absorb.
- Conformance renders: a corpus of models + scripted parameter timelines, compared as raw RGBA8 readbacks of the extended-premultiplied model surface (§8.3.1) against goldens. At least 99.9% of pixels MUST differ by no more than ±2/255 in every channel. Mark a pixel catastrophic when any channel differs by more than 16/255; no 8-connected region of catastrophic pixels (edge or corner adjacency) may contain more than 8 pixels. The second guard prevents a small but visually important feature from being arbitrarily wrong while tolerating isolated raster-edge disagreements. The corpus also carries golden physics traces (±0.1°). A physics scenario is admitted to the suite only if it is numerically stable: rerunning the reference with initial link positions perturbed by 1e-9 px must keep every output within 10% of the conformance tolerance across the full trace. Chaotic configurations are thereby excluded by construction, so the tolerance tests implementations, not sensitivity to initial conditions.

Harnesses SHOULD run the validator after every edit; its errors are designed to be actionable by an LLM (they name the offending id and the expected shape).

`lyre-validate stats <model-or-corpus>...` reports the maximum observed value of every §16 quantity for one or more models or a corpus; `lyre-validate --stats ...` is an equivalent convenience spelling. The reference repository publishes these statistics for the conformance corpus alongside the ceilings, keeping §16 anchored to measured practice rather than anecdote.

## 13. Conformance levels

| Level | Requires |
|---|---|
| **Lyre/Core** | Container, params, scene graph, bindings, rendering (§3–8), expressions |
| **Lyre/Physics** | §9 |
| **Lyre/Motion** | §10.2 |
| **Lyre/Tracking** | §11 host behavior + Annex A mapping |
| **Lyre/Variants** | §10.3 |

A runtime states the levels it implements; a model states only model-side capabilities it uses (§3.1). Lyre/Tracking is a host conformance level, not a manifest capability.

## 14. Reference implementation (informative)

- `@refrain-lyre/core` — TypeScript, dependency-free evaluation (params → deformed geometry), usable headless in Node for testing.
- `@refrain-lyre/render-soft` — CPU reference rasterizer; produces the conformance goldens (no GPU in the golden path).
- `@refrain-lyre/render-webgl` — WebGL2 renderer, verified against the CPU goldens in headless Chromium.
- `lyre-validate` — validator + conformance runner.
- A second, independent physics implementation in Python (`conformance/python/`) backing the §9 tolerance.
- `lyre-import-psd` — PSD → container scaffold (layers → sprites, naming convention → tree; Annex B). *Not yet implemented.*
- An independently versioned **LLM skill** ("lyre-rigging") packaging Annex B–C workflows for
  harnesses, maintained at [`refrainmoe/lyre-skill`](https://github.com/refrainmoe/lyre-skill).

## 15. Versioning and extensions

- Spec versions `MAJOR.MINOR`; MINOR additions are backward compatible (new optional keys, new capabilities).
- New functionality ships as a named **capability**; models list what they use, and runtimes refuse unknown capabilities (§3.1). Reserved capability names with pre-planned shapes: `bones` (D.4), `tint` (D.9, drafted in Annex E), `textures-jxl` (D.0.5), `z_atomic` (D.2).
- Vendor-extension members of structural objects use `x_` keys and are ignored by conforming runtimes. Inside an id-keyed map, `x_…` remains an ordinary id and MUST be processed (§2).

## 16. Resource and security limits (normative)

An interchange format read by many independent runtimes is an attack and denial-of-service surface, and Lyre's small declarations (§5.4) expand into large allocations by design — a two-integer grid declaration is also a two-integer memory bomb if unbounded.

**Container safety.** ZIP entries and every path in `manifest.files` MUST be relative, MUST NOT contain `..` segments or absolute/drive prefixes, and MUST resolve inside the container root; symlink entries MUST be ignored or rejected, and duplicate ZIP file paths MUST be rejected. Runtimes MUST bound decompression by the declared ceilings below rather than trusting ZIP headers. Loading an archive MUST NOT require retaining its complete uncompressed contents in memory; implementations SHOULD stream entries or spool them to bounded temporary storage.

**Model ceilings.** Conforming models MUST stay within these limits. Runtimes MUST reject anything beyond them before performing the corresponding unbounded allocation or work, and MUST NOT crash on such input:

| quantity | ceiling |
|---|---|
| container files / uncompressed size | 4 096 / 2 GiB |
| single / aggregate manifest-listed JSON documents | 64 MiB / 64 MiB |
| id length | 128 chars |
| absolute magnitude of an evaluated authored number | 1 000 000 000 000 |
| manifest capabilities | 128 |
| parameters | 10 000 |
| nodes / tree depth | 10 000 / 64 |
| grid or warp `cols`, `rows` | 64 each |
| total mesh + warp control points | 1 048 576 |
| total sprite-mesh triangles | 2 097 152 |
| explicit mesh points / triangles per sprite | 65 536 / 131 072 |
| mask sources per sprite / across model | 256 / 100 000 |
| bindings | 100 000 |
| binding axes / keys per axis | 3 / 33 |
| value scalars per binding / across model | 1 048 576 / 8 388 608 |
| expressions / expression entries across model | 4 096 / 100 000 |
| motions / tracks / keys across model | 4 096 / 100 000 / 1 000 000 |
| atlas rect-or-annotation entries | 100 000 |
| encoded PNG bytes per texture | 256 MiB |
| texture dimension / decoded pixels per texture | 8 192 px / 16 777 216 |
| decoded pixels across per-file textures + atlas | 67 108 864 |
| canvas dimension / total pixels | 16 384 px / 8 388 608 |
| physics chains / links per chain | 256 / 64 |
| physics inputs / outputs across model | 100 000 / 100 000 |
| physics simulation rate | 240 fps |
| variant slots / options / node memberships | 4 096 / 100 000 / 1 000 000 |

The 4 096 container limit counts regular files, not directories. The aggregate texture count includes each distinct per-file texture once plus the atlas image once, whether or not multiple sprites reference them. The total control-point count includes every sprite mesh point and every warp-grid control point. The total triangle count includes rendered sprite-mesh triangles, not warp control cells. These ceilings sit far above observed production rigs; they bound adversarial input, not expressive rigs. Raising a ceiling is a MINOR revision.

**Operational ceilings.** These bound traversal and state-dependent work rather than static model statistics. Implementations MUST reject before the bounded allocation, mutation, inflation, or raster loop:

| operation | ceiling |
|---|---:|
| directory/ZIP traversal entries | 8 192 |
| one container path / aggregate retained path metadata | 4 096 UTF-8 bytes / 8 MiB |
| PNG chunks / `IDAT` chunks | 65 536 / 16 384 |
| fixed physics steps per `update` | 10 000 |
| physics work units per `update` | 10 000 000 |
| exact orientation predicates per hit-test query | 4 096 |
| raster candidate tests per frame | 67 108 864 |
| validator flat rest-pose reference candidate tests | 268 435 456 |
| reference-WebGL de-indexed vertex uploads per frame | 64 MiB |

A physics work unit is one fixed-step chain/input/link visit plus one stage-1–4 parameter-source visit needed to sample that step. Stage-1–4 sampling charges one visit per parameter default, host-input entry, sampled motion track, and applied expression entry; a held-zero expression entry is not applied and therefore costs no visit. Each sampled motion track additionally charges `ceil(log2(key_count + 1))` for its bounded binary key search. Advancing a motion/expression clock or visiting its wrapper is not a parameter-source visit. Within a solver step, each chain and each input is visited once, while each link is visited four times: rest-chain construction, Verlet, stiffness, and constraint. Hit testing uses an adaptive orientation predicate: ordinary triangles take the bounded floating-point path, while a numerically ambiguous predicate is charged once before exact evaluation; a query exceeding the exact-predicate ceiling throws instead of continuing through an adversarial degenerate mesh. A raster candidate-test count is computed over the actual frame before clearing the destination: one unit per position/UV scalar validation, one per triangle setup, plus one per pixel in that triangle's canvas-clipped integer bounding box; degenerate and fully off-canvas triangles still cost their validation/setup units. Each mask-group reconstruction additionally charges one full canvas clear, then its source geometry, every time draw order switches groups. The validator's independent flat-layer rest-pose reference is allowed the separate aggregate ceiling above because its synthetic quads may be substantially more expensive than the authored meshes. When it exceeds the ordinary per-frame ceiling, the validator MUST preflight a deterministic integer-aligned subdivision: recursively bisect each over-budget tile along its longer axis (the x axis on a tie), using a floor-sized first half and the remainder as the second, until every leaf fits or an over-budget 1×1 leaf proves that no further subdivision is possible. Only the exact candidate-test counts of leaf tiles contribute to the rest-reference aggregate; conservative bounds that charge every geometry against every tile pixel MUST NOT cause rejection. The complete subdivision and aggregate MUST pass their respective ceilings before any reference tile is rasterized. The reference WebGL byte count conservatively charges 96 bytes per invoked input triangle (three vertices × eight float32 scalars), including triangles later found degenerate; it also rejects position-to-clip transforms, canvas-to-UV coefficients, or affine UV evaluation bounds that cannot remain finite in float32 before touching the target. A model can satisfy every static ceiling yet exceed an operational ceiling in a particular state; that state is rejected atomically.

---

## Annex A — Standard parameter registry (normative) and mappings (informative)

| Lyre id | range | default | semantics | ARKit (informative) |
|---|---|---|---|---|
| `Lyre.AngleX` | −30..30 | 0 | head yaw, +right | head yaw |
| `Lyre.AngleY` | −30..30 | 0 | head pitch, +up | head pitch |
| `Lyre.AngleZ` | −30..30 | 0 | head roll, +CW (viewer) | head roll |
| `Lyre.EyeLOpen` | 0..1 | 1 | left eye openness | 1 − eyeBlinkLeft |
| `Lyre.EyeROpen` | 0..1 | 1 | right eye openness | 1 − eyeBlinkRight |
| `Lyre.EyeLSmile` | 0..1 | 0 | left eye smiling squint | eyeSquintLeft |
| `Lyre.EyeRSmile` | 0..1 | 0 | right eye smiling squint | eyeSquintRight |
| `Lyre.EyeBallX` | −1..1 | 0 | gaze, +right | eyeLook* |
| `Lyre.EyeBallY` | −1..1 | 0 | gaze, +up | eyeLook* |
| `Lyre.BrowLY` | −1..1 | 0 | left brow raise | browOuterUpLeft − browDownLeft |
| `Lyre.BrowRY` | −1..1 | 0 | right brow raise | browOuterUpRight − browDownRight |
| `Lyre.MouthOpen` | 0..1 | 0 | jaw open | jawOpen |
| `Lyre.MouthForm` | −1..1 | 0 | −frown..+smile | mouthSmile − mouthFrown |
| `Lyre.BodyAngleX` | −10..10 | 0 | body yaw | — |
| `Lyre.BodyAngleY` | −10..10 | 0 | body pitch | — |
| `Lyre.BodyAngleZ` | −10..10 | 0 | body lean | — |
| `Lyre.Breath` | 0..1 | 0 | breathing cycle | (host sine) |
| `Lyre.Cheek` | 0..1 | 0 | blush intensity | — |
| `Lyre.CheekPuff` | 0..1 | 0 | puffed cheeks | cheekPuff |
| `Lyre.TongueOut` | 0..1 | 0 | tongue | tongueOut |

Directional conventions: axis-valued parameters are **viewer-relative** — positive means toward the viewer's right (X), up (Y), or clockwise as the viewer sees it (Z). The `L`/`R` suffixes in Lyre ids denote the **character's own** left and right. Because source conventions vary, import bridges SHOULD verify eye assignment per model. Models MAY implement a subset; hosts MUST tolerate missing registry parameters.

The registry deliberately contains no hair-sway parameters: sway is model-specific and physics-driven (§9), rather than driven directly by hosts.

## Annex B — PSD authoring convention for auto-rigging (informative)

A harness turns a PSD into a rig scaffold with zero questions when layers follow:

- Group/layer names are `snake_case`; the group tree becomes the node tree.
- Recommended top-level groups: `hair_front`, `head`, `face`, `body`, `hair_back`, `bg`.
- **Z allocation:** the importer assigns rest `z` following PSD layer order, spacing regions 1000 apart (`bg` 0, `hair_back` 1000, `body` 2000, `face` 3000, `head` 4000, `hair_front` 5000) and sprites within a region 10 apart. The wide gaps let a ±1000 group `z` binding cleanly jump a whole region without renumbering.
- Recommended face split: `brow_l`, `brow_r`, `eye_l` (with `eyelid_upper`, `eyelash`, `iris`, `white`), `eye_r` (…), `nose`, `mouth` (with `upper_lip`, `lower_lip`, `inner`, `teeth`, `tongue`).
- Suffix tags in layer names, stripped from ids: `#pivot(x,y)` (rotator pivot hint), `#z(n)` (draw-order override), `#mask(id)` (clip target), `#nomerge`.
- Variant convention: a group named `slot@option` (e.g. `outfit@school`, `outfit@casual`) becomes a node listed under that slot/option in `variants.json`; the first `@option` group encountered per slot becomes the default unless a `#default` tag says otherwise.
- Occluded regions must be painted through (e.g., the full eyeball behind the lid); auto-rigging cannot invent hidden pixels.
- **Fidelity constraints** (required for exact rest-pose reproduction, §2): all *groups* at 100% opacity — Photoshop composites a group and then fades it, whereas Lyre multiplies opacity per sprite, and the two differ wherever children overlap. Per-*layer* opacity is fine (it maps to sprite rest opacity). Layer blend modes limited to Normal, Multiply, and Linear Dodge (Add), mapping to §8.3 `normal`/`multiply`/`additive`; the mapping is exact only over opaque backdrops. The importer MUST warn on violations and SHOULD offer to bake group opacity into layer pixels.
- The importer SHOULD emit `source/layer_map.json` mapping original layer names to generated ids. Layer names in the wild — above all in the Japanese-speaking community that produces most layered character art — are rarely ASCII `snake_case`; the harness transliterates or renames, and the map preserves provenance so later edits can still be discussed in the artist's own layer names.

## Annex C — Reference auto-rigging workflow (informative)

The workflow the "lyre-rigging" skill encodes:

1. **Ingest**: `lyre-import-psd` emits the container: sprites, tree, per-layer PNGs, empty `bindings`.
2. **Scaffold**: insert conventional deformers — `head_rot` around the neck pivot, `body_rot` at the hips, warps for `face`, `hair_front`, `hair_back`.
3. **Bind**: author bindings for the Annex A registry from conventional recipes (e.g., AngleX: head warp shear + far-side compression; EyeLOpen: eyelid verts down over iris mask).
4. **Verify visually**: render a contact sheet scrubbing each parameter across its axis keys; the LLM inspects the images and edits deltas.
5. **Physics**: attach chains to hair/accessory groups; scrub sway params to verify deformation before enabling simulation.
6. **Validate**: `lyre-validate` until clean; commit — every step is a reviewable JSON diff.

## Annex D — Design rationale (informative)

This annex records why the specification is shaped the way it is: the alternatives considered for each significant decision, what each choice trades away, and — where honest — what evidence would reopen the question. Reviewers who disagree with a decision are asked to engage with the stated trade-off rather than restate the rejected option.

### D.0 Foundational architecture

**D.0.1 Derived geometry and delta-based animation, not stored meshes.** Existing binary formats commonly bake vertex positions per keyed pose: complete, but opaque — unreviewable by humans, unwritable by LLMs, and un-diffable. Lyre instead derives meshes deterministically from tiny declarations (§5.4) and stores animation as deltas from rest (§7). The payoffs: an empty binding is a no-op rather than a copy of base geometry; files stay small enough to hold in an editing context window; `git diff` shows intent ("four points moved down when the mouth opens"); and independent runtimes reconstruct identical geometry from `(rect, cols, rows)` alone. The cost: imported meshes from other tools cannot round-trip losslessly through the preferred grid representation — the `explicit` mesh type (§5.4) exists as an escape hatch, deliberately discouraged for authoring. **Trade accepted:** authoring ergonomics for LLMs and reviewers over lossless interchange with legacy binary formats.

**D.0.2 Normative math, permissive implementation.** Interpolation (§7), deformer composition (§8.1–8.2), blending (§8.3), and physics (§9) are specified to numeric tolerances with a golden-artifact conformance suite (§12), while rendering technology is unconstrained. This is the load-bearing bet of the project: the moment "anyone can build the engine," the scarce good is *agreement between engines*. A looser spec would be easier to write and would fragment into dialects within months, recreating the problem Lyre exists to solve.

**D.0.3 The parameter registry uses familiar tracking semantics under normative names.** `Lyre.AngleX` and the other registry entries in Annex A deliberately use ranges and meanings familiar to face-tracking pipelines and riggers, minimizing adoption cost. Unlike formats where standard ids are only conventions and models can reinterpret them, Lyre's registry is normative, which lets hosts hard-code against it. **Trade accepted:** less freedom for models to reinterpret standard parameters, in exchange for hosts that work with every conforming model unconfigured.

**D.0.4 Container of small JSON files; the source PSD is not part of the model.** Small focused files keep LLM edits targeted and reviews humane. The PSD is harness-side input, consumed once at import: (a) requiring runtimes to parse PSD — a sprawling, half-documented format — would be the largest implementation burden in the spec for zero rendering benefit; (b) a layered master file is the artist's property, typically commissioned under terms that do not include redistribution, and a format that bundled it by default would leak masters with every shared model; (c) a multi-hundred-megabyte binary in the container would poison both git history and context windows. `source/` remains available for those who choose to keep provenance together.

**D.0.5 PNG is the sole required texture codec.** Modern codecs — notably JPEG XL — compress substantially better, and JXL's ecosystem position is improving rapidly (Safari ships it by default; Chrome 145 and Firefox 152 both shipped decoders in early–mid 2026, still behind experimental flags [1][2]). PNG is nonetheless required, for four reasons. (a) Universality today: PNG decodes natively, flag-free, in every browser, engine, and language runtime; a required codec that the reference web runtime cannot load without user flags or a bundled decoder reimposes the universal implementation tax rejected in D.3. (b) Compression saves the wrong resource: textures cost VRAM decoded, identically for any source codec; container size for models in the tens of megabytes is a nicety, not architecture. (c) Determinism: PNG cannot be lossy; JXL's flagship lossy mode would inject encoder-dependent pixel variation into the rest-pose conformance check and generational loss into repeated edit cycles, and a "lossless-only" rule would be violated constantly in practice. (d) An interchange container is not a delivery format: hosts and game builds may transcode for shipping, the same layering glTF uses (PNG/JPEG in core, modern codecs as extensions). **Reopening condition:** when flag-free JXL decoding is effectively universal (Chrome and Firefox default-on), a `textures-jxl` capability — lossless-only, manifest-declared — is the pre-planned shape of the extension.

### D.1 Rotators are rigid (rotation + uniform scale only)

**Alternatives:** (A) rigid, as shipped; (B) add `scale_x`/`scale_y`; (C) a general 2×3 affine node.
**Why A:** for an LLM-first format, *one obvious way to express each kind of motion* beats a rich vocabulary — the harness recipe "rotation → rotator, everything else → warp" removes a judgment call from every rig, and rigs in the wild stay mutually legible. Expressiveness is not lost: a `cols:1, rows:1` warp is a four-corner pin (§5.5) subsuming non-uniform scale, shear, and perspective-like distortion. B looks cheap but forces a normative answer to scale-vs-rotation composition order, and nested non-uniform scales produce shear whether wanted or not — most of an affine spec with worse names. C is maximally general and minimally legible: a matrix communicates no intent and diffs as noise.
**Cost accepted:** an occasional extra warp node wrapping a group that "just" needed a vertical squash.

### D.2 Draw order: flat global sort with group-bindable `z`

**Alternatives:** (A) `z` deltas on individual sprites only; (B) flat global sort + `z` bindable on groups (shipped); (C) hierarchical sorting scopes (groups sort as units).
**The motivating case:** multi-sprite assemblies (an arm of eight sprites) that must cross another region (torso) as a parameter moves. Under A this takes N duplicated bindings that silently desynchronize; under B it is one group binding, with internal layering preserved because all descendants shift equally.
**Why not C:** flat global ordering is already well understood in layered puppet rigs, while strict hierarchical scopes structurally forbid cross-group interleaving such as a hair strand slipping between shoulder and scarf. Lyre's group `z` binding preserves descendant offsets while moving an assembly as a unit. Reversibility is also asymmetric: if B's known footgun bites, the fix is an additive 0.2 flag (`z_atomic`: sort a subtree as a contiguous block); if C proved too rigid, relaxing it would change how existing models render. Under uncertainty, choose the option whose failure is cheap to repair.
**The footgun, stated plainly:** nothing forces a group's sprites to stay contiguous in the ordering — a stale sprite-level `z` binding can make a hand render in front of a torso while its arm renders behind (equally, this permits intentional escapes like hand-on-hip). Mitigation: validator lints for sprite-vs-ancestor `z` bindings on the same parameter and for possible ties (§12), plus the visual verification loop (Annex C) for which such mistakes are flagrant.
**Falsifier:** if authoring trials show LLM harnesses *systematically* leaving conflicting sprite-level `z` bindings, `z_atomic` ships in 0.2 as the pre-planned response.

### D.3 Rendering: premultiplied alpha, transparent model surface, fixed-function blend modes

Three sub-problems hid under "define blending": texture filtering, output alpha, and blend-over-transparency.
**Filtering:** PNGs are straight-alpha; filtering straight-alpha textures bleeds transparent-texel color into silhouettes (dark fringing). Premultiply-at-load (§3.2) is the industry answer and is normative because fringes would masquerade as legitimate golden-image differences.
**Output surface:** the primary deployment (a model composited over game footage in OBS-like hosts) makes output *alpha* as important as color, so the spec defines a canonical transparent, extended-premultiplied model surface (§8.3) as both the host handoff and the conformance artifact — making goldens background-independent and enabling raw per-channel comparison instead of perceptual metrics.
**Blend semantics — alternatives:** (A) W3C/CSS compositing; (B) fixed-function equations where only `normal` writes alpha (shipped). **Why B:** A is mathematically principled but its equations contain src×dst cross-terms weighted by backdrop alpha, which cannot be expressed in single-pass fixed-function blending — every runtime would need multi-pass machinery for any model containing one blush layer. That cost lands on every runtime for every model. Each B mode is one `blendFuncSeparate` call (table in §8.3), and rigger intuition about blush/glow layers transfers unchanged.
**Cost accepted:** additive output is extended premultiplied color and can contain RGB greater than alpha, including emissive RGB at zero alpha. This is well-defined under the normative premultiplied `over` handoff but cannot survive a straight-alpha round trip; hosts must preserve the model surface as premultiplied data. A normal-blended compatibility halo can provide conventional coverage for nonconforming export paths (§8.3).
**Advanced blending:** screen, overlay, and other alpha-compositing modes can require extra passes, increase drawing cost, and reproduce differently across environments. Lyre therefore standardizes the small fixed-function set above. Advanced blending remains available later as an optional capability with a declared cost.

### D.4 Skeletal bones and skinning are out of scope for 0.x

A "bone system" bundles two things. Rigid rotation hierarchy Lyre already has — a chain of nested rotators *is* one. What is excluded is *weighted skinning*: per-vertex multi-bone influence that lets a continuous mesh bend smoothly at large joint angles instead of seaming or creasing. Warps handle the soft ±30–45° motion of front-facing characters well. Skinning becomes necessary for large articulation — 90° elbows, walk cycles, full-body game characters. That is a different product ambition (competing with Spine) than Lyre's declared audience of VTuber models and visual-novel sprites, whose deformation vocabulary is front-facing, soft, and small-amplitude. Skinning would also import the format's least LLM-friendly data (bulky per-vertex weights) and its hardest GUI-free authoring problem (weight painting). The capability name `bones` is reserved; nothing in the deformer pipeline forecloses it if the scope question is ever reopened by real demand. Hair-chain convenience can remain harness-side authoring sugar that emits ordinary rotator chains and warps, requiring no format change.

### D.5 Parameter wrapping: adopted, narrowly

For circular quantities (spinning accessories, wheels). Initially a candidate for deferral, wrapping was adopted because it is nearly free in this design: multilinear interpolation treats axes independently, so a wrapped axis merely changes which two keys are neighbors at the seam. Lyre uses modulo-`[min, max)` semantics, where the right endpoint is the same point as the left once wrapping is enabled. Guardrail: registry parameters MUST NOT wrap, since none of their semantics are circular; this keeps hosts' assumptions about `Lyre.*` ranges simple.

### D.6 Lipsync is host-side; the format carries no audio machinery

Some model formats require per-model routing metadata because parameter ids are only conventions and models can deviate from them. Lyre's registry is normative (D.0.3), so that pointer is unnecessary: hosts drive `Lyre.MouthOpen` directly in every conforming model. The spec therefore adds only informative guidance (§11): audio-level amplitude with smoothing as the field-standard baseline, with spectral or viseme analysis optionally driving `Lyre.MouthForm`. Viseme sophistication evolves faster than specs; keeping it host-side means lipsync quality can improve without format revisions.

### D.7 Variants: a thin capability, shipped in 0.1

**Alternatives:** (A) zero mechanism — outfits as groups, expressions toggling 0/1 opacity; (B) a full wardrobe system (thumbnails, unlock states, transitions); (C) declarative slots doing exactly three jobs — exclusivity, enumeration, load-skipping (shipped, §10.3).
**Why not A:** it cannot declare mutual exclusivity (two outfits visible at once is expressible and undetectable), hosts cannot enumerate outfits without sniffing expression files, and — decisive for the visual-novel audience — every texture of every permutation must stay resident, because animatable opacity could flip any frame. **Why not B:** wardrobe UX is host territory; no two hosts want it the same way, and an interchange format should not freeze it.
**Why 0.1 and not 0.2:** variants are not purely additive — a multi-outfit model has no meaningful rest pose until "rest" is defined as *default options + default parameters*, which touches a Core definition (§2, §6). Amending Core semantics post-release is exactly what version discipline exists to prevent; the foundation was fixed while wet.
**Load-bearing constraint:** slots are deliberately *not* animatable — no parameter or expression can switch one. That guarantee is what entitles runtimes to leave inactive options unloaded; making slots animatable would silently reintroduce A's memory behavior.
**Sharing rule:** a node may be listed by multiple options of the same slot (a collar common to two outfits) but never under two different slots — sharing within a slot is reuse; sharing across slots is ownership ambiguity, rejected by the validator, which also warns when a mask source can be excluded while its clipped sprite remains active.

### D.8 Pipeline order: expressions apply after host input

An early draft placed expressions before host input, which made every expression targeting a tracked parameter inert exactly when tracking runs — in the flagship deployment, a streamer's smile hotkey silently did nothing. The released pipeline puts expressions after host input (§6.1). The ordering encodes intent priority: motions are ambient (lowest), host capture is live (overwrites motions), expressions are deliberate user actions (beat capture), physics is derived (last). A host wanting tracking to resume simply deactivates the expression. **Cost accepted:** none, as it turns out. The fade math (§10.1) already defines application at any weight `w`, with `w = 0` an exact no-op, so a host wanting to blend tracking through a held expression holds it at fractional weight (`setExpressionWeight`, §11) instead of needing a format-level flag. This is also the better factoring: whether tracking punches through is host policy per moment, not an authoring-time fact about the model, so it belongs on the host knob. The once-contemplated per-expression `yields_to_host` flag is not planned.

### D.9 Per-sprite color tint: deferred to a `tint` capability

Per-sprite multiply/screen colors are widely used for day/night looks and cheap recoloring. Lyre 0.1 omits tint deliberately: it is purely additive — a new animatable property class (per-channel factors) touching §7 combination rules and §8.3 sampling, but no existing semantics — so unlike variants (D.7) nothing forces it into the foundation before release. Deferring keeps 0.1's rendering equations minimal while the conformance suite hardens. The capability name `tint` is reserved and the extension is drafted in full as Annex E — two sprite-level animatable RGB factor properties applied to the premultiplied sample before blending — so "deferred" means *scheduled*, not *unspecified*: what remains open is only when to ship it, and the answer is 0.2.

## Annex E — Draft extension: `tint` capability (informative; targeted at 0.2)

Recorded so that "deferred" (D.9) has a concrete, reviewable shape. Nothing in this annex is normative for 0.1; when adopted it ships as capability `tint` and this text is promoted into the core sections it references.

**Properties.** Two new animatable sprite properties:

| property | value shape | rest | combination class |
|---|---|---|---|
| `tint_multiply` | `[r, g, b]`, each 0..1 | `[1, 1, 1]` | factor; combines per channel by multiplication |
| `tint_screen` | `[r, g, b]`, each 0..1 | `[0, 0, 0]` | factor; combines per channel by screen: `s = 1 − (1−s₁)(1−s₂)` |

Both combinations are commutative and associative, preserving §7 rule 5's order-irrelevance. Rest values are exact identities, so an empty binding remains a no-op (§1.3). Binding entries are `[r, g, b]` triples, shape-checked like any other property.

**Math (premultiplied space).** Applied to the sprite's fragment after texture sampling and opacity (§8.3), before blending, per color channel, with `a` the fragment's premultiplied alpha:

1. multiply: `c ← c · m`
2. screen: `c ← c · (1 − s) + s · a`

Alpha is never modified. Step 2 is the premultiplied form of screen against a constant color: for straight color `ĉ = c/a`, screen gives `ĉ′ = 1 − (1−ĉ)(1−s)`; multiplying through by `a` yields the expression above — linear in the fragment, so no unpremultiply round-trip and no precision loss at low alpha. Where `a = 0` both steps are no-ops, consistent with §8.3's transparency behavior.

**Ordering.** Multiply, then screen (darken, then lift). The two operations do not commute with each other, so the order is fixed here and import bridges can map common source color pairs without reordering them.

**Conformance.** Tinted sprites join the golden corpus under the existing §12 surface tolerance (±2/255 on ≥99.9% of pixels plus the 8-connected catastrophic-region guard); no new comparison machinery is needed.

**Migration.** Source multiply/screen colors map 1:1. Hierarchical group × sprite color composition collapses at import time into per-sprite values: Lyre deliberately adds no group-level tint (groups multiply only opacity, §5.1); a group-wide tint is identical bindings on the descendant sprites, which harnesses can emit mechanically.

## Questions resolved by experiment (informative)

Two questions were left open during drafting and closed by experiment in the reference repository before this release:

1. **Physics tolerance realism.** Does ±0.1° per link per step (§9) survive an independent implementation? **Yes.** A deliberately different second implementation — Python, complex-number geometry, `math.hypot` distances, different operation grouping and therefore different IEEE-754 rounding — reproduces every committed golden trace with deviation below 1e-9°, nine orders of magnitude inside the tolerance ([`conformance/python/RESULTS.md`](../conformance/python/RESULTS.md)). The perturbation-stability admission criterion (§12) keeps chaotic amplification out of the suite; with correctly-rounded double arithmetic the only remaining cross-platform variance is libm `sin`/`cos` (a few ULPs). The pre-committed fallback (relaxing to ±0.5°) was not needed.
2. **Ceiling calibration.** The §16 ceilings were chosen from incumbent anecdote, not a corpus. The observed maximum of every §16 quantity across the conformance corpus is now published beside the ceilings ([`conformance/STATS.md`](../conformance/STATS.md), via `lyre-validate stats`, §12). The corpus is synthetic and small, so the published figures are a floor on real practice, not a survey of production rigs; re-running the survey over imported rigs once the PSD import bridge ships will extend it. Raising a ceiling is MINOR-safe, so generous-now remains the correct prior.

## References

Inline markers [n] refer to this list.

1. JPEG XL — Wikipedia (browser support timeline: Chromium merge Jan 2026, Firefox 152, Safari 17). https://en.wikipedia.org/wiki/JPEG_XL
2. Can I use — JPEG XL image format. https://caniuse.com/jpegxl
