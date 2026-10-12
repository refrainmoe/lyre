# @refrain-lyre/import-psd

The `lyre-import-psd` CLI: turns a layered PSD into a Lyre container scaffold — layers →
sprites and per-layer PNGs, the group tree → node tree, and the Annex B naming convention
(z allocation, deformer/pivot/mask/variant tags) → rig structure with empty bindings.

Emits `source/layer_map.json` for provenance and warns on Annex B fidelity-constraint
violations (group opacity, non-mappable blend modes). This is a harness-side tool; runtimes
never parse PSD (D.0.4).

> Not yet implemented — this directory currently holds the package's charter only.

See the [specification](../../spec/lyre.md), Annexes B and C.
