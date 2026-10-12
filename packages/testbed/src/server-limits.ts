/**
 * Primitive limits used while Node loads vite.config.ts.
 *
 * They intentionally contain no workspace-package imports: Vite's config is
 * evaluated before its application resolver can consume TypeScript workspace
 * exports. test/unit.ts pins every value to @refrain-lyre/core so this local
 * config boundary cannot drift from the runtime's published ceilings.
 */
export const TESTBED_SERVER_LIMITS = Object.freeze({
  containerFiles: 4096,
  containerUncompressedBytes: 2 * 1024 * 1024 * 1024,
  jsonFileBytes: 64 * 1024 * 1024,
  containerTraversalEntries: 8192,
  containerPathBytes: 4096,
  containerPathMetadataBytes: 8 * 1024 * 1024,
});
