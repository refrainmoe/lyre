// Annex A — standard parameter registry (normative ranges/defaults).

export interface RegistryEntry {
  min: number;
  max: number;
  default: number;
}

export const LYRE_REGISTRY: ReadonlyMap<string, RegistryEntry> = new Map<string, RegistryEntry>([
  ["Lyre.AngleX", { min: -30, max: 30, default: 0 }],
  ["Lyre.AngleY", { min: -30, max: 30, default: 0 }],
  ["Lyre.AngleZ", { min: -30, max: 30, default: 0 }],
  ["Lyre.EyeLOpen", { min: 0, max: 1, default: 1 }],
  ["Lyre.EyeROpen", { min: 0, max: 1, default: 1 }],
  ["Lyre.EyeLSmile", { min: 0, max: 1, default: 0 }],
  ["Lyre.EyeRSmile", { min: 0, max: 1, default: 0 }],
  ["Lyre.EyeBallX", { min: -1, max: 1, default: 0 }],
  ["Lyre.EyeBallY", { min: -1, max: 1, default: 0 }],
  ["Lyre.BrowLY", { min: -1, max: 1, default: 0 }],
  ["Lyre.BrowRY", { min: -1, max: 1, default: 0 }],
  ["Lyre.MouthOpen", { min: 0, max: 1, default: 0 }],
  ["Lyre.MouthForm", { min: -1, max: 1, default: 0 }],
  ["Lyre.BodyAngleX", { min: -10, max: 10, default: 0 }],
  ["Lyre.BodyAngleY", { min: -10, max: 10, default: 0 }],
  ["Lyre.BodyAngleZ", { min: -10, max: 10, default: 0 }],
  ["Lyre.Breath", { min: 0, max: 1, default: 0 }],
  ["Lyre.Cheek", { min: 0, max: 1, default: 0 }],
  ["Lyre.CheekPuff", { min: 0, max: 1, default: 0 }],
  ["Lyre.TongueOut", { min: 0, max: 1, default: 0 }],
]);

/** Capabilities defined by spec 0.1 (§15). */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  "core",
  "physics",
  "motion",
  "variants",
]);
