# @refrain-lyre/core

Dependency-free TypeScript evaluation core: parameters → composed values → bindings →
deformed geometry, plus the normative draw-order sort. Runs headless in Node (usable for
testing without a GPU) and in the browser.

Implements the normative evaluation model of the specification: value-source composition
(§6.1), binding interpolation (§7), the per-frame pipeline and deformer math (§8.1–8.2),
mask union (§8.4), and — under the `physics` capability — the double-precision pendulum
simulation (§9).

Does **not** rasterize; a renderer (see
[`@refrain-lyre/render-webgl`](https://github.com/refrainmoe/lyre/tree/master/packages/render-webgl))
consumes this package's output surface description.

Tested with hand-computed expectations from the normative math (see `test/`); the
[conformance corpus](https://github.com/refrainmoe/lyre/tree/master/conformance) exercises the
full pipeline end to end.

`loadModel()` accepts already parsed model documents. Parse source text with the exported
`parseLyreJson()` helper rather than plain `JSON.parse()` so duplicate object members remain a
load error as required by §2. Container readers remain responsible for inventory, byte-size,
decompression, symlink, and texture-decoding limits before handing documents to the core.

## Object ownership

`loadModel()` returns a normalized object graph that downstream Lyre objects borrow by
reference. Treat that model, including its nested arrays, maps, sets, and typed buffers, as
read-only for as long as a runtime or validator may use it. Likewise, an `EvalFrame` and its
geometry buffers are borrowed read-only views; copy them before making application-specific
changes or retaining mutable working data. Mutating either object behind the runtime can
invalidate its validated limits and cached mesh state and is unsupported.

See the [specification](https://github.com/refrainmoe/lyre/blob/master/spec/lyre.md).
