import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("published package metadata", () => {
  it("declares a clean declaration-generating prepack contract", () => {
    const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const packageJson = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      publishConfig: {
        exports: {
          ".": { types: string; default: string };
          "./schemas/*.json": string;
        };
      };
    };

    expect(packageJson.scripts.build).toContain("tsup");
    expect(packageJson.scripts.build).toContain("tsc --build --force");
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.scripts.prepublishOnly).toBe("node ../../tools/prepublish.mjs");
    expect(packageJson.publishConfig.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(packageJson.publishConfig.exports["./schemas/*.json"]).toBe("./schemas/*.json");
  });
});
