# @refrain-lyre/testbed

Browser testbed for visual validation of Lyre models against the reference renderers and
the conformance suite (private workspace app, not published).

Vite + vanilla TypeScript. Loads the unpacked `*.lyre/` directories in the committed
[conformance corpus](../../conformance) and in the [examples directory](../../examples)
(currently the Soraya reference rig), and provides:

- **Controls generated from the model** — parameter sliders (range/default from `rig.json`),
  expression toggles + weight sliders, motion play/stop + weights (start order visible),
  variant slot switches, physics on/off + reset.
- **WebGL2 live view** over a checkerboard host backdrop
  ([`@refrain-lyre/render-webgl`](../render-webgl)).
- **CPU snapshot compare** — on-demand render via [`@refrain-lyre/render-soft`](../render-soft) in a
  Web Worker, with an amplified diff heatmap and the §12 verdict: ±2/255 on ≥99.9% of pixels,
  with no 8-connected region larger than 8 pixels among errors above 16/255. Surface previews are explicitly composited onto a selectable
  backdrop so extended premultiplied RGB remains visible even at zero alpha.
- **Golden scrubbing** — pick a conformance timeline and compare the live render against the
  committed goldens in-browser.
- **Hit-test overlay** (§11) — hover shows sprite ids.

```sh
pnpm --filter @refrain-lyre/testbed exec playwright install chromium # once, before e2e
pnpm --filter @refrain-lyre/testbed dev   # dev server (serves conformance/ and any examples/)
pnpm --filter @refrain-lyre/testbed test  # browser-independent decoder/helper tests
pnpm --filter @refrain-lyre/testbed e2e   # Playwright smoke tests (SwiftShader headless)
pnpm --filter @refrain-lyre/testbed build
pnpm --filter @refrain-lyre/testbed preview # production build with the same model API
```

An unpacked `.lyre` directory can also be dropped onto the page.
The exact browser decoder accepts standard grayscale, RGB, indexed, grayscale-alpha, and RGBA
PNGs at their legal bit depths, including Adam7-interlaced images.

See the [specification](../../spec/lyre.md).
