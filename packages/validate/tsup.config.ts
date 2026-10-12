import { defineConfig } from "tsup";

const workspacePackages = [
  "@refrain-lyre/core",
  "@refrain-lyre/render-soft",
  "@refrain-lyre/schemas",
];

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    sourcemap: true,
    splitting: false,
    clean: false,
    // Library consumers must share the exact @refrain-lyre/core runtime identity.
    external: workspacePackages,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    sourcemap: true,
    splitting: false,
    clean: false,
    // The executable remains usable from the packed package without sibling
    // workspace packages being separately built or installed by path.
    noExternal: workspacePackages,
    banner: { js: "" },
  },
]);
