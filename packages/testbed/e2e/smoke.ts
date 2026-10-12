// Testbed smoke tests: boot the Vite server and exercise rendering, generated
// controls, model-load races/errors, and CPU comparison in headless Chromium.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const viewerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(viewerRoot, "..", "..");

async function main(): Promise<number> {
  const failures: string[] = [];
  const pageErrors: string[] = [];
  let outsideDir: string | null = null;
  let symlinkPath: string | null = null;
  let server: ViteDevServer | null = null;
  let browser: Browser | null = null;

  try {
    // A symlinked model directory used to let the custom dev API read outside
    // examples/. Keep the target in OS temp storage and remove both afterward.
    outsideDir = mkdtempSync(join(tmpdir(), "lyre-testbed-outside-"));
    const secret = "testbed must not serve this outside file";
    writeFileSync(join(outsideDir, "secret.txt"), secret);
    const symlinkName = `.testbed-${basename(outsideDir)}.lyre`;
    const pendingSymlinkPath = join(repoRoot, "examples", symlinkName);
    symlinkSync(outsideDir, pendingSymlinkPath, "dir");
    // Only record a path we actually created; if symlinkSync throws, cleanup
    // must not remove an entry owned by another process.
    symlinkPath = pendingSymlinkPath;

    server = await createServer({ root: viewerRoot });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (!url) throw new Error("vite dev server has no local url");

    browser = await chromium.launch({
      headless: true,
      args: ["--use-angle=swiftshader", "--disable-gpu-compositing"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      (window as unknown as { __lyreHostMessages: number }).__lyreHostMessages = 0;
      window.onmessage = (event) => {
        if (event.data?.type === "lyre-host-probe") {
          (window as unknown as { __lyreHostMessages: number }).__lyreHostMessages++;
        }
      };
    });

    const selectModel = async (path: string): Promise<void> => {
      await page.locator("#model-picker").selectOption(path);
      const label = path.split("/").pop()!;
      await page.waitForFunction(
        (expected) => document.querySelector("#status")?.textContent === `Loaded ${expected}`,
        label,
      );
    };

    const checkGoldenTimeline = async (
      timeline: string,
      captures: { index: number; step: number }[],
    ): Promise<void> => {
      await page.locator("#timeline-picker").selectOption(timeline);
      await page.waitForFunction((expectedTimeline) => {
        const picker = document.querySelector<HTMLSelectElement>("#timeline-picker");
        const step = document.querySelector("#golden-step")?.textContent;
        const verdict = document.querySelector("#golden-verdict")?.textContent ?? "";
        return (
          picker?.value === expectedTimeline &&
          step === "step 0" &&
          /^(?:PASS|FAIL|ERROR)/.test(verdict)
        );
      }, timeline);

      for (const capture of captures) {
        await page.locator("#golden-scrub").evaluate((element, index) => {
          const input = element as HTMLInputElement;
          input.value = String(index);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }, capture.index);
        await page.waitForFunction(
          ({ expectedTimeline, expectedStep }) => {
            const picker = document.querySelector<HTMLSelectElement>("#timeline-picker");
            const step = document.querySelector("#golden-step")?.textContent;
            const verdict = document.querySelector("#golden-verdict")?.textContent ?? "";
            return (
              picker?.value === expectedTimeline &&
              step === `step ${expectedStep}` &&
              /^(?:PASS|FAIL|ERROR)/.test(verdict)
            );
          },
          { expectedTimeline: timeline, expectedStep: capture.step },
        );
        const verdict = await page.locator("#golden-verdict").textContent();
        if (!verdict?.startsWith("PASS")) {
          failures.push(`${timeline} capture ${capture.step}: ${verdict}`);
        }
        const previews = await page.locator("#golden-images figure").count();
        if (previews !== 3) {
          failures.push(
            `${timeline} capture ${capture.step}: expected 3 golden previews, got ${previews}`,
          );
        }
        console.log(`${timeline} capture ${capture.step}: ${verdict}`);
      }
    };

    await page.goto(
      `${url}#model=${encodeURIComponent("conformance/models/m06_multiparam_grids.lyre")}`,
    );

    // 1. Live view renders and controls are generated from a focused fixture.
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent === "Loaded m06_multiparam_grids.lyre",
    );

    const preservedHostMessages = await page.evaluate(async () => {
      window.postMessage({ type: "lyre-host-probe" }, "*");
      await new Promise((resolveProbe) => setTimeout(resolveProbe, 50));
      return (window as unknown as { __lyreHostMessages: number }).__lyreHostMessages;
    });
    if (preservedHostMessages !== 1) {
      failures.push("the testbed replaced the host window.onmessage handler");
    }

    const devApiSafety = await page.evaluate(
      async ({ escapedFile, modelPath }) => {
        const [indexResponse, escapedResponse, inventoryResponse] = await Promise.all([
          fetch("/__lyre/index"),
          fetch(`/__lyre/file?path=${encodeURIComponent(escapedFile)}`),
          fetch(`/__lyre/inventory?path=${encodeURIComponent(modelPath)}`),
        ]);
        const index = (await indexResponse.json()) as { models: string[] };
        const escapedBody = await escapedResponse.text();
        const inventory = inventoryResponse.ok
          ? ((await inventoryResponse.json()) as { files: { path: string; size: number }[] })
          : null;
        return {
          models: index.models,
          escapedStatus: escapedResponse.status,
          escapedBody,
          inventoryStatus: inventoryResponse.status,
          inventory,
        };
      },
      {
        escapedFile: `examples/${symlinkName}/secret.txt`,
        modelPath: "conformance/models/m06_multiparam_grids.lyre",
      },
    );
    if (devApiSafety.models.includes(`examples/${symlinkName}`)) {
      failures.push("the model index followed a symlinked .lyre directory");
    }
    if (devApiSafety.escapedStatus !== 404 || devApiSafety.escapedBody.includes(secret)) {
      failures.push("the dev file API served a symlink target outside the repository");
    }
    if (
      devApiSafety.inventoryStatus !== 200 ||
      !devApiSafety.inventory?.files.some(
        (entry) => entry.path === "manifest.json" && entry.size > 0,
      )
    ) {
      failures.push("the dev inventory API did not describe the complete model container");
    }

    await page.waitForSelector("#controls .param-row input[type=range]");
    const sliders = await page.locator("#controls input[type=range]").count();
    if (sliders < 5) failures.push(`expected ≥5 generated sliders, got ${sliders}`);

    await page.waitForTimeout(500); // let a few frames render
    const shot = PNG.sync.read(await page.locator("#gl").screenshot());
    const colors = new Set<number>();
    for (let o = 0; o < shot.data.length; o += 4) {
      colors.add((shot.data[o]! << 16) | (shot.data[o + 1]! << 8) | shot.data[o + 2]!);
      if (colors.size > 8) break;
    }
    if (colors.size <= 8) failures.push(`live canvas looks blank (${colors.size} colors)`);

    const fps = await page.locator("#fps").textContent();
    if (!fps?.includes("fps")) failures.push("fps readout missing");

    // 2. CPU snapshot compare passes at the §12 tolerance.
    await page.click("#cpu-compare");
    await page.waitForFunction(() => {
      const el = document.querySelector("#compare-verdict");
      return /^(?:PASS|FAIL|ERROR)/.test(el?.textContent ?? "");
    });
    const verdict = await page.locator("#compare-verdict").textContent();
    if (!verdict?.startsWith("PASS")) failures.push(`CPU compare verdict: ${verdict}`);
    if (!verdict?.includes("largest region") || !verdict.includes("/8 px")) {
      failures.push(`CPU compare omitted catastrophic-region guard: ${verdict}`);
    }
    console.log(`cpu compare: ${verdict}`);

    if (/^(?:PASS|FAIL)/.test(verdict ?? "")) {
      await page.locator("#preview-backdrop").selectOption("dark");
      const previewAlpha = await page
        .locator("#compare-images canvas")
        .first()
        .evaluate((canvas) => {
          const context = (canvas as HTMLCanvasElement).getContext("2d")!;
          return context.getImageData(0, 0, 1, 1).data[3];
        });
      if (previewAlpha !== 255) failures.push("surface preview was not composited opaquely");
    }

    // 3. Golden scrubbing exercises the endpoint-sensitive physics captures.
    await checkGoldenTimeline("m14_physics", [
      { index: 3, step: 420 },
      { index: 4, step: 599 },
    ]);
    await checkGoldenTimeline("m15_physics_variant_skip", [
      { index: 2, step: 149 },
      { index: 3, step: 299 },
    ]);

    // 4. Expression weights cannot activate an unchecked expression.
    await selectModel("conformance/models/m11_expressions.lyre");
    const expressionToggle = page.getByLabel("exp_add expression active");
    const expressionWeight = page.getByLabel("exp_add expression weight");
    if (!(await expressionWeight.isDisabled())) {
      failures.push("inactive expression weight is not disabled");
    }
    const beforeExpression = PNG.sync.read(await page.locator("#gl").screenshot()).data;
    await expressionWeight.evaluate((input) => {
      (input as HTMLInputElement).value = "0.5";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(100);
    const afterExpression = PNG.sync.read(await page.locator("#gl").screenshot()).data;
    if (!beforeExpression.equals(afterExpression)) {
      failures.push("changing an unchecked expression weight changed the live render");
    }
    await expressionToggle.check();
    if (await expressionWeight.isDisabled())
      failures.push("active expression weight stayed disabled");
    await expressionWeight.fill("0.4");
    await page.waitForTimeout(100);
    const heldExpression = PNG.sync.read(await page.locator("#gl").screenshot()).data;
    await expressionToggle.uncheck();
    if (!(await expressionWeight.isDisabled())) {
      failures.push("deactivated expression weight stayed enabled");
    }
    await expressionToggle.check();
    await page.waitForTimeout(100);
    const reactivatedExpression = PNG.sync.read(await page.locator("#gl").screenshot()).data;
    if (!heldExpression.equals(reactivatedExpression)) {
      failures.push("reactivating an expression did not restore its visible slider weight");
    }
    if ((await expressionWeight.inputValue()) !== "0.4") {
      failures.push("expression weight changed visually during reactivation");
    }

    // 5. Motion weights are safe before Play and update while active.
    await selectModel("conformance/models/m12_motions.lyre");
    const motionWeight = page.getByLabel("wave motion weight");
    await motionWeight.fill("0.35");
    await page.locator('button[data-motion="wave"][data-action="play"]').click();
    await motionWeight.fill("0.7");
    await page.locator('button[data-motion="wave"][data-action="stop"]').click();

    // 6. The full-size real-world example loads, animates in WebGL, and exposes
    // its translated expression without relying on the synthetic fixtures.
    await selectModel("examples/soraya.lyre");
    const sorayaParams = await page
      .locator("#controls section")
      .first()
      .locator(".param-row")
      .count();
    if (sorayaParams !== 18) {
      failures.push(`expected 18 Soraya parameters, got ${sorayaParams}`);
    }
    const sorayaRest = await page.locator("#gl").screenshot();
    await page.locator('button[data-motion="idle"][data-action="play"]').click();
    await page.waitForTimeout(500);
    const sorayaAnimated = await page.locator("#gl").screenshot();
    if (sorayaRest.equals(sorayaAnimated)) {
      failures.push("Soraya idle motion did not change the WebGL render");
    }
    const sorayaEyes = page.getByLabel("eyes_closed expression active");
    await sorayaEyes.check();
    if (!(await sorayaEyes.isChecked())) {
      failures.push("Soraya eyes_closed expression could not be activated");
    }
    await page.locator('button[data-motion="idle"][data-action="stop"]').click();

    // 7. A slow, stale model request cannot overwrite a newer selection.
    let delayedManifest = false;
    const delayOldLoad = async (route: import("playwright").Route): Promise<void> => {
      const path = decodeURIComponent(
        new URL(route.request().url()).searchParams.get("path") ?? "",
      );
      if (!delayedManifest && path.endsWith("m11_expressions.lyre/manifest.json")) {
        delayedManifest = true;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      }
      await route.continue();
    };
    await page.route("**/__lyre/file?*", delayOldLoad);
    await page.locator("#model-picker").selectOption("conformance/models/m11_expressions.lyre");
    await page.locator("#model-picker").selectOption("conformance/models/m12_motions.lyre");
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent === "Loaded m12_motions.lyre",
    );
    await page.waitForTimeout(350);
    if ((await page.locator("#status").textContent()) !== "Loaded m12_motions.lyre") {
      failures.push("a stale model load replaced the latest selection");
    }
    if ((await page.locator('button[data-motion="wave"]').count()) === 0) {
      failures.push("latest model controls were replaced by stale controls");
    }
    await page.unroute("**/__lyre/file?*", delayOldLoad);

    // 8. Load failures are visible instead of becoming unhandled rejections.
    const failManifest = async (route: import("playwright").Route): Promise<void> => {
      const path = decodeURIComponent(
        new URL(route.request().url()).searchParams.get("path") ?? "",
      );
      if (path.endsWith("m03_rotators_nested.lyre/manifest.json")) {
        await route.fulfill({ status: 500, body: "intentional smoke-test failure" });
      } else {
        await route.continue();
      }
    };
    await page.route("**/__lyre/file?*", failManifest);
    await page.locator("#model-picker").selectOption("conformance/models/m03_rotators_nested.lyre");
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        ?.textContent?.startsWith("Could not load m03_rotators_nested.lyre:"),
    );
    if (!(await page.locator("#status").getAttribute("class"))?.includes("error")) {
      failures.push("model load error was not visibly styled");
    }
    await page.unroute("**/__lyre/file?*", failManifest);

    // 9. A worker-script failure prevents a false "Loaded" state, and a later
    // model selection can recover with a fresh worker.
    const failWorkerScript = async (route: import("playwright").Route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: 'throw new Error("intentional CPU worker startup failure");',
      });
    };
    await page.route("**/src/worker.ts*", failWorkerScript);
    await page.locator("#model-picker").selectOption("conformance/models/m03_rotators_nested.lyre");
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        ?.textContent?.includes("CPU renderer initialization failed"),
    );
    if ((await page.locator("#status").textContent())?.startsWith("Loaded")) {
      failures.push("the testbed claimed a model loaded before its CPU worker initialized");
    }
    await page.unroute("**/src/worker.ts*", failWorkerScript);
    await selectModel("conformance/models/m03_rotators_nested.lyre");
  } finally {
    const closeResults = await Promise.allSettled([
      browser?.close() ?? Promise.resolve(),
      server?.close() ?? Promise.resolve(),
    ]);
    for (const result of closeResults) {
      if (result.status === "rejected") {
        failures.push(
          `resource cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
    if (symlinkPath) {
      try {
        rmSync(symlinkPath, { force: true });
      } catch (error) {
        failures.push(
          `symlink cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (outsideDir) {
      try {
        rmSync(outsideDir, { recursive: true, force: true });
      } catch (error) {
        failures.push(
          `temporary-directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    return 1;
  }
  if (pageErrors.length > 0) {
    for (const error of pageErrors) console.error(`FAIL page error: ${error}`);
    return 1;
  }
  console.log("testbed smoke: all checks passed");
  return 0;
}

process.exit(await main());
