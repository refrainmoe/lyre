# Independent physics conformance verification

The §9/§12 conformance tolerance of ±0.1° per link per step holds across a
deliberately different second implementation. The Python
implementation in [`lyre_physics.py`](lyre_physics.py) (complex-number
geometry, `math.hypot`, fused Verlet+stiffness loop — different operation
grouping, therefore different IEEE-754 rounding) reproduces every committed
golden trace within the figures below, orders of magnitude inside the
tolerance.

Regenerate: `python3 conformance/python/compare_traces.py --write-results`

| timeline | chain | steps | max deviation (°) | tolerance (°) |
| --- | --- | ---: | ---: | ---: |
| m14_physics | ch_asym | 600 | 0.000000000 | 0.1 |
| m14_physics | ch_sway | 600 | 0.000000000 | 0.1 |
| m15_physics_variant_skip | ch_main | 600 | 0.000000000 | 0.1 |

The §9 exact-zero-vector rule (coincident link → direction d̂(φ)) is
verified by an exact-arithmetic check in this script rather than by a
golden trace: the §12 perturbation admission excludes exact equality by
construction (any 1e-9 px displacement breaks it and flips the fallback
direction), so no perturbation-stable trace scenario can reach that branch.
