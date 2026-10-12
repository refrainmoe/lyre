# Specification

- [`lyre.md`](./lyre.md) — the Lyrical Refrain (Lyre) specification, version **0.1**
  (2026-10-12).

This is the normative source of truth for the format and its evaluation model. The implemented
reference packages under [`packages/`](../packages) follow it, and the
[`conformance/`](../conformance) corpus verifies that the evaluator and renderers agree.
[`packages/import-psd`](../packages/import-psd) is currently a charter-only directory, not an
implemented package. The Annex B–C LLM workflow is maintained independently in the
[`lyre-rigging` skill](https://github.com/refrainmoe/lyre-skill).

Versioning follows §15 of the specification (`MAJOR.MINOR`, MINOR additions backward
compatible); the version history is this repository's git history.
