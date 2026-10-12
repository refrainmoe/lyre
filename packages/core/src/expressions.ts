import type { ExpressionParamEntry } from "./types/model.js";

/**
 * §10.1: apply one expression entry at weight w ∈ [0, 1].
 *   overwrite → lerp(v, value, w)
 *   add       → v + w·value
 *   multiply  → v · lerp(1, value, w)
 * At w = 0 every mode is exactly a no-op.
 */
export function applyExpressionEntry(
  current: number,
  entry: ExpressionParamEntry,
  w: number,
): number {
  switch (entry.blend) {
    case "overwrite":
      // Weighted form avoids overflowing `value - current` when both finite
      // operands have large opposite signs.
      return current * (1 - w) + entry.value * w;
    case "add":
      return current + w * entry.value;
    case "multiply":
      return current * (1 + (entry.value - 1) * w);
  }
}
