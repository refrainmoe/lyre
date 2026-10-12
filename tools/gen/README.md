# @refrain-lyre/gen

Generators for the [conformance corpus](../../conformance) (private workspace tool, not
published).

Every model in this repository is **programmatically generated**: one script per model emits
the rig/manifest/physics/… JSON and draws its straight-alpha PNG textures procedurally (a
small software 2D helper — no native canvas dependency). Generated containers and goldens are
committed; regeneration is byte-identical by construction (fixed PNG encoder options, no
timestamps, no randomness).

```sh
pnpm --filter @refrain-lyre/gen gen            # regenerate all models
pnpm --filter @refrain-lyre/gen preview:soraya # re-render the README's Soraya preview into docs/media
```

`preview:soraya` plays the Soraya example's `idle` motion through the CPU reference rasterizer
and writes the committed `docs/media/soraya-idle.mp4`, one 16-second loop encoded as H.264 by
ffmpeg. It needs a full ffmpeg build with `libx264` on `PATH`, or its path as the first argument;
the trimmed ffmpeg that Playwright installs next to Chromium lacks both H.264 and raw-video input.

See the [specification](../../spec/lyre.md) §12 and the corpus design in the
conformance README.
