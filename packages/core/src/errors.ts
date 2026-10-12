export type LoadErrorCode =
  | "bad_shape"
  | "unsupported_spec_version"
  | "unsupported_capability"
  | "bad_id"
  | "duplicate_id"
  | "unknown_node_type"
  | "bad_root"
  | "sprite_children"
  | "limit_exceeded"
  | "bad_param"
  | "bad_reference"
  | "bad_binding"
  | "recursive_mask"
  | "bad_variants"
  | "bad_atlas"
  | "bad_physics"
  | "bad_motion"
  | "bad_expression";

/**
 * Load-time rejection (§2, §3.1, §16). `id` names the offending entity when
 * one exists; messages are written to be actionable by an LLM harness (§12).
 */
export class LyreLoadError extends Error {
  constructor(
    readonly code: LoadErrorCode,
    message: string,
    readonly id?: string,
  ) {
    super(id !== undefined ? `${message} (at "${id}")` : message);
    this.name = "LyreLoadError";
  }
}
