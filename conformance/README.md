# Conformance corpus

The shared conformance suite (§12): a corpus of models paired with scripted parameter
timelines, plus goldens that any conforming runtime must reproduce.

- **Render goldens** — raw extended-premultiplied RGBA dumps of the model surface (§8.3), compared
  per-channel at ±2/255 on ≥99.9% of pixels; errors above 16/255 may form no 8-connected region
  larger than 8 pixels (background-independent).
- **Physics traces** — golden per-step link outputs, compared at ±0.1° over 10 s. A scenario
  is admitted only if numerically stable under the 1e-9 px perturbation criterion (§12).
- **`--stats` baselines** — published maxima of every §16 quantity across the corpus.

Regenerate the published statistics after corpus changes with `pnpm stats:write`;
`pnpm stats:check` verifies that the committed table is current without rewriting it.

## Layout

```
models/     m01…m16 — feature-isolation models, one spec behavior cluster each
timelines/  <id>.timeline.json — scripted runs for those focused models
goldens/    <timeline-id>/<step>.png + trace.json — committed reference output
```

Everything under `models/` and `timelines/` is **generated** by
[`tools/gen`](../tools/gen) (`pnpm --filter @refrain-lyre/gen gen`) — there are no hand-rigged
files; regeneration is byte-identical. Goldens are produced by the CPU reference
rasterizer ([`@refrain-lyre/render-soft`](../packages/render-soft)). From the repository root:

```
node packages/validate/dist/cli.js conformance conformance --regen # regenerate goldens
node packages/validate/dist/cli.js conformance conformance         # check current goldens
```

## Timeline format

Suite-internal scripted-run format (`timelines/*.timeline.json`):

Timeline files are trusted developer-authored test configuration, not the hostile model-container
input boundary described by §16. The runner still validates their structure and bounds each file to
64 MiB, 100,000 steps, 100,000 events, 256 captures, 256 MiB of retained capture surfaces, and
8,388,608 angle scalars across the simultaneous baseline/perturbation traces, so a malformed fixture
or large-number typo fails cleanly. The perturbation pass is trace-only: it does not create a render
target or retain a second capture set, so the capture-surface ceiling accounts for the runner's full
retained capture set. Run third-party corpora under the same normal sandboxing used for any external
test configuration; model paths are intentionally resolved relative to the timeline and may point
outside the corpus.

```json
{
  "model": "../models/m11_expressions.lyre",
  "fps": 60,
  "steps": 600,
  "events": [
    { "step": 0, "set": { "Lyre.AngleX": -30 } },
    { "step": 0, "expression": { "id": "smile", "weight": 0.5 } },
    { "step": 60, "motion": { "id": "idle", "action": "play", "weight": 1.0 } },
    { "step": 120, "variant": { "slot": "glasses", "option": "round" } },
    { "step": 180, "clear": ["Lyre.AngleX"] }
  ],
  "captures": [0, 60, 179, 180, 599],
  "physics_trace": true
}
```

Semantics — whole steps at fixed `dt = 1/fps`, for `step` in `[0, steps)`:

1. Apply every event whose `step` matches, in array order. `set` maps param ids to host
   input values (§6.1 stage 3); `clear` releases them; `expression` activates/deactivates
   (`action`) or sets the target weight directly (`weight`); `motion` supports `play`,
   `stop`, and `weight`; `variant` selects a slot option. Each event contains exactly one
   action key; use multiple same-step events when several actions must occur together.
2. Advance the runtime by one timeline step. For a physics-trace timeline, derive each interval
   from the absolute endpoints `step/fps` and `(step+1)/fps`, rather than repeatedly adding
   `1/fps`; this makes the script cover exactly 10 simulated seconds without cadence drift. The
   runtime reports every completed internal physics step so each boundary is represented exactly
   once even when the outer and solver rates differ.
3. If `physics_trace` is set, append each traced chain's link output angles (degrees,
   rounded to 1e-9° to keep JSON diffable — far below the ±0.1° tolerance). By default
   all chains are traced; `trace_chains` restricts the set. A restriction must
   contain at least one known, unique chain id, and every omitted chain must be
   skippable under §10.3 rule 5 in every variant state reached by the script.
4. If the step is listed in `captures`, evaluate and render, and record the surface.

Captured surfaces are stored as PNGs whose decoded bytes **are** the extended-premultiplied
RGBA surface dump (`goldens/<timeline-id>/<step>.png`); the PNG container is used for
lossless storage only, not as a straight-alpha image. Traces are stored in
`goldens/<timeline-id>/trace.json` as `{ fps, chains: { <chain-id>: [[deg,…],…] } }`
indexed `[step][link]`; this `fps` is the model's internal physics rate, not necessarily the
timeline's outer scripting rate.

`use_atlas: true` renders through `atlas.json` rects instead of per-file textures
(§3.2) — the m16 pair (`m16_files` / `m16_atlas`) pins that the two are
indistinguishable.

## Corpus map

| model                       | pins down                                                               |
| --------------------------- | ----------------------------------------------------------------------- |
| m01_blend_over_transparency | §8.3 blends; additive RGB at zero alpha; transparent multiply           |
| m02_mesh_grid_verts         | §5.4 grid derivation, row-major points, ↘ diagonal; explicit mesh       |
| m03_rotators_nested         | §8.2 CW rotation (+y down); non-commuting nested rotators; pivot_offset |
| m04_warp_interior           | §5.5 bilinear cell mapping, multi-cell deltas                           |
| m05_warp_overhang           | §5.5 clamped-cell extrapolation past edges and corners                  |
| m06_multiparam_grids        | §7 2/3-param bindings, non-uniform axes, row-major order, clamping      |
| m07_wrap_seam               | §7 wrap axes: seam interpolation, modulo wrap of values                 |
| m08_zsort                   | §8.1 flat z-sort, single rounding, ±0.5 tie rule, document-order ties   |
| m09_masks                   | §8.4 alpha/inverted masks, multi-source union, opacity independence     |
| m10_opacity_combine         | §6/§7 opacity factor product, clamp-once, ancestor products             |
| m11_expressions             | §10.1 weight math over host input (D.8); mid-fade sampling              |
| m12_motions                 | §10.2 start-order layering, bezier easing, step/linear, loop wrap       |
| m13_variants                | §10.3 exclusion of nodes, bindings, mask sources; mid-timeline switch   |
| m14_physics                 | §9 pendulum inputs/links and order-independent add+overwrite fan-in     |
| m15_physics_variant_skip    | §10.3 rule 5 skippable chain — golden identical simulated or skipped    |
| m16_atlas                   | §3.2 atlas with 2-texel replicated gutters ≡ per-file rendering         |

Notes:

- Running `lyre-validate` on `m08_zsort` and `m13_variants` intentionally emits warnings
  (`z_tie_possible` and `excludable_mask_source`): those models exist to pin the very
  behaviors the lints flag. Every corpus model must still validate with zero errors, which is
  what the CI corpus-validation step checks; warnings do not fail it.
- The §9 exact-zero-vector rule is covered by unit tests in `@refrain-lyre/core`, not by a
  golden trace: the §12 perturbation admission excludes it by construction (any
  perturbation breaks the exact equality and flips the fallback direction).
- `python/` holds the standalone second physics implementation used for
  independent trace verification.
