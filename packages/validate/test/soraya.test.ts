import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime } from "@refrain-lyre/core";
import { describe, expect, it } from "vitest";
import { compareSurfaces } from "../src/conformance.js";
import { decodePngFile, loadContainerDir } from "../src/container.js";
import { restPoseRender } from "../src/restpose.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const examplePath = resolve(repositoryRoot, "examples/soraya.lyre");

describe("real-world Soraya example", () => {
  it("reconstructs the archived source composite at Lyre rest", () => {
    const container = loadContainerDir(examplePath);
    try {
      const actual = restPoseRender(container);
      const source = decodePngFile(resolve(examplePath, "source/original/fallback.png"));
      expect(source.width).toBe(container.model.canvas.width);
      expect(source.height).toBe(container.model.canvas.height);
      const comparison = compareSurfaces(source.data, actual, source.width);
      expect(comparison).toMatchObject({ pass: true });
      // Only isolated antialiased eye-mask edge pixels differ from the source
      // renderer; keep that discrepancy small and non-growing.
      expect(comparison.outOfTolerancePixels).toBeLessThanOrEqual(32);
      expect(comparison.largestCatastrophicRegion).toBeLessThanOrEqual(4);
    } finally {
      container.source.close();
    }
  });

  it("has a non-vacuous looping idle pose", () => {
    const container = loadContainerDir(examplePath);
    try {
      const runtime = createRuntime(container.model);
      const rest = runtime.evaluate();
      runtime.playMotion("idle");
      runtime.update(4);
      const animated = runtime.evaluate();
      let largestDelta = 0;
      for (let itemIndex = 0; itemIndex < rest.drawList.length; itemIndex++) {
        const before = rest.drawList[itemIndex]!;
        const after = animated.drawList[itemIndex]!;
        for (let index = 0; index < before.positions.length; index++) {
          largestDelta = Math.max(
            largestDelta,
            Math.abs(after.positions[index]! - before.positions[index]!),
          );
        }
      }
      expect(largestDelta).toBeGreaterThan(5);
    } finally {
      container.source.close();
    }
  });
});
