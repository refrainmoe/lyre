// @refrain-lyre/schemas — JSON Schemas per container file type (§12).
// Schemas are authored as JSON documents under ../schemas and re-exported here.
// They cover structural/shape constraints only; normative math and cross-file
// referential integrity live in @refrain-lyre/validate.

import commonSchema from "../schemas/common.schema.json" with { type: "json" };
import manifestSchema from "../schemas/manifest.schema.json" with { type: "json" };
import rigSchema from "../schemas/rig.schema.json" with { type: "json" };
import physicsSchema from "../schemas/physics.schema.json" with { type: "json" };
import variantsSchema from "../schemas/variants.schema.json" with { type: "json" };
import expressionSchema from "../schemas/expression.schema.json" with { type: "json" };
import motionSchema from "../schemas/motion.schema.json" with { type: "json" };
import atlasSchema from "../schemas/atlas.schema.json" with { type: "json" };

/** JSON Schema document exported without leaking JSON-module imports into declarations. */
export type SchemaDocument = Record<string, unknown>;

const commonSchemaDocument: SchemaDocument = commonSchema;
const manifestSchemaDocument: SchemaDocument = manifestSchema;
const rigSchemaDocument: SchemaDocument = rigSchema;
const physicsSchemaDocument: SchemaDocument = physicsSchema;
const variantsSchemaDocument: SchemaDocument = variantsSchema;
const expressionSchemaDocument: SchemaDocument = expressionSchema;
const motionSchemaDocument: SchemaDocument = motionSchema;
const atlasSchemaDocument: SchemaDocument = atlasSchema;

export {
  commonSchemaDocument as commonSchema,
  manifestSchemaDocument as manifestSchema,
  rigSchemaDocument as rigSchema,
  physicsSchemaDocument as physicsSchema,
  variantsSchemaDocument as variantsSchema,
  expressionSchemaDocument as expressionSchema,
  motionSchemaDocument as motionSchema,
  atlasSchemaDocument as atlasSchema,
};

/** Container file kinds that have a schema. */
export type SchemaKind =
  "manifest" | "rig" | "physics" | "variants" | "expression" | "motion" | "atlas";

/** Schemas by file kind (excluding the shared `common` definitions document). */
export const schemasByKind: Record<SchemaKind, SchemaDocument> = {
  manifest: manifestSchemaDocument,
  rig: rigSchemaDocument,
  physics: physicsSchemaDocument,
  variants: variantsSchemaDocument,
  expression: expressionSchemaDocument,
  motion: motionSchemaDocument,
  atlas: atlasSchemaDocument,
};

/**
 * All schema documents, `common` first. Register every entry with a JSON Schema
 * validator (they cross-reference by `$id`).
 */
export const allSchemas: SchemaDocument[] = [commonSchemaDocument, ...Object.values(schemasByKind)];
