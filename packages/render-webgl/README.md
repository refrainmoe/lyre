# @refrain-lyre/render-webgl

WebGL2 renderer. Consumes the deformed geometry and draw order produced by
[`@refrain-lyre/core`](https://github.com/refrainmoe/lyre/tree/master/packages/core) and rasterizes into
the canonical premultiplied-alpha model
surface (§8.3), with the three blend modes (`normal`/`additive`/`multiply`) mapped to
single `blendFuncSeparate` calls and mask clipping (§8.4).
The offscreen surface preserves extended-premultiplied additive emission, including RGB at
zero alpha; callers must not round-trip it through straight alpha.

Textures are premultiplied at load; all filtering and blending happen in premultiplied space
(§3.2). The rendered surface is the conformance artifact compared against goldens (§12).

## Usage

```ts
import { createWebGLRenderer, CONTEXT_ATTRIBUTES } from "@refrain-lyre/render-webgl";

const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES)!;
const renderer = createWebGLRenderer(gl, model.canvas.width, model.canvas.height);
renderer.setTexture(id, premultipliedImage /*, atlasRect */);
renderer.render(runtime.evaluate());
const surface = renderer.readSurface(); // premultiplied RGBA8, +y down
```

The context remains host-owned and may be shared with other WebGL code. The
constructor, `setTexture()`, `render()`, `readSurface()`, and `present()` restore
all caller-visible state they change, including separate draw/read framebuffer
bindings, the default framebuffer draw buffer, texture and sampler units 0–1,
pixel-transfer state, program/VAO/buffer bindings, blend state, capabilities,
viewport, color mask, and clear color. `dispose()` invalidates renderer-owned
objects (including a `surfaceTexture` the host may have bound), as expected for
resource destruction.

WebGL's error queue is consumptive and cannot be snapshotted or restored. Enter
renderer calls with a clean error queue; the renderer drains it so errors from
its own operation can be attributed and reported precisely.

Implementation notes (why it matches the CPU reference within the §12 surface tolerance):

- Renders both the model surface and reusable mask-coverage target as RGBA32F
  (no sRGB formats, no MSAA, no dither). Float32 preserves extended additive
  color and repeated low-alpha mask unions without intermediate float16 or
  RGBA8 precision loss; `readSurface()` performs the sole RGBA8 quantization.
  This requires WebGL2 `EXT_color_buffer_float` and `EXT_float_blend`; renderer
  construction fails explicitly when either extension is unavailable.
- The projection flips y so canvas-space top/left edges stay top/left in
  window space and the GPU fill rule agrees with the CPU top-left rule;
  `readSurface()` flips rows back.
- Triangles are de-indexed and normalized to positive winding on the CPU
  (float64) so opposite-winding neighbors stay watertight, and each triangle
  carries its exact affine canvas→uv map as flat attributes — the fragment
  shader reconstructs uv from `gl_FragCoord`, sidestepping the rasterizer's
  subpixel vertex snap (SwiftShader: 1/16 px).
- Bilinear sampling is done manually with `texelFetch` + `mix`, clamped to the
  crop interior (§3.2) — hardware `LINEAR` has unspecified subtexel precision.
- Mask coverage (§8.4) renders raw texture alpha into an offscreen target with
  normal alpha blending (equivalent to the union 1 − ∏(1 − aᵢ)). One target
  is reused across groups so mask-target memory remains bounded. The browser
  harness stress-checks both a 256-source union of 1/255-alpha masks and
  9,998 low-intensity additive layers followed by multiply against the CPU
  reference.
- Surface and texture creation checks both Lyre's static limits and the active
  device's texture/viewport limits. Allocation errors fail explicitly and
  partially created GL resources are released.

## Conformance (e2e)

In this repository, run `pnpm --filter @refrain-lyre/render-webgl exec playwright install chromium` once, then
`pnpm --filter @refrain-lyre/render-webgl e2e`. The command bundles an in-page harness, launches
headless Chromium on SwiftShader, replays
every corpus timeline, and compares against the committed CPU goldens at the
§12 tolerance. `LYRE_E2E_DUMP=<dir>` writes actual/golden/diff PNGs for
failures.

See the [specification](https://github.com/refrainmoe/lyre/blob/master/spec/lyre.md).
