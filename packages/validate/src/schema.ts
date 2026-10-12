// JSON Schema validation of raw container documents (§12). Structural only;
// normative math and cross-file integrity are checked by the loader and lints.

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { allSchemas, schemasByKind, type SchemaKind } from "@refrain-lyre/schemas";
import { LIMITS, type ModelFiles } from "@refrain-lyre/core";
import type { ValidationIssue } from "./report.js";

// AJV builds its complete error array before returning. `allErrors: false`
// bounds that hidden allocation to the first structural failure per document;
// the report-level cap below bounds containers with many invalid documents.
const ajv = new Ajv2020({ allErrors: false, allowUnionTypes: true });
for (const schema of allSchemas) ajv.addSchema(schema);

const MAX_SCHEMA_ISSUES = 256;

interface SchemaBudget {
  details: number;
  truncated: boolean;
}

function validator(kind: SchemaKind): ValidateFunction {
  const fn = ajv.getSchema((schemasByKind[kind] as { $id: string }).$id);
  if (!fn) throw new Error(`schema not registered: ${kind}`);
  return fn;
}

function truncate(
  file: string,
  reason: string,
  issues: ValidationIssue[],
  budget: SchemaBudget,
): void {
  if (budget.truncated) return;
  budget.truncated = true;
  issues.push({
    level: "error",
    code: "schema_analysis_truncated",
    message: `${file}: schema validation stopped safely (${reason}); additional schema errors were omitted`,
  });
}

function check(
  kind: SchemaKind,
  doc: unknown,
  file: string,
  issues: ValidationIssue[],
  budget: SchemaBudget,
): void {
  const fn = validator(kind);
  let valid: boolean;
  try {
    valid = fn(doc) as boolean;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    truncate(file, reason, issues, budget);
    return;
  }
  if (valid) return;
  const err = fn.errors?.[0];
  if (budget.details < MAX_SCHEMA_ISSUES) {
    issues.push({
      level: "error",
      code: "schema",
      message: `${file}${err?.instancePath || ""}: ${err?.message ?? "invalid"}`,
    });
    budget.details++;
  } else {
    truncate(file, `${MAX_SCHEMA_ISSUES}-issue report budget`, issues, budget);
  }
}

/**
 * The rig schema is recursive. Screen its node tree iteratively against the
 * normative node/depth ceilings before AJV can recurse into attacker-shaped
 * input and overflow the JavaScript call stack.
 */
function rigTreeEnvelopeError(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const nodes = (doc as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return null;
  if (nodes.length > LIMITS.nodes) return `node count exceeds ${LIMITS.nodes}`;

  const stack = nodes.map((node) => ({ node, depth: 1 }));
  let count = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    count++;
    if (count > LIMITS.nodes) return `node count exceeds ${LIMITS.nodes}`;
    if (depth > LIMITS.treeDepth) return `node depth exceeds ${LIMITS.treeDepth}`;
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const children = (node as Record<string, unknown>).children;
    if (!Array.isArray(children)) continue;
    if (count + stack.length + children.length > LIMITS.nodes) {
      return `node count exceeds ${LIMITS.nodes}`;
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], depth: depth + 1 });
    }
  }
  return null;
}

/** Validate every raw document of a container against its published schema. */
export function validateSchemas(
  raw: ModelFiles,
  paths: { manifest: string; rig: string; physics?: string; variants?: string; atlas?: string },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const budget: SchemaBudget = { details: 0, truncated: false };
  check("manifest", raw.manifest, paths.manifest, issues, budget);
  const rigEnvelopeError = rigTreeEnvelopeError(raw.rig);
  if (rigEnvelopeError) truncate(paths.rig, rigEnvelopeError, issues, budget);
  else check("rig", raw.rig, paths.rig, issues, budget);
  if (raw.physics !== undefined)
    check("physics", raw.physics, paths.physics ?? "physics.json", issues, budget);
  if (raw.variants !== undefined)
    check("variants", raw.variants, paths.variants ?? "variants.json", issues, budget);
  if (raw.atlas !== undefined)
    check("atlas", raw.atlas, paths.atlas ?? "atlas.json", issues, budget);
  for (const [file, doc] of Object.entries(raw.expressions ?? {})) {
    check("expression", doc, file, issues, budget);
  }
  for (const [file, doc] of Object.entries(raw.motions ?? {})) {
    check("motion", doc, file, issues, budget);
  }
  return issues;
}
