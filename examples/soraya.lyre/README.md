# Soraya

A real-world Lyre 0.1 character example translated from the archived interactive Soraya demo
under `source/original/`.

The model preserves all 26 source drawables, their original mesh topology and draw order, nine
nested transform groups, cage and eyelid deformations, eye clipping, animated opacity, and the
seeded autonomous motion. Source blink channels map to the normative `Lyre.EyeLOpen` and
`Lyre.EyeROpen` parameters; source body roll maps to `Lyre.BodyAngleZ`; the positive inhale half
maps to `Lyre.Breath`. The `eyes_closed` expression can be layered over the looping `idle`
motion in the browser testbed.

The source renderer splits every grid cell along the opposite diagonal from Lyre's generated
grid. This imported model therefore uses §5.4 explicit meshes so conversion does not subtly
change the authored deformation. Per-drawable PNGs are cropped losslessly from the source atlas;
`atlas.json` points back into that same atlas and is validator-checked against every file.

One source skirt cage carried a nonzero delta at its parameter default, so the original engine's
nominal default pose did not equal the exported flat artwork. The converter rebases every
additive/factor binding around its declared default; this preserves the movement relative to rest
while satisfying Lyre's normative, validator-enforced rest-pose invariant.

Regenerate the derived files from the archived sources:

```sh
pnpm example:soraya
node packages/validate/dist/cli.js examples/soraya.lyre
pnpm --filter @refrain-lyre/testbed dev
```

The preview at the top of the repository README is rendered from this model by the CPU reference
rasterizer; `pnpm --filter @refrain-lyre/gen preview:soraya` regenerates the video under
`docs/media/` after the model changes.

The upstream files and provenance are recorded under [`source/original/`](./source/original/).
