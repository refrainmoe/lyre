// @refrain-lyre/testbed — single-page visual validation app.
//
// Views: WebGL2 live render over a checkerboard, on-demand CPU snapshot
// compare (render-soft in a worker, §12 tolerance verdict + amplified diff),
// golden-timeline scrubbing against committed goldens, and a hit-test hover
// readout. Controls are generated from the loaded model.

import { LIMITS, RUNTIME_LIMITS, createRuntime, type LyreRuntime } from "@refrain-lyre/core";
import {
  CONTEXT_ATTRIBUTES,
  createWebGLRenderer,
  type WebGLRenderer,
} from "@refrain-lyre/render-webgl";
import {
  devApiSource,
  loadContainerFrom,
  readBoundedResponse,
  type BrowserContainer,
  type ByteSource,
} from "./container.js";
import { collectDroppedDirectory } from "./directory.js";
import { decodePng } from "./png.js";
import {
  CATASTROPHIC_CHANNEL_TOLERANCE,
  CATASTROPHIC_REGION_PIXEL_LIMIT,
  CHANNEL_TOLERANCE,
  compareSurfaces,
  compositeSurface,
  type PreviewBackdrop,
  type Surface,
} from "./surfaces.js";
import {
  stripFrame,
  type InitMessage,
  type WorkerResponse,
  type WorkerTexture,
} from "./worker-protocol.js";
import { parseTimelineBytes, TESTBED_TIMELINE_LIMITS, type TimelineDoc } from "./timeline.js";
import "./style.css";

interface DevIndex {
  models: string[];
  timelines: { id: string; path: string; model: string; captures: number[] }[];
}

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header>
    <h1>Lyre testbed</h1>
    <select id="model-picker"></select>
    <span id="drop-hint">or drop an unpacked .lyre directory anywhere</span>
    <span id="status" role="status" aria-live="polite"></span>
    <span id="fps"></span>
  </header>
  <main>
    <section id="stage">
      <div id="canvas-holder" class="checker"><canvas id="gl"></canvas></div>
      <div id="hit-readout">hover for hit-test</div>
      <label id="preview-backdrop-label">Surface preview backdrop
        <select id="preview-backdrop">
          <option value="checker">checker</option>
          <option value="dark">dark</option>
          <option value="light">light</option>
        </select>
      </label>
      <div id="compare-panel">
        <button id="cpu-compare">CPU snapshot compare</button>
        <span id="compare-verdict"></span>
        <div id="compare-images"></div>
      </div>
      <div id="golden-panel">
        <label>Golden timeline <select id="timeline-picker"><option value="">—</option></select></label>
        <label id="golden-scrub-label" hidden>capture <input id="golden-scrub" type="range" min="0" max="0" step="1" value="0" /> <span id="golden-step"></span></label>
        <span id="golden-verdict"></span>
        <div id="golden-images"></div>
      </div>
    </section>
    <aside id="controls"></aside>
  </main>
`;

const pickerEl = document.querySelector<HTMLSelectElement>("#model-picker")!;
const fpsEl = document.querySelector<HTMLSpanElement>("#fps")!;
const canvasEl = document.querySelector<HTMLCanvasElement>("#gl")!;
const controlsEl = document.querySelector<HTMLElement>("#controls")!;
const hitEl = document.querySelector<HTMLDivElement>("#hit-readout")!;
const statusEl = document.querySelector<HTMLSpanElement>("#status")!;
const compareButton = document.querySelector<HTMLButtonElement>("#cpu-compare")!;
const backdropPicker = document.querySelector<HTMLSelectElement>("#preview-backdrop")!;

let index: DevIndex = { models: [], timelines: [] };
let container: BrowserContainer | null = null;
let runtime: LyreRuntime | null = null;
let renderer: WebGLRenderer | null = null;
let worker: Worker | null = null;
let rafHandle = 0;
let loadGeneration = 0;
let compareRequestId = 0;
let pendingCompareCleanup: (() => void) | null = null;

const CPU_WORKER_TIMEOUT_MS = 15_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(text: string, kind: "" | "loading" | "error" = ""): void {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function disposeCurrentModel(): void {
  pendingCompareCleanup?.();
  pendingCompareCleanup = null;
  renderer?.dispose();
  worker?.terminate();
  renderer = null;
  worker = null;
  runtime = null;
  container = null;
}

function initializeCpuWorker(cpuWorker: Worker, message: InitMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      cpuWorker.removeEventListener("message", onMessage);
      cpuWorker.removeEventListener("error", onError);
      cpuWorker.removeEventListener("messageerror", onMessageError);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (event: MessageEvent<WorkerResponse>): void => {
      if (event.data.type === "ready") finish();
      else if (event.data.type === "error" && event.data.requestId === undefined) {
        finish(new Error(`CPU renderer initialization failed: ${event.data.message}`));
      }
    };
    const onError = (event: ErrorEvent): void => {
      event.preventDefault();
      finish(new Error(`CPU renderer initialization failed: ${event.message || "worker error"}`));
    };
    const onMessageError = (): void => {
      finish(new Error("CPU renderer initialization failed: unreadable worker response"));
    };
    const timeout = window.setTimeout(
      () => finish(new Error("CPU renderer initialization timed out")),
      CPU_WORKER_TIMEOUT_MS,
    );
    cpuWorker.addEventListener("message", onMessage);
    cpuWorker.addEventListener("error", onError);
    cpuWorker.addEventListener("messageerror", onMessageError);
    try {
      cpuWorker.postMessage(message);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// ---------------------------------------------------------------------------
// Live loop

function startLoop(): void {
  cancelAnimationFrame(rafHandle);
  let last = performance.now();
  let fpsEma = 0;
  const tick = (now: number): void => {
    rafHandle = requestAnimationFrame(tick);
    // A newly requested callback can inherit the current frame's timestamp,
    // which may be microscopically earlier than performance.now().
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (!runtime || !renderer) return;
    runtime.update(dt);
    renderer.render(runtime.evaluate());
    renderer.present();
    if (dt > 0) {
      fpsEma = fpsEma === 0 ? 1 / dt : fpsEma * 0.95 + (1 / dt) * 0.05;
      fpsEl.textContent = `${fpsEma.toFixed(0)} fps`;
    }
  };
  rafHandle = requestAnimationFrame(tick);
}

async function loadModel(pathOrSource: string | ByteSource): Promise<void> {
  const generation = ++loadGeneration;
  const label =
    typeof pathOrSource === "string"
      ? (pathOrSource.split("/").pop() ?? pathOrSource)
      : "dropped model";
  setStatus(`Loading ${label}…`, "loading");
  const source = typeof pathOrSource === "string" ? devApiSource(pathOrSource) : pathOrSource;
  let nextRenderer: WebGLRenderer | null = null;
  let nextWorker: Worker | null = null;

  try {
    const nextContainer = await loadContainerFrom(source);
    if (generation !== loadGeneration) return;
    const { model, textures } = nextContainer;
    const nextRuntime = createRuntime(model);
    const nextGl = canvasEl.getContext("webgl2", CONTEXT_ATTRIBUTES);
    if (!nextGl) throw new Error("WebGL2 unavailable");
    nextRenderer = createWebGLRenderer(nextGl, model.canvas.width, model.canvas.height);
    for (const [id, image] of textures) nextRenderer.setTexture(id, image);

    const createdWorker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    nextWorker = createdWorker;
    const workerTextures: WorkerTexture[] = [...textures].map(([id, image]) => ({
      id,
      width: image.width,
      height: image.height,
      data: image.data,
    }));
    await initializeCpuWorker(createdWorker, {
      type: "init",
      width: model.canvas.width,
      height: model.canvas.height,
      textures: workerTextures,
    });

    if (generation !== loadGeneration) {
      nextRenderer.dispose();
      nextWorker.terminate();
      return;
    }

    const previousRenderer = renderer;
    const previousWorker = worker;
    container = nextContainer;
    runtime = nextRuntime;
    renderer = nextRenderer;
    worker = nextWorker;
    nextRenderer = null;
    nextWorker = null;
    canvasEl.width = model.canvas.width;
    canvasEl.height = model.canvas.height;
    previousRenderer?.dispose();
    previousWorker?.terminate();

    const activeCpuWorker = worker;
    activeCpuWorker.addEventListener("error", (event) => {
      event.preventDefault();
      if (worker !== activeCpuWorker) return;
      activeCpuWorker.terminate();
      worker = null;
      compareButton.disabled = true;
      setStatus(`CPU renderer failed: ${event.message}`, "error");
    });
    activeCpuWorker.addEventListener("messageerror", () => {
      if (worker !== activeCpuWorker) return;
      activeCpuWorker.terminate();
      worker = null;
      compareButton.disabled = true;
      setStatus("CPU renderer failed: unreadable worker response", "error");
    });

    buildControls();
    clearComparison();
    setStatus(`Loaded ${label}`);
    startLoop();
  } catch (error) {
    nextRenderer?.dispose();
    nextWorker?.terminate();
    if (generation !== loadGeneration) return;
    setStatus(`Could not load ${label}: ${errorMessage(error)}`, "error");
    console.error(error);
  }
}

// ---------------------------------------------------------------------------
// Generated controls

function buildControls(): void {
  if (!runtime || !container) return;
  const { model } = container;
  const rt = runtime;
  controlsEl.innerHTML = "";
  const section = (title: string): HTMLElement => {
    const el = document.createElement("section");
    const h = document.createElement("h2");
    h.textContent = title;
    el.append(h);
    controlsEl.append(el);
    return el;
  };

  const params = section("Parameters");
  for (const p of model.params) {
    const row = document.createElement("label");
    row.className = "param-row";
    const name = document.createElement("span");
    name.textContent = p.id;
    const value = document.createElement("code");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(p.min);
    slider.max = String(p.max);
    slider.step = String((p.max - p.min) / 200);
    slider.value = String(p.default);
    value.textContent = p.default.toFixed(2);
    slider.addEventListener("input", () => {
      rt.setParam(p.id, Number(slider.value));
      value.textContent = Number(slider.value).toFixed(2);
    });
    const reset = document.createElement("button");
    reset.textContent = "×";
    reset.title = "release host input";
    reset.addEventListener("click", () => {
      rt.clearParam(p.id);
      slider.value = String(p.default);
      value.textContent = p.default.toFixed(2);
    });
    row.append(name, slider, value, reset);
    params.append(row);
  }

  if (model.expressions.length > 0) {
    const exprs = section("Expressions");
    for (const e of model.expressions) {
      const row = document.createElement("label");
      row.className = "param-row";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      const name = document.createElement("span");
      name.textContent = e.id;
      const weight = document.createElement("input");
      weight.type = "range";
      weight.min = "0";
      weight.max = "1";
      weight.step = "0.01";
      weight.value = "1";
      weight.disabled = true;
      toggle.setAttribute("aria-label", `${e.id} expression active`);
      weight.setAttribute("aria-label", `${e.id} expression weight`);
      toggle.addEventListener("change", () => {
        weight.disabled = !toggle.checked;
        if (toggle.checked) {
          rt.setExpression(e.id, true);
          const selectedWeight = Number(weight.value);
          // A weight edited during an earlier activation remains visible while
          // disabled, so reactivation must restore that held value rather than
          // silently targeting 1 behind a slider that still says otherwise.
          if (selectedWeight !== 1) rt.setExpressionWeight(e.id, selectedWeight);
        } else {
          rt.setExpression(e.id, false);
        }
      });
      weight.addEventListener("input", () => {
        if (toggle.checked) rt.setExpressionWeight(e.id, Number(weight.value));
      });
      row.append(toggle, name, weight);
      exprs.append(row);
    }
  }

  if (model.motions.length > 0) {
    const motions = section("Motions (start order layers)");
    for (const m of model.motions) {
      const row = document.createElement("div");
      row.className = "param-row";
      const name = document.createElement("span");
      name.textContent = `${m.id} (${m.duration}s${m.loop ? ", loop" : ""})`;
      const play = document.createElement("button");
      play.textContent = "play";
      const stop = document.createElement("button");
      stop.textContent = "stop";
      const weight = document.createElement("input");
      weight.type = "range";
      weight.min = "0";
      weight.max = "1";
      weight.step = "0.01";
      weight.value = "1";
      play.dataset.motion = m.id;
      play.dataset.action = "play";
      stop.dataset.motion = m.id;
      stop.dataset.action = "stop";
      weight.setAttribute("aria-label", `${m.id} motion weight`);
      let active = false;
      play.addEventListener("click", () => {
        rt.playMotion(m.id, Number(weight.value));
        active = true;
      });
      stop.addEventListener("click", () => {
        rt.stopMotion(m.id);
        active = false;
      });
      weight.addEventListener("input", () => {
        if (!active) return;
        try {
          rt.setMotionWeight(m.id, Number(weight.value));
        } catch (error) {
          // A non-looping motion may have completed since the last UI event.
          if (errorMessage(error).includes("is not active")) active = false;
          else throw error;
        }
      });
      row.append(name, play, stop, weight);
      motions.append(row);
    }
  }

  const slots = rt.listSlots();
  if (slots.length > 0) {
    const variants = section("Variants");
    for (const slot of slots) {
      const row = document.createElement("div");
      row.className = "param-row";
      const name = document.createElement("span");
      name.textContent = slot.id;
      row.append(name);
      for (const option of slot.options) {
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `variant-${slot.id}`;
        radio.checked = option === slot.active;
        radio.addEventListener("change", () => rt.setVariant(slot.id, option));
        label.append(radio, document.createTextNode(option));
        row.append(label);
      }
      variants.append(row);
    }
  }

  if (model.physics) {
    const phys = section("Physics");
    const row = document.createElement("div");
    row.className = "param-row";
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rt.physicsEnabled;
    toggle.addEventListener("change", () => (rt.physicsEnabled = toggle.checked));
    const label = document.createElement("span");
    label.textContent = "enabled";
    const reset = document.createElement("button");
    reset.textContent = "reset";
    reset.addEventListener("click", () => rt.resetPhysics());
    row.append(toggle, label, reset);
    phys.append(row);
  }
}

// ---------------------------------------------------------------------------
// Hit-test hover

canvasEl.addEventListener("mousemove", (e) => {
  if (!runtime) return;
  const rect = canvasEl.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvasEl.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvasEl.height;
  const hits = runtime.hitTest(x, y);
  hitEl.textContent = hits.length > 0 ? `hit: ${hits.join(", ")}` : "hit: —";
});
canvasEl.addEventListener("mouseleave", () => (hitEl.textContent = "hover for hit-test"));

// ---------------------------------------------------------------------------
// CPU snapshot compare

function selectedBackdrop(): PreviewBackdrop {
  const value = backdropPicker.value;
  return value === "dark" || value === "light" ? value : "checker";
}

function surfaceToCanvas(surface: Surface): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = surface.width;
  out.height = surface.height;
  const ctx = out.getContext("2d")!;
  ctx.putImageData(
    new ImageData(
      new Uint8ClampedArray(compositeSurface(surface, selectedBackdrop())),
      surface.width,
      surface.height,
    ),
    0,
    0,
  );
  return out;
}

function diffHeatmap(a: Surface, b: Surface): HTMLCanvasElement {
  // Validate before rendering, including equal dimensions and byte lengths.
  compareSurfaces(a, b);
  const out = document.createElement("canvas");
  out.width = a.width;
  out.height = a.height;
  const ctx = out.getContext("2d")!;
  const img = ctx.createImageData(a.width, a.height);
  for (let o = 0; o < a.data.length; o += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) {
      d = Math.max(d, Math.abs(a.data[o + c]! - b.data[o + c]!));
    }
    img.data[o] = Math.min(255, d * 8);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function imageLabel(title: string, canvas: HTMLCanvasElement): HTMLElement {
  const box = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = title;
  box.append(caption, canvas);
  return box;
}

const compareVerdict = document.querySelector<HTMLSpanElement>("#compare-verdict")!;
const compareImages = document.querySelector<HTMLDivElement>("#compare-images")!;
let comparisonPreview: { cpu: Surface; gpu: Surface } | null = null;

function renderComparisonPreview(): void {
  compareImages.innerHTML = "";
  if (!comparisonPreview) return;
  const { cpu, gpu } = comparisonPreview;
  compareImages.append(
    imageLabel("CPU (render-soft)", surfaceToCanvas(cpu)),
    imageLabel("GPU (render-webgl)", surfaceToCanvas(gpu)),
    imageLabel("diff ×8", diffHeatmap(cpu, gpu)),
  );
}

function clearComparison(): void {
  pendingCompareCleanup?.();
  pendingCompareCleanup = null;
  comparisonPreview = null;
  compareVerdict.textContent = "";
  compareVerdict.className = "";
  compareImages.innerHTML = "";
  compareButton.disabled = false;
}

backdropPicker.addEventListener("change", () => {
  renderComparisonPreview();
  renderGoldenPreview();
});

compareButton.addEventListener("click", () => {
  const activeRuntime = runtime;
  const activeRenderer = renderer;
  const activeWorker = worker;
  const activeContainer = container;
  if (!activeRuntime || !activeRenderer || !activeWorker || !activeContainer) return;

  try {
    const { width, height } = activeContainer.model.canvas;
    const frame = activeRuntime.evaluate();
    activeRenderer.render(frame);
    const gpu: Surface = { data: activeRenderer.readSurface(), width, height };
    const requestId = ++compareRequestId;
    compareButton.disabled = true;
    comparisonPreview = null;
    compareImages.innerHTML = "";
    compareVerdict.className = "";
    compareVerdict.textContent = "rendering on CPU…";

    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      activeWorker.removeEventListener("message", onMessage);
      activeWorker.removeEventListener("error", onError);
      activeWorker.removeEventListener("messageerror", onMessageError);
      if (pendingCompareCleanup === cancel) pendingCompareCleanup = null;
    };
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (worker !== activeWorker || runtime !== activeRuntime) return;
      compareButton.disabled = false;
      compareVerdict.textContent = `ERROR — ${message}`;
      compareVerdict.className = "fail";
    };
    const onMessage = (event: MessageEvent<WorkerResponse>): void => {
      const response = event.data;
      if (response.type === "error" && response.requestId === requestId) {
        fail(response.message);
        return;
      }
      if (response.type !== "surface" || response.requestId !== requestId || settled) return;
      settled = true;
      cleanup();
      if (worker !== activeWorker || runtime !== activeRuntime) return;
      compareButton.disabled = false;
      try {
        const cpu: Surface = { data: response.surface, width, height };
        const comparison = compareSurfaces(cpu, gpu);
        comparisonPreview = { cpu, gpu };
        compareVerdict.textContent = comparison.pass
          ? `PASS — ${comparison.badPixels}/${comparison.totalPixels} px out of ±${CHANNEL_TOLERANCE}/255; ${comparison.catastrophicPixels} px exceed ±${CATASTROPHIC_CHANNEL_TOLERANCE}/255, largest region ${comparison.largestCatastrophicRegion}/${CATASTROPHIC_REGION_PIXEL_LIMIT} px (max diff ${comparison.maxDiff})`
          : `FAIL — ${comparison.badPixels}/${comparison.totalPixels} px out of ±${CHANNEL_TOLERANCE}/255; ${comparison.catastrophicPixels} px exceed ±${CATASTROPHIC_CHANNEL_TOLERANCE}/255, largest region ${comparison.largestCatastrophicRegion}/${CATASTROPHIC_REGION_PIXEL_LIMIT} px (max diff ${comparison.maxDiff})`;
        compareVerdict.className = comparison.pass ? "pass" : "fail";
        renderComparisonPreview();
      } catch (error) {
        compareVerdict.textContent = `ERROR — ${errorMessage(error)}`;
        compareVerdict.className = "fail";
      }
    };
    const onError = (event: ErrorEvent): void => {
      event.preventDefault();
      fail(event.message || "CPU renderer worker error");
    };
    const onMessageError = (): void => fail("unreadable CPU renderer response");
    const timeout = window.setTimeout(
      () => fail("CPU renderer request timed out"),
      CPU_WORKER_TIMEOUT_MS,
    );
    activeWorker.addEventListener("message", onMessage);
    activeWorker.addEventListener("error", onError);
    activeWorker.addEventListener("messageerror", onMessageError);
    pendingCompareCleanup = cancel;
    try {
      activeWorker.postMessage({ type: "render", requestId, ...stripFrame(frame) });
    } catch (error) {
      fail(errorMessage(error));
    }
  } catch (error) {
    compareButton.disabled = false;
    compareVerdict.textContent = `ERROR — ${errorMessage(error)}`;
    compareVerdict.className = "fail";
  }
});

// ---------------------------------------------------------------------------
// Golden timeline scrubbing

const timelinePicker = document.querySelector<HTMLSelectElement>("#timeline-picker")!;
const scrubLabel = document.querySelector<HTMLLabelElement>("#golden-scrub-label")!;
const scrub = document.querySelector<HTMLInputElement>("#golden-scrub")!;
const goldenStepEl = document.querySelector<HTMLSpanElement>("#golden-step")!;
const goldenVerdict = document.querySelector<HTMLSpanElement>("#golden-verdict")!;
const goldenImages = document.querySelector<HTMLDivElement>("#golden-images")!;

let goldenTimeline: { info: DevIndex["timelines"][number]; doc: TimelineDoc } | null = null;
let goldenPreview: { golden: Surface; actual: Surface } | null = null;
let goldenCaptureGeneration = 0;

async function fetchBytes(path: string, maxBytes: number): Promise<Uint8Array> {
  const res = await fetch(`/__lyre/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`missing ${path}`);
  return readBoundedResponse(res, path, maxBytes);
}

function renderGoldenPreview(): void {
  goldenImages.innerHTML = "";
  if (!goldenPreview) return;
  const { golden, actual } = goldenPreview;
  goldenImages.append(
    imageLabel("golden", surfaceToCanvas(golden)),
    imageLabel("WebGL", surfaceToCanvas(actual)),
    imageLabel("diff ×8", diffHeatmap(golden, actual)),
  );
}

function resolveTimelineModelPath(timelinePath: string, modelPath: string): string | null {
  if (modelPath.startsWith("/")) return null;
  const segments = timelinePath.split("/");
  segments.pop();
  for (const segment of modelPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

async function selectGoldenTimeline(): Promise<void> {
  const generation = ++goldenCaptureGeneration;
  const info = index.timelines.find((t) => t.id === timelinePicker.value);
  goldenVerdict.textContent = "";
  goldenVerdict.className = "";
  goldenPreview = null;
  goldenImages.innerHTML = "";
  if (!info) {
    goldenTimeline = null;
    scrubLabel.hidden = true;
    return;
  }
  goldenVerdict.textContent = "loading timeline…";
  try {
    const doc = parseTimelineBytes(
      await fetchBytes(info.path, TESTBED_TIMELINE_LIMITS.jsonBytes),
      info.path,
    );
    if (resolveTimelineModelPath(info.path, doc.model) !== info.model) {
      throw new Error(`${info.path} changed model after the testbed index was loaded`);
    }
    if (generation !== goldenCaptureGeneration) return;
    goldenTimeline = { info, doc };
    scrub.max = String(Math.max(0, (doc.captures?.length ?? 0) - 1));
    scrub.value = "0";
    scrubLabel.hidden = false;
    await showGoldenCapture();
  } catch (error) {
    if (generation !== goldenCaptureGeneration) return;
    goldenVerdict.textContent = `ERROR — ${errorMessage(error)}`;
    goldenVerdict.className = "fail";
  }
}

timelinePicker.addEventListener("change", () => void selectGoldenTimeline());
scrub.addEventListener("input", () => void showGoldenCapture());

async function showGoldenCapture(): Promise<void> {
  if (!goldenTimeline) return;
  const generation = ++goldenCaptureGeneration;
  const { info, doc } = goldenTimeline;
  const captureStep = (doc.captures ?? [])[Number(scrub.value)];
  if (captureStep === undefined) return;
  goldenStepEl.textContent = `step ${captureStep}`;
  goldenVerdict.textContent = "rendering capture…";
  goldenVerdict.className = "";
  goldenPreview = null;
  goldenImages.innerHTML = "";
  let timelineRenderer: WebGLRenderer | null = null;

  try {
    const timelineContainer = await loadContainerFrom(devApiSource(info.model));
    if (generation !== goldenCaptureGeneration) return;
    const { model, textures, atlasImage } = timelineContainer;
    const timelineRuntime = createRuntime(model);
    const offscreen = document.createElement("canvas");
    offscreen.width = model.canvas.width;
    offscreen.height = model.canvas.height;
    const timelineGl = offscreen.getContext("webgl2", CONTEXT_ATTRIBUTES);
    if (!timelineGl) throw new Error("WebGL2 unavailable");
    timelineRenderer = createWebGLRenderer(timelineGl, model.canvas.width, model.canvas.height);
    for (const [id, image] of textures) {
      const rect = doc.use_atlas ? model.atlas?.rects.get(id) : undefined;
      if (rect && atlasImage) timelineRenderer.setTexture(id, atlasImage, rect);
      else timelineRenderer.setTexture(id, image);
    }

    const byStep = new Map<number, NonNullable<TimelineDoc["events"]>>();
    for (const event of doc.events ?? []) {
      const list = byStep.get(event.step);
      if (list) list.push(event);
      else byStep.set(event.step, [event]);
    }
    const timelineDt = 1 / doc.fps;
    let elapsed = 0;
    for (let step = 0; step <= captureStep; step++) {
      for (const event of byStep.get(step) ?? []) {
        if (event.set) {
          for (const [id, value] of Object.entries(event.set)) {
            timelineRuntime.setParam(id, value);
          }
        }
        if (event.clear) for (const id of event.clear) timelineRuntime.clearParam(id);
        if (event.expression) {
          if (event.expression.weight !== undefined) {
            timelineRuntime.setExpressionWeight(event.expression.id, event.expression.weight);
          } else {
            timelineRuntime.setExpression(
              event.expression.id,
              event.expression.action !== "deactivate",
            );
          }
        }
        if (event.motion) {
          if (event.motion.action === "play") {
            timelineRuntime.playMotion(event.motion.id, event.motion.weight ?? 1);
          } else if (event.motion.action === "stop") {
            timelineRuntime.stopMotion(event.motion.id);
          } else {
            timelineRuntime.setMotionWeight(event.motion.id, event.motion.weight ?? 1);
          }
        }
        if (event.variant) {
          timelineRuntime.setVariant(event.variant.slot, event.variant.option);
        }
      }

      // Match the conformance harness exactly. Physics timelines derive each
      // scripting endpoint from its integer step instead of repeatedly adding
      // 1/fps, which can otherwise leave a boundary one ULP short.
      const outerEndpoint = (step + 1) / doc.fps;
      const duration = doc.physics_trace ? Math.max(0, outerEndpoint - elapsed) : timelineDt;
      if (duration > 0) timelineRuntime.update(duration);
      elapsed = outerEndpoint;
    }
    timelineRenderer.render(timelineRuntime.evaluate());
    const actual: Surface = {
      data: timelineRenderer.readSurface(),
      width: model.canvas.width,
      height: model.canvas.height,
    };

    const goldenPng = await decodePng(
      await fetchBytes(
        `conformance/goldens/${info.id}/${captureStep}.png`,
        LIMITS.textureFileBytes,
      ),
      model.canvas.width * model.canvas.height,
    );
    if (generation !== goldenCaptureGeneration) return;
    const golden: Surface = {
      data: goldenPng.data,
      width: goldenPng.width,
      height: goldenPng.height,
    };
    const comparison = compareSurfaces(golden, actual);
    goldenPreview = { golden, actual };
    goldenVerdict.textContent = comparison.pass
      ? `PASS vs golden — ${comparison.badPixels} px out of ±${CHANNEL_TOLERANCE}/255; ${comparison.catastrophicPixels} px exceed ±${CATASTROPHIC_CHANNEL_TOLERANCE}/255, largest region ${comparison.largestCatastrophicRegion}/${CATASTROPHIC_REGION_PIXEL_LIMIT} px (max diff ${comparison.maxDiff})`
      : `FAIL vs golden — ${comparison.badPixels} px out of ±${CHANNEL_TOLERANCE}/255; ${comparison.catastrophicPixels} px exceed ±${CATASTROPHIC_CHANNEL_TOLERANCE}/255, largest region ${comparison.largestCatastrophicRegion}/${CATASTROPHIC_REGION_PIXEL_LIMIT} px (max diff ${comparison.maxDiff})`;
    goldenVerdict.className = comparison.pass ? "pass" : "fail";
    renderGoldenPreview();
  } catch (error) {
    if (generation !== goldenCaptureGeneration) return;
    goldenVerdict.textContent = `ERROR — ${errorMessage(error)}`;
    goldenVerdict.className = "fail";
  } finally {
    timelineRenderer?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Directory drag & drop

document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  const item = e.dataTransfer?.items[0];
  const entry = item?.webkitGetAsEntry();
  if (!entry?.isDirectory) return;
  setStatus("Reading dropped model…", "loading");
  try {
    const files = await collectDroppedDirectory(entry as FileSystemDirectoryEntry);
    pickerEl.value = "";
    await loadModel(files);
  } catch (error) {
    setStatus(`Could not read dropped model: ${errorMessage(error)}`, "error");
  }
});

// ---------------------------------------------------------------------------
// Boot

async function boot(): Promise<void> {
  setStatus("Loading model index…", "loading");
  const response = await fetch("/__lyre/index");
  if (!response.ok) throw new Error(`model index request failed (${response.status})`);
  const indexBytes = await readBoundedResponse(
    response,
    "model index",
    RUNTIME_LIMITS.containerPathMetadataBytes * 4,
  );
  index = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes)) as DevIndex;
  pickerEl.innerHTML = "";
  for (const modelPath of index.models) {
    const option = document.createElement("option");
    option.value = modelPath;
    option.textContent = modelPath.split("/").pop() ?? modelPath;
    pickerEl.append(option);
  }
  for (const t of index.timelines) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.id;
    timelinePicker.append(opt);
  }
  pickerEl.addEventListener("change", () => {
    location.hash = `#model=${encodeURIComponent(pickerEl.value)}`;
    void loadModel(pickerEl.value);
  });
  const fromHash = decodeURIComponent((location.hash.match(/#model=(.*)$/) ?? [])[1] ?? "");
  const initial = index.models.includes(fromHash) ? fromHash : index.models[0];
  if (initial) {
    pickerEl.value = initial;
    await loadModel(initial);
  }
}

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(rafHandle);
  loadGeneration++;
  disposeCurrentModel();
});

void boot().catch((error: unknown) => {
  setStatus(`Could not start testbed: ${errorMessage(error)}`, "error");
  console.error(error);
});
