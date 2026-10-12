# @refrain-lyre/render-soft

CPU reference software rasterizer. Consumes the deformed geometry and draw order produced by
[`@refrain-lyre/core`](https://github.com/refrainmoe/lyre/tree/master/packages/core) and rasterizes into
the canonical premultiplied-alpha model surface
(§8.3) entirely on the CPU — float64 accumulation, quantized to RGBA8 once at readback.
The surface is extended premultiplied: additive layers may retain RGB greater than alpha,
including emissive RGB at zero alpha.

This renderer **defines the conformance goldens** (§12): it is deterministic on any machine,
needs no GPU in CI, and implements the normative blend and mask equations exactly.
[`@refrain-lyre/render-webgl`](https://github.com/refrainmoe/lyre/tree/master/packages/render-webgl) is
verified against its output within the §12 tolerance. It is browser-safe, with only
`@refrain-lyre/core` as a peer and no platform-specific runtime dependency, so the testbed can diff
GPU output against it live.

The normative rasterization rules are in §8.3.1: pixel-center sampling, top-left fill,
no MSAA, and bilinear filtering of premultiplied texels clamped to the selected crop.
Mask groups rasterize `m = 1 − ∏(1 − aᵢ)` coverage from deformed geometry and raw texture
alpha only (§8.4).

See the [specification](https://github.com/refrainmoe/lyre/blob/master/spec/lyre.md).
