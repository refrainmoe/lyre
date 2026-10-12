import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("published validator package", () => {
  it("has a clean declaration-generating prepack contract", () => {
    const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      publishConfig: { exports: { ".": { types: string; default: string } } };
      bin: Record<string, string>;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.scripts.build).toContain("pnpm clean");
    expect(packageJson.scripts.build).toContain("tsup");
    expect(packageJson.scripts.build).toContain("tsc --build --force");
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.scripts.prepublishOnly).toBe("node ../../tools/prepublish.mjs");

    // The library and its consumers must resolve one core module identity;
    // the workspace link is retained solely for local build and test tools.
    expect(packageJson.dependencies?.["@refrain-lyre/core"]).toBeUndefined();
    expect(packageJson.peerDependencies?.["@refrain-lyre/core"]).toBe("^0.1.0");
    expect(packageJson.devDependencies?.["@refrain-lyre/core"]).toBe("workspace:*");

    expect(packageJson.publishConfig.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(packageJson.bin).toEqual({ "lyre-validate": "./dist/cli.js" });
  });

  it("externalizes workspace runtimes from the library but bundles them into the CLI", () => {
    const config = readFileSync(resolve(packageDir, "tsup.config.ts"), "utf8");
    expect(config).toMatch(
      /entry:\s*\{ index: "src\/index\.ts" \}[\s\S]*external: workspacePackages/,
    );
    expect(config).toMatch(
      /entry:\s*\{ cli: "src\/cli\.ts" \}[\s\S]*noExternal: workspacePackages/,
    );
  });
});
