# Lyrical Refrain (Lyre)

<p align="center">
  <a href="https://github.com/refrainmoe/lyre/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/refrainmoe/lyre/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/@refrain-lyre/core"><img alt="npm" src="https://img.shields.io/npm/v/@refrain-lyre/core?label=%40refrain-lyre%2Fcore"></a>
  <a href="./LICENSE"><img alt="License: Unlicense" src="https://img.shields.io/badge/license-Unlicense-blue"></a>
</p>

<p align="center">
  <a href="./docs/media/soraya-idle.mp4"><strong>▶ Watch Soraya's idle loop (MP4, 16 s)</strong></a><br>
  <sub><a href="./examples/soraya.lyre">Soraya</a>: 26 sprites, nested rotators, explicit meshes, clipping masks, and a
  16-second looping motion, all declared in small JSON files and rendered by the CPU reference rasterizer.</sub>
</p>

**An open specification and reference implementation for layered 2D puppet models** — layered
illustrations (typically authored as PSDs) deformed in real time by a small set of named
parameters, suitable for VTubing, visual-novel and game sprites, and interactive characters.

Building the _engine_ for such models is no longer scarce — a modern LLM can produce one in
minutes — but a shared _format_ is. Without one, the community fragments into thousands of
similar-but-incompatible runtimes. **Lyre is the interchange layer: one format, one normative
evaluation model, many runtimes.**

> **Status: specification 0.1 (first release).** The reference implementation is
> functional: evaluation core, CPU reference rasterizer, WebGL2 renderer (verified against
> the CPU goldens in headless Chromium), `lyre-validate` CLI, a generated conformance corpus
> with committed goldens, a browser testbed, and a second physics implementation in Python.
> `@refrain-lyre/import-psd` is not yet implemented. The independently versioned
> [`lyre-rigging` skill](https://github.com/refrainmoe/lyre-skill) packages the Lyre 0.1
> authoring workflow in its standalone repository.
>
> Two drafting uncertainties were resolved experimentally before release:
> **(1)** the ±0.1°/step physics tolerance holds across independent implementations —
> see [`conformance/python/RESULTS.md`](./conformance/python/RESULTS.md);
> **(2)** observed §16 maxima are published beside the ceilings —
> see [`conformance/STATS.md`](./conformance/STATS.md).

## What makes it different

- **Open and complete.** Everything needed to render a model identically is in the spec. No
  opaque binary blobs, no reverse-engineered behavior.
- **LLM-first authoring.** Small text files, semantic `snake_case` ids, sparse deltas from a
  rest pose, and deterministic derivation of everything bulky — designed to be written and
  edited by language models as much as by humans.
- **Ecosystem compatibility.** Parameter semantics deliberately align with widely used
  face-tracking conventions and ARKit blendshapes so tracking bridges stay straightforward.
- **Normative math.** Interpolation, deformer composition, draw order, and physics are
  specified precisely enough that two independent runtimes produce visually identical output,
  verified by a golden-artifact conformance suite.

## Specification

The normative source of truth lives in [`spec/`](./spec):

- **[spec/lyre.md](./spec/lyre.md)** — version 0.1.

## Repository layout

This is a [pnpm](https://pnpm.io) workspace monorepo.

| Path                                               | Purpose                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`spec/`](./spec)                                  | The specification (normative).                                                                |
| [`packages/core`](./packages/core)                 | `@refrain-lyre/core` — dependency-free evaluation: params → deformed geometry (§6–§9).        |
| [`packages/render-soft`](./packages/render-soft)   | `@refrain-lyre/render-soft` — CPU reference rasterizer; defines the conformance goldens.      |
| [`packages/render-webgl`](./packages/render-webgl) | `@refrain-lyre/render-webgl` — WebGL2 renderer producing the model surface (§8.3).            |
| [`packages/validate`](./packages/validate)         | `@refrain-lyre/validate` — the `lyre-validate` CLI + conformance runner (§12).                |
| [`packages/schemas`](./packages/schemas)           | `@refrain-lyre/schemas` — published JSON Schemas, one per container file type.                |
| [`packages/import-psd`](./packages/import-psd)     | Charter for the future PSD importer; not implemented or published.                            |
| [`packages/testbed`](./packages/testbed)           | Browser testbed for visual validation (private workspace app).                                |
| [`tools/gen`](./tools/gen)                         | Generator for the focused conformance corpus (private).                                       |
| [`tools/`](./tools)                                | Repository scripts: release tarball gate, §16 statistics freshness, Soraya example converter. |
| [`conformance/`](./conformance)                    | Shared conformance corpus: models, scripted timelines, and goldens.                           |
| [`conformance/python`](./conformance/python)       | Independent Python physics implementation and trace comparison backing the §9 tolerance.      |
| [`examples/`](./examples)                          | Real-world example models, including the full Soraya reference rig.                           |

The Annex B–C LLM workflow is maintained separately in
[`refrainmoe/lyre-skill`](https://github.com/refrainmoe/lyre-skill), so skill releases can
improve independently of format releases.

## Technology

The specification (§14) calls for TypeScript reference implementations under the
`@refrain-lyre` npm scope; the tooling follows from that and from the format's "small files, minimal config"
ethos:

| Concern                      | Choice                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| Language                     | TypeScript (strict, ESM)                                         |
| Runtime target               | Node 22 or later (CI pins 22 via `.nvmrc`) + browsers (renderer) |
| Package manager / workspaces | pnpm workspaces                                                  |
| Build                        | tsup (esbuild) + `tsc` for declarations; TS project references   |
| Tests                        | Vitest                                                           |
| Lint & format                | ESLint (typescript-eslint) + Prettier                            |
| CI                           | GitHub Actions                                                   |

## Development

```sh
pnpm install        # install workspace dependencies
pnpm build          # build all packages (required before the CLI commands below)
pnpm test           # run package/unit tests
pnpm typecheck      # type-check the workspace
pnpm lint           # ESLint
pnpm format         # Prettier (write)
pnpm format:check   # Prettier (check only, as CI runs it)
pnpm release:check  # build clean package tarballs and verify published entry points
pnpm stats:write    # regenerate conformance/STATS.md after corpus changes
pnpm stats:check    # verify the committed §16 maxima without rewriting them
pnpm example:soraya # regenerate examples/soraya.lyre from its archived source
pnpm --filter @refrain-lyre/gen preview:soraya # re-render the README's Soraya MP4 (docs/media)

# corpus / conformance (after `pnpm build`)
pnpm --filter @refrain-lyre/gen gen                                        # regenerate models + timelines
node packages/validate/dist/cli.js conformance conformance                 # CPU check vs goldens (--regen to rebuild)
node packages/validate/dist/cli.js examples/soraya.lyre                    # validate the example model
pnpm --filter @refrain-lyre/render-webgl exec playwright install chromium  # install the shared browser once
pnpm --filter @refrain-lyre/render-webgl e2e                               # WebGL vs goldens
pnpm --filter @refrain-lyre/testbed e2e                                    # browser testbed smoke tests
pnpm --filter @refrain-lyre/testbed dev                                    # browser testbed
python3 conformance/python/compare_traces.py                               # physics cross-implementation
```

## Releasing

The release procedure (pinned package manager, mandatory tarball gate, publish order, and
tagging) is documented in [RELEASING.md](./RELEASING.md). Security reports are handled per
[SECURITY.md](./SECURITY.md).

## License

Public domain under [the Unlicense](./LICENSE) — the specification and the entire reference
implementation. Do anything you want with them.

## Contributing

The format is deliberately reviewable: every model is a directory of focused JSON files, and
every design decision is recorded with its trade-off in **Annex D** of the spec. Reviewers who
disagree with a decision are asked to engage with the stated trade-off rather than restate the
rejected option.
