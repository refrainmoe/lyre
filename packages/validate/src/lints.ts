// §12 lints: draw-order hazards and excludable mask sources. All warnings.

import { type AnyNode, type Binding, type Model, type SpriteNode } from "@refrain-lyre/core";
import { createHash } from "node:crypto";
import type { ValidationIssue } from "./report.js";

// Lints must not turn a valid, adversarially shaped model into an unbounded
// all-pairs job or an enormous report. The sweep below avoids comparing
// disjoint ranges; these budgets cap the remaining worst case where every
// sprite's range overlaps every other sprite's.
const MAX_Z_TIE_PAIR_CHECKS = 100_000;
const MAX_Z_TIE_BINDING_VISITS = 100_000;
const MAX_Z_TIE_WARNINGS = 256;
const MAX_Z_CONFLICT_CHECKS = 100_000;
const MAX_Z_CONFLICT_WARNINGS = 256;
const MAX_MASK_VARIANT_CHECKS = 100_000;
const MAX_MASK_VARIANT_WARNINGS = 256;

function ancestors(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (let p = node.parent; p; p = p.parent) out.push(p);
  return out;
}

interface VariantMembership {
  slotId: string;
  /** Options of this slot in which the directly listed node exists. */
  optionIds: Set<string>;
}

/**
 * Index variant membership once. The loader guarantees that a directly
 * listed node belongs to at most one slot, though it may occur in several
 * options of that slot.
 */
function indexVariantMembership(model: Model): Map<AnyNode, VariantMembership> {
  const memberships = new Map<AnyNode, VariantMembership>();
  for (const slot of model.variantSlots) {
    for (const option of slot.options) {
      for (const node of option.nodes) {
        const membership = memberships.get(node);
        if (membership) membership.optionIds.add(option.id);
        else memberships.set(node, { slotId: slot.id, optionIds: new Set([option.id]) });
      }
    }
  }
  return memberships;
}

type VariantConstraints = Map<string, VariantMembership[]>;

/** Collect the per-slot option requirements imposed by a node's ancestor chain. */
function variantConstraints(
  node: AnyNode,
  memberships: ReadonlyMap<AnyNode, VariantMembership>,
): VariantConstraints {
  const constraints: VariantConstraints = new Map();
  for (let current: AnyNode | null = node; current; current = current.parent) {
    const membership = memberships.get(current);
    if (!membership) continue;
    const existing = constraints.get(membership.slotId);
    if (existing) existing.push(membership);
    else constraints.set(membership.slotId, [membership]);
  }
  return constraints;
}

/**
 * Interval of a z binding's possible contribution. Multilinear interpolation
 * never leaves the [min, max] of its corner values, and every grid point is
 * reachable (keys lie inside the param range by construction), so the interval
 * is exactly [min corner, max corner].
 */
function zInterval(binding: Binding): [number, number] {
  const cached = zIntervalCache.get(binding);
  if (cached) return cached;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of binding.values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const interval: [number, number] = lo <= hi ? [lo, hi] : [0, 0];
  zIntervalCache.set(binding, interval);
  return interval;
}

const zIntervalCache = new WeakMap<Binding, [number, number]>();

interface ZTerm {
  count: number;
  interval: readonly [number, number];
}

interface EffectiveZSummary {
  sprite: SpriteNode;
  /** Conservative because separate bindings may share parameters. */
  interval: readonly [number, number];
  roundedLo: number;
  roundedHi: number;
  /**
   * Counts by exact contribution function, deliberately excluding the target.
   * Equal functions cancel when comparing two sprites, including a binding
   * inherited from a shared ancestor.
   */
  terms: ReadonlyMap<string, ZTerm>;
}

interface ZBindingInterner {
  keys: WeakMap<Binding, string>;
  buckets: Map<string, Array<{ binding: Binding; key: string }>>;
  nextKey: number;
}

function sameZFunction(a: Binding, b: Binding): boolean {
  if (a.params.length !== b.params.length || a.axes.length !== b.axes.length) return false;
  for (let i = 0; i < a.params.length; i++) {
    if (a.params[i]!.id !== b.params[i]!.id) return false;
  }
  for (let axis = 0; axis < a.axes.length; axis++) {
    const aa = a.axes[axis]!;
    const ba = b.axes[axis]!;
    if (aa.length !== ba.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== ba[i]) return false;
    }
  }
  if (a.values.length !== b.values.length) return false;
  for (let i = 0; i < a.values.length; i++) {
    if (a.values[i] !== b.values[i]) return false;
  }
  return true;
}

function zBindingKey(binding: Binding, interner: ZBindingInterner): string {
  const cached = interner.keys.get(binding);
  if (cached !== undefined) return cached;

  // Hash the potentially large scalar buffer without expanding it into JS
  // numbers or a retained decimal string. A hash collision only selects a
  // bucket: sameZFunction performs the collision-safe equality check.
  const hash = createHash("sha256");
  hash.update(JSON.stringify([binding.params.map((param) => param.id), binding.axes]));
  // Normalized bindings are backed by Float64Array at runtime. The public
  // read-only view deliberately hides `.buffer`, which would let a consumer
  // mutate or detach borrowed model storage.
  const values = binding.values as Float64Array;
  hash.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
  const digest = hash.digest("hex");
  let bucket = interner.buckets.get(digest);
  if (bucket === undefined) {
    bucket = [];
    interner.buckets.set(digest, bucket);
  } else {
    for (const candidate of bucket) {
      if (sameZFunction(binding, candidate.binding)) {
        interner.keys.set(binding, candidate.key);
        return candidate.key;
      }
    }
  }
  const key = `z${interner.nextKey++}`;
  bucket.push({ binding, key });
  interner.keys.set(binding, key);
  return key;
}

function effectiveZSummary(
  sprite: SpriteNode,
  zBindings: ReadonlyMap<AnyNode, Binding[]>,
  budget: { bindingVisits: number },
  interner: ZBindingInterner,
): EffectiveZSummary | null {
  let lo = sprite.z;
  let hi = sprite.z;
  const terms = new Map<string, ZTerm>();
  for (const node of [sprite, ...ancestors(sprite)]) {
    for (const b of zBindings.get(node) ?? []) {
      budget.bindingVisits++;
      if (budget.bindingVisits > MAX_Z_TIE_BINDING_VISITS) return null;
      const [blo, bhi] = zInterval(b);
      lo += blo;
      hi += bhi;
      const key = zBindingKey(b, interner);
      const prior = terms.get(key);
      terms.set(key, { count: (prior?.count ?? 0) + 1, interval: [blo, bhi] });
    }
  }
  return {
    sprite,
    interval: [lo, hi],
    roundedLo: Math.round(lo),
    roundedHi: Math.round(hi),
    terms,
  };
}

interface RelativeZRange {
  lo: number;
  hi: number;
  /** False when every dynamic contribution cancels exactly. */
  hasUnmatchedTerms: boolean;
}

/**
 * Conservative interval for a - b. Contributions described by the same
 * function cancel before ranges are combined, preserving obvious parameter
 * correlation that independent effective-z intervals lose.
 */
function relativeZRange(a: EffectiveZSummary, b: EffectiveZSummary): RelativeZRange {
  let lo = a.sprite.z - b.sprite.z;
  let hi = lo;
  let hasUnmatchedTerms = false;

  for (const [key, term] of a.terms) {
    const count = term.count - (b.terms.get(key)?.count ?? 0);
    if (count === 0) continue;
    if (term.interval[0] !== term.interval[1]) hasUnmatchedTerms = true;
    if (count > 0) {
      lo += count * term.interval[0];
      hi += count * term.interval[1];
    } else {
      lo += count * term.interval[1];
      hi += count * term.interval[0];
    }
  }
  for (const [key, term] of b.terms) {
    if (a.terms.has(key)) continue;
    if (term.interval[0] !== term.interval[1]) hasUnmatchedTerms = true;
    lo -= term.count * term.interval[1];
    hi -= term.count * term.interval[0];
  }
  return { lo, hi, hasUnmatchedTerms };
}

function heapComesFirst(a: EffectiveZSummary, b: EffectiveZSummary): boolean {
  return (
    a.roundedHi < b.roundedHi || (a.roundedHi === b.roundedHi && a.sprite.order < b.sprite.order)
  );
}

function heapPush(heap: EffectiveZSummary[], value: EffectiveZSummary): void {
  let index = heap.length;
  heap.push(value);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heapComesFirst(heap[parent]!, value)) break;
    heap[index] = heap[parent]!;
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap: EffectiveZSummary[]): EffectiveZSummary | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (first === undefined || last === first) return first;

  let index = 0;
  heap[0] = last!;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    let child = left;
    if (right < heap.length && heapComesFirst(heap[right]!, heap[left]!)) child = right;
    if (heapComesFirst(heap[index]!, heap[child]!)) break;
    [heap[index], heap[child]] = [heap[child]!, heap[index]!];
    index = child;
  }
  return first;
}

function displayRange([lo, hi]: readonly [number, number]): string {
  return `[${Object.is(lo, -0) ? 0 : lo}, ${Object.is(hi, -0) ? 0 : hi}]`;
}

export function lintModel(model: Model): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const warn = (code: string, message: string, id?: string): void => {
    issues.push(
      id !== undefined
        ? { level: "warning", code, message, id }
        : { level: "warning", code, message },
    );
  };

  const zBindings = new Map<AnyNode, Binding[]>();
  for (const b of model.bindings) {
    if (b.property !== "z") continue;
    const list = zBindings.get(b.target);
    if (list) list.push(b);
    else zBindings.set(b.target, [b]);
  }

  // Lint 1 (§12): sprite z binding on the same parameter as an ancestor's —
  // likely stale or conflicting authoring.
  let conflictChecks = 0;
  let conflictWarnings = 0;
  let conflictTruncated: string | null = null;
  conflictScan: for (const sprite of model.sprites) {
    const own = zBindings.get(sprite) ?? [];
    if (own.length === 0) continue;
    const ownParams = new Set(own.flatMap((b) => b.params.map((p) => p.id)));
    for (const anc of ancestors(sprite)) {
      for (const b of zBindings.get(anc) ?? []) {
        for (const p of b.params) {
          conflictChecks++;
          if (conflictChecks > MAX_Z_CONFLICT_CHECKS) {
            conflictTruncated = `candidate budget (${MAX_Z_CONFLICT_CHECKS})`;
            break conflictScan;
          }
          if (ownParams.has(p.id)) {
            warn(
              "z_conflict",
              `sprite "${sprite.id}" and ancestor "${anc.id}" both bind z to parameter "${p.id}"`,
              sprite.id,
            );
            conflictWarnings++;
            if (conflictWarnings >= MAX_Z_CONFLICT_WARNINGS) {
              conflictTruncated = `warning budget (${MAX_Z_CONFLICT_WARNINGS})`;
              break conflictScan;
            }
          }
        }
      }
    }
  }
  if (conflictTruncated !== null) {
    warn(
      "z_conflict_analysis_truncated",
      `z-conflict analysis stopped at its ${conflictTruncated}; additional binding combinations were not analyzed`,
    );
  }

  // Lint 2 (§12): conservative screening for a possible rounded effective-z
  // tie. This is intentionally not called "reachable": ranges from bindings
  // that share parameters can over-approximate the combinations that actually
  // occur. Equal contribution functions are cancelled first, which handles
  // shared-ancestor motion and other identical correlated functions exactly.
  //
  // Constant equal z (and equal shared motion) is deliberate layering resolved
  // by document order, so pairs with no unmatched contribution are not flagged.
  const summaryBudget = { bindingVisits: 0 };
  const zFunctionInterner: ZBindingInterner = {
    keys: new WeakMap(),
    buckets: new Map(),
    nextKey: 0,
  };
  const summaries: EffectiveZSummary[] = [];
  let truncated: string | null = null;
  for (const sprite of model.sprites) {
    const summary = effectiveZSummary(sprite, zBindings, summaryBudget, zFunctionInterner);
    if (!summary) {
      truncated = `binding-visit budget (${MAX_Z_TIE_BINDING_VISITS})`;
      summaries.length = 0;
      break;
    }
    summaries.push(summary);
  }
  summaries.sort(
    (a, b) =>
      a.roundedLo - b.roundedLo || a.roundedHi - b.roundedHi || a.sprite.order - b.sprite.order,
  );
  const active = new Set<EffectiveZSummary>();
  const expiryHeap: EffectiveZSummary[] = [];
  let pairChecks = 0;
  let tieWarnings = 0;

  scan: for (const current of truncated === null ? summaries : []) {
    while (expiryHeap[0] !== undefined && expiryHeap[0]!.roundedHi < current.roundedLo) {
      active.delete(heapPop(expiryHeap)!);
    }

    for (const prior of active) {
      pairChecks++;
      if (pairChecks > MAX_Z_TIE_PAIR_CHECKS) {
        truncated = `candidate-pair budget (${MAX_Z_TIE_PAIR_CHECKS})`;
        break scan;
      }

      const relative = relativeZRange(prior, current);
      if (!relative.hasUnmatchedTerms) continue;
      // Values whose difference is at least one cannot round to the same
      // integer. Intersecting (-1, 1) is necessary, but not sufficient.
      if (relative.lo >= 1 || relative.hi <= -1) continue;

      warn(
        "z_tie_possible",
        `sprites "${prior.sprite.id}" and "${current.sprite.id}" may tie after effective z is rounded (conservative ranges ${displayRange(prior.interval)} and ${displayRange(current.interval)} overlap; relative range ${displayRange([relative.lo, relative.hi])})`,
        prior.sprite.id,
      );
      tieWarnings++;
      if (tieWarnings >= MAX_Z_TIE_WARNINGS) {
        truncated = `warning budget (${MAX_Z_TIE_WARNINGS})`;
        break scan;
      }
    }
    active.add(current);
    heapPush(expiryHeap, current);
  }

  if (truncated !== null) {
    warn(
      "z_tie_analysis_truncated",
      `possible z-tie analysis stopped at its ${truncated}; additional overlapping sprite pairs were not analyzed`,
    );
  }

  // Lint 3 (§12/§10.3): a mask source that can be variant-excluded while its
  // clipped sprite stays active clips against nothing in that state.
  //
  // A selection is one option from every slot, not "one changed slot while
  // every other slot stays at its default". For each ancestor chain, retain
  // the option requirements per slot. A source can be absent while its target
  // remains present exactly when some option satisfies every target
  // requirement for a slot but fails at least one source requirement.
  const variantMemberships = indexVariantMembership(model);
  const optionIdsBySlot = new Map(
    model.variantSlots.map((slot) => [slot.id, slot.options.map((option) => option.id)]),
  );
  const constraintCache = new Map<AnyNode, VariantConstraints>();
  const constraintsFor = (node: AnyNode): VariantConstraints => {
    let constraints = constraintCache.get(node);
    if (!constraints) {
      constraints = variantConstraints(node, variantMemberships);
      constraintCache.set(node, constraints);
    }
    return constraints;
  };
  let maskVariantChecks = 0;
  let maskVariantWarnings = 0;
  let maskTruncated: string | null = null;
  const chargeCandidate = (): boolean => {
    maskVariantChecks++;
    if (maskVariantChecks <= MAX_MASK_VARIANT_CHECKS) return true;
    maskTruncated = `candidate-selection budget (${MAX_MASK_VARIANT_CHECKS})`;
    return false;
  };
  const accepts = (requirements: readonly VariantMembership[], optionId: string): boolean =>
    requirements.every((membership) => membership.optionIds.has(optionId));
  const smallestPool = (requirements: readonly VariantMembership[]): ReadonlySet<string> => {
    let smallest = requirements[0]!.optionIds;
    for (let i = 1; i < requirements.length; i++) {
      const candidate = requirements[i]!.optionIds;
      if (candidate.size < smallest.size) smallest = candidate;
    }
    return smallest;
  };
  const targetFeasibility = new Map<AnyNode, boolean>();
  const targetCanBeActive = (node: AnyNode, constraints: VariantConstraints): boolean | null => {
    const cached = targetFeasibility.get(node);
    if (cached !== undefined) return cached;
    for (const requirements of constraints.values()) {
      let found = false;
      for (const optionId of smallestPool(requirements)) {
        if (!chargeCandidate()) return null;
        if (accepts(requirements, optionId)) {
          found = true;
          break;
        }
      }
      if (!found) {
        targetFeasibility.set(node, false);
        return false;
      }
    }
    targetFeasibility.set(node, true);
    return true;
  };

  maskScan: for (const sprite of model.sprites) {
    if (!sprite.mask) continue;
    const spriteConstraints = constraintsFor(sprite);
    const spriteFeasible = targetCanBeActive(sprite, spriteConstraints);
    if (spriteFeasible === null) break maskScan;
    if (!spriteFeasible) continue;

    for (const source of sprite.mask.sources) {
      const sourceConstraints = constraintsFor(source);
      for (const [slotId, sourceRequirements] of sourceConstraints) {
        const spriteRequirements = spriteConstraints.get(slotId) ?? [];
        const candidates =
          spriteRequirements.length > 0
            ? smallestPool(spriteRequirements)
            : optionIdsBySlot.get(slotId)!;
        for (const optionId of candidates) {
          if (!chargeCandidate()) break maskScan;
          if (accepts(spriteRequirements, optionId) && !accepts(sourceRequirements, optionId)) {
            warn(
              "excludable_mask_source",
              `mask source "${source.id}" of sprite "${sprite.id}" is excluded in a jointly feasible selection where slot "${slotId}" selects "${optionId}", but the clipped sprite stays active`,
              sprite.id,
            );
            maskVariantWarnings++;
            if (maskVariantWarnings >= MAX_MASK_VARIANT_WARNINGS) {
              maskTruncated = `warning budget (${MAX_MASK_VARIANT_WARNINGS})`;
              break maskScan;
            }
            break;
          }
        }
      }
    }
  }

  if (maskTruncated !== null) {
    warn(
      "mask_variant_analysis_truncated",
      `mask/variant analysis stopped at its ${maskTruncated}; additional source/selection combinations were not analyzed`,
    );
  }

  return issues;
}
