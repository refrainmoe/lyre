# @refrain-lyre/validate

The `lyre-validate` CLI (§12): schema validation, resource-limit checks (§16), referential
integrity, variant rules, mesh/binding shape checks, draw-order lints, the rest-pose check,
and the conformance runner (golden RGBA compares rendered on the CPU, plus golden physics
traces). Also exposes `stats` / `--stats` corpus mode (§12).

Uses [`@refrain-lyre/core`](https://github.com/refrainmoe/lyre/tree/master/packages/core) as a peer for
evaluation,
[`@refrain-lyre/render-soft`](https://github.com/refrainmoe/lyre/tree/master/packages/render-soft) for
deterministic golden renders (no GPU required — the WebGL2 renderer is verified against the
same goldens separately), and
[`@refrain-lyre/schemas`](https://github.com/refrainmoe/lyre/tree/master/packages/schemas) for JSON
Schema validation. The installed CLI is self-contained; the library shares the consumer's
single `@refrain-lyre/core` runtime identity.

## Usage

```
lyre-validate <model-dir | model.lyre> [--json]
lyre-validate conformance <corpus-dir> [--regen] [--filter <substr>]
lyre-validate stats <model-or-corpus...> [--markdown]
lyre-validate --stats <model-or-corpus...> [--markdown]
```

Exit codes: 0 valid/pass, 1 errors found, 2 usage. `<model>` accepts an unpacked
container directory or a packed `.lyre` ZIP (loaded with §16 safety: path checks,
symlink/duplicate-path rejection, entry-count and inflation bounds). ZIP entries stream to
temporary disk storage instead of retaining the complete inflated archive in memory.

Validation order: container safety and bounded JSON reads → normative load
(cheap §16 aggregate ceilings, referential integrity, shape checks) → published JSON Schemas → texture/atlas checks →
lints (`z_conflict`, conservative `z_tie_possible`, `excludable_mask_source`) → rest-pose
check → observed §16 maxima.

Library callers using `loadContainer()` or `zipFileSource()` own the returned source and
must call `container.source.close()` or `source.close()` in a `finally` block. CLI validation
and stats commands do this automatically.

See the [specification](https://github.com/refrainmoe/lyre/blob/master/spec/lyre.md) and the
[conformance corpus](https://github.com/refrainmoe/lyre/tree/master/conformance).
