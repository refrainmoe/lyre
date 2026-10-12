// Validation report types (§12). Errors reject the model; warnings are lints.

export interface ValidationIssue {
  level: "error" | "warning";
  /** Stable machine code: LyreLoadError codes, "schema", or a lint name. */
  code: string;
  message: string;
  /** Offending entity id when one exists. */
  id?: string;
}

export interface ValidationReport {
  path: string;
  /** True when no error-level issues were found (warnings allowed). */
  ok: boolean;
  issues: ValidationIssue[];
  /** Observed §16 maxima; null when the model failed to load. */
  stats: import("./stats.js").ModelStats | null;
}
