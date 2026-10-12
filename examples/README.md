# Examples

Real-world Lyre models may be kept here as unpacked container **directories** (`*.lyre/`) so
their small JSON files stay human- and LLM-navigable and produce meaningful `git diff`s.
Packaged `.lyre` ZIP archives are build artifacts and are git-ignored.

Examples are reference material, not part of the normative feature-isolation
[conformance corpus](../conformance):

- [`soraya.lyre/`](./soraya.lyre/) — a full 2048×2048, 26-sprite character translated from
  return moe's hand-authored Soraya web rig. It exercises imported explicit meshes, nested
  rotators, per-vertex cage and eyelid deformation, clipping masks, shared standard parameters,
  an expression, an atlas, and a deterministic looping motion. Run `pnpm example:soraya` to
  regenerate its Lyre documents and per-sprite textures from the archived source files.
