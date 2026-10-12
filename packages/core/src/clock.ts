/**
 * Add one binary64 delta to a two-component compensated scalar.
 *
 * Keeping the rounding residue is important for clocks: endpoint-derived
 * deltas telescope in real arithmetic, but repeatedly adding them to a lone
 * binary64 accumulator can lose enough low bits to miss a fixed-step
 * boundary. The returned pair is renormalized so `value + error` is the best
 * binary64 projection while `error` retains the next component.
 */
export function addCompensated(
  value: number,
  error: number,
  delta: number,
): { value: number; error: number } {
  const sum = value + delta;
  const residue = Math.abs(value) >= Math.abs(delta) ? value - sum + delta : delta - sum + value;
  const correction = error + residue;
  const next = sum + correction;
  return { value: next, error: sum - next + correction };
}

/** The canonical binary64 value represented by a compensated pair. */
export function compensatedValue(value: number, error: number): number {
  return value + error;
}
