# @refrain-lyre/schemas

Published JSON Schemas, one per container file type (§12): `manifest.json`, `rig.json`,
`physics.json`, `variants.json`, `*.exp.json`, `*.motion.json`, `atlas.json`. Consumed by
[`@refrain-lyre/validate`](https://github.com/refrainmoe/lyre/tree/master/packages/validate) and usable
directly by harnesses and editors for
authoring-time validation and autocompletion.

Schemas cover structural/shape constraints only; normative _math_ and cross-file referential
integrity live in the validator, not in the schemas.

Schemas live under [`schemas/`](./schemas) (JSON Schema draft 2020-12, cross-referenced by
`$id`); `src/index.ts` re-exports them as `schemasByKind` / `allSchemas` for programmatic use.

See the [specification](https://github.com/refrainmoe/lyre/blob/master/spec/lyre.md).
