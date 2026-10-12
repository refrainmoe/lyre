import type { AnyNode, Model } from "./types/model.js";

/**
 * §10.3: nodes listed by any option of a slot exist only while a listing
 * option is active. Returns the set of *directly* excluded nodes for the given
 * active options; subtree expansion happens during tree traversal.
 */
export function computeExcludedNodes(
  model: Model,
  activeOptions: ReadonlyMap<string, string>,
): Set<AnyNode> {
  const excluded = new Set<AnyNode>();
  for (const slot of model.variantSlots) {
    const activeId = activeOptions.get(slot.id) ?? slot.default;
    const active = slot.options.find((o) => o.id === activeId);
    const activeNodes = new Set(active?.nodes ?? []);
    for (const option of slot.options) {
      for (const node of option.nodes) {
        if (!activeNodes.has(node)) excluded.add(node);
      }
    }
  }
  return excluded;
}
