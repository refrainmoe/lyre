// In-browser side of the WebGL conformance harness. Bundled by e2e/run.ts and
// injected into headless Chromium; exposes window.lyreRunTimeline which loads
// the model, renders the timeline through @refrain-lyre/render-webgl, and returns the
// captured surfaces base64-encoded.

import {
  loadModel,
  type DeformedGeometry,
  type DrawItem,
  type EvalFrame,
  type ModelFiles,
  type PremultipliedImage,
} from "@refrain-lyre/core";
import { createSoftRenderer } from "@refrain-lyre/render-soft";
import { runTimelineSteps, type Timeline } from "../../validate/src/steps.js";
import { CONTEXT_ATTRIBUTES, createWebGLRenderer } from "../src/index.js";

interface TexturePayload {
  id: string;
  width: number;
  height: number;
  /** base64 of premultiplied RGBA8 bytes */
  data: string;
  atlasRect?: [number, number, number, number];
}

interface RunPayload {
  raw: ModelFiles;
  textures: TexturePayload[];
  timeline: Timeline;
}

interface RunReturn {
  width: number;
  height: number;
  /** step → base64 of the premultiplied RGBA8 surface */
  captures: Record<string, string>;
  trace: Record<string, number[][]> | null;
}

interface ProbeResult {
  cpu: number[];
  webgl: number[];
}

interface PrecisionProbesReturn {
  additiveMultiply: ProbeResult;
  maskUnion: ProbeResult;
  halfPixelAbove: ProbeResult;
  halfPixelBelow: ProbeResult;
  largeUv: ProbeResult;
  mutableTextureReuse: ProbeResult;
  atlasRectInitialSnapshot: ProbeResult;
  atlasRectReuseSnapshot: ProbeResult;
  hostilePixelTransfer: ProbeResult;
  hostileSamplerRender: ProbeResult;
  hostilePresent: ProbeResult;
  disposedStatePreservation: ProbeResult;
  guardChecks: {
    transformFeedback: boolean;
    activeQueries: boolean;
    timerQuery: boolean | null;
    disposed: boolean;
    contextLoss: boolean;
    sharedState: boolean;
  };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function poisonPixelUnpackState(gl: WebGL2RenderingContext): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("failed to create hostile pixel-unpack buffer");
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer);
  // Deliberately too small for any probe transfer if interpreted as a PBO.
  gl.bufferData(gl.PIXEL_UNPACK_BUFFER, 1, gl.STREAM_DRAW);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 7);
  gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 9);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 2);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 3);
  gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 4);
  return buffer;
}

function requireThrows(label: string, expected: RegExp, action: () => void): void {
  try {
    action();
  } catch (error) {
    if (expected.test(String(error))) return;
    throw new Error(`${label} threw the wrong error: ${String(error)}`);
  }
  throw new Error(`${label} did not throw`);
}

function readDefaultPixel(gl: WebGL2RenderingContext): number[] {
  const pixel = new Uint8Array(4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.readBuffer(gl.BACK);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  const error = gl.getError();
  if (error !== gl.NO_ERROR)
    throw new Error(`default-framebuffer read failed (0x${error.toString(16)})`);
  return Array.from(pixel);
}

type HostGlState = ReadonlyArray<readonly [string, unknown]>;

function captureHostGlState(gl: WebGL2RenderingContext): HostGlState {
  const state: Array<readonly [string, unknown]> = [];
  const parameter = (name: string, pname: number): void => {
    state.push([name, gl.getParameter(pname)]);
  };
  const vector = (name: string, pname: number): void => {
    const values = gl.getParameter(pname) as ArrayLike<unknown>;
    for (let index = 0; index < values.length; index++) {
      state.push([`${name}[${index}]`, values[index]]);
    }
  };

  parameter("program", gl.CURRENT_PROGRAM);
  parameter("vertexArray", gl.VERTEX_ARRAY_BINDING);
  parameter("arrayBuffer", gl.ARRAY_BUFFER_BINDING);
  parameter("pixelPackBuffer", gl.PIXEL_PACK_BUFFER_BINDING);
  parameter("pixelUnpackBuffer", gl.PIXEL_UNPACK_BUFFER_BINDING);
  parameter("drawFramebuffer", gl.DRAW_FRAMEBUFFER_BINDING);
  parameter("readFramebuffer", gl.READ_FRAMEBUFFER_BINDING);
  parameter("boundDrawBuffer0", gl.DRAW_BUFFER0);
  parameter("activeTexture", gl.ACTIVE_TEXTURE);

  const activeTexture = Number(gl.getParameter(gl.ACTIVE_TEXTURE));
  try {
    for (let unit = 0; unit < 2; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      parameter(`texture2D[${unit}]`, gl.TEXTURE_BINDING_2D);
      parameter(`sampler[${unit}]`, gl.SAMPLER_BINDING);
    }
  } finally {
    gl.activeTexture(activeTexture);
  }

  const drawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  try {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    parameter("defaultDrawBuffer0", gl.DRAW_BUFFER0);
  } finally {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer);
  }

  for (const [name, pname] of [
    ["unpackAlignment", gl.UNPACK_ALIGNMENT],
    ["unpackRowLength", gl.UNPACK_ROW_LENGTH],
    ["unpackImageHeight", gl.UNPACK_IMAGE_HEIGHT],
    ["unpackSkipPixels", gl.UNPACK_SKIP_PIXELS],
    ["unpackSkipRows", gl.UNPACK_SKIP_ROWS],
    ["unpackSkipImages", gl.UNPACK_SKIP_IMAGES],
    ["unpackPremultiply", gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL],
    ["unpackFlipY", gl.UNPACK_FLIP_Y_WEBGL],
    ["unpackColorSpace", gl.UNPACK_COLORSPACE_CONVERSION_WEBGL],
    ["packAlignment", gl.PACK_ALIGNMENT],
    ["packRowLength", gl.PACK_ROW_LENGTH],
    ["packSkipPixels", gl.PACK_SKIP_PIXELS],
    ["packSkipRows", gl.PACK_SKIP_ROWS],
    ["blendEquationRgb", gl.BLEND_EQUATION_RGB],
    ["blendEquationAlpha", gl.BLEND_EQUATION_ALPHA],
    ["blendSrcRgb", gl.BLEND_SRC_RGB],
    ["blendDstRgb", gl.BLEND_DST_RGB],
    ["blendSrcAlpha", gl.BLEND_SRC_ALPHA],
    ["blendDstAlpha", gl.BLEND_DST_ALPHA],
  ] as const) {
    parameter(name, pname);
  }
  for (const [name, pname] of [
    ["blend", gl.BLEND],
    ["cullFace", gl.CULL_FACE],
    ["depthTest", gl.DEPTH_TEST],
    ["dither", gl.DITHER],
    ["rasterizerDiscard", gl.RASTERIZER_DISCARD],
    ["sampleAlphaToCoverage", gl.SAMPLE_ALPHA_TO_COVERAGE],
    ["sampleCoverage", gl.SAMPLE_COVERAGE],
    ["scissorTest", gl.SCISSOR_TEST],
    ["stencilTest", gl.STENCIL_TEST],
  ] as const) {
    state.push([name, gl.isEnabled(pname)]);
  }
  vector("colorMask", gl.COLOR_WRITEMASK);
  vector("viewport", gl.VIEWPORT);
  vector("clearColor", gl.COLOR_CLEAR_VALUE);

  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(`capturing host GL state failed (0x${error.toString(16)})`);
  }
  return state;
}

function assertHostGlStateUnchanged(
  gl: WebGL2RenderingContext,
  expected: HostGlState,
  operation: string,
): void {
  const actual = captureHostGlState(gl);
  if (actual.length !== expected.length) throw new Error(`${operation} state probe changed shape`);
  for (let index = 0; index < expected.length; index++) {
    const [expectedName, expectedValue] = expected[index]!;
    const [actualName, actualValue] = actual[index]!;
    if (actualName !== expectedName || !Object.is(actualValue, expectedValue)) {
      throw new Error(
        `${operation} changed host GL state ${expectedName}: ${String(expectedValue)} -> ${String(actualValue)}`,
      );
    }
  }
}

function preservingHostGlState<T>(
  gl: WebGL2RenderingContext,
  operation: string,
  action: () => T,
): T {
  const before = captureHostGlState(gl);
  try {
    return action();
  } finally {
    assertHostGlStateUnchanged(gl, before, operation);
  }
}

interface HostTransformFeedback {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  feedback: WebGLTransformFeedback;
  finish(): void;
}

function beginHostTransformFeedback(gl: WebGL2RenderingContext): HostTransformFeedback {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("failed to create host transform-feedback shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`host transform-feedback shader failed: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };
  const vertex = compile(
    gl.VERTEX_SHADER,
    `#version 300 es
     out float captured;
     void main() {
       captured = 1.0;
       gl_Position = vec4(0.0);
     }`,
  );
  const fragment = compile(
    gl.FRAGMENT_SHADER,
    `#version 300 es
     precision highp float;
     out vec4 color;
     void main() { color = vec4(1.0); }`,
  );
  const program = gl.createProgram();
  if (!program) throw new Error("failed to create host transform-feedback program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.transformFeedbackVaryings(program, ["captured"], gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`host transform-feedback program failed: ${gl.getProgramInfoLog(program)}`);
  }
  const vao = gl.createVertexArray();
  const feedback = gl.createTransformFeedback();
  const buffer = gl.createBuffer();
  if (!vao || !feedback || !buffer)
    throw new Error("failed to create host transform-feedback state");
  gl.useProgram(program);
  gl.bindVertexArray(vao);
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
  gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
  gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 16, gl.STREAM_DRAW);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
  gl.enable(gl.RASTERIZER_DISCARD);
  gl.beginTransformFeedback(gl.POINTS);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(`failed to begin host transform feedback (0x${error.toString(16)})`);
  }
  return {
    program,
    vao,
    feedback,
    finish() {
      gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
      gl.bindVertexArray(null);
      gl.useProgram(null);
      gl.deleteBuffer(buffer);
      gl.deleteTransformFeedback(feedback);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
    },
  };
}

function assertHostTransformFeedbackUnchanged(
  gl: WebGL2RenderingContext,
  host: HostTransformFeedback,
): void {
  if (
    gl.getParameter(gl.CURRENT_PROGRAM) !== host.program ||
    gl.getParameter(gl.VERTEX_ARRAY_BINDING) !== host.vao ||
    gl.getParameter(gl.TRANSFORM_FEEDBACK_BINDING) !== host.feedback ||
    !gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE) ||
    gl.getParameter(gl.TRANSFORM_FEEDBACK_PAUSED)
  ) {
    throw new Error("renderer mutated active host transform-feedback state before rejecting it");
  }
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(
      `renderer leaked a GL error while rejecting transform feedback (0x${error.toString(16)})`,
    );
  }
}

declare global {
  interface Window {
    lyreRunTimeline: (payload: RunPayload) => RunReturn;
    lyreRunPrecisionProbes: () => PrecisionProbesReturn;
    lyreWebglInfo: () => { renderer: string; vendor: string };
  }
}

window.lyreWebglInfo = () => {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  if (!gl) throw new Error("WebGL2 unavailable");
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    renderer: dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER)),
    vendor: dbg
      ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
      : String(gl.getParameter(gl.VENDOR)),
  };
};

window.lyreRunPrecisionProbes = (): PrecisionProbesReturn => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  if (!gl) throw new Error("WebGL2 unavailable");

  const sprite = { id: "extended-blend-probe" } as DrawItem["sprite"];
  const geometry: DeformedGeometry = {
    sprite,
    texture: "emission",
    positions: Float64Array.of(0, 0, 1, 0, 0, 1, 1, 1),
    uvs: Float64Array.of(0, 0, 1, 0, 0, 1, 1, 1),
    indices: Uint32Array.of(0, 1, 3, 0, 3, 2),
  };
  const draw = (
    texture: string,
    blend: DrawItem["blend"],
    mask: DrawItem["mask"] = null,
  ): DrawItem => ({
    ...geometry,
    texture,
    opacity: 1,
    blend,
    effectiveZ: 0,
    mask,
  });
  const lowEmission = draw("low-emission", "additive");
  const additiveMultiplyFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [
      ...Array.from({ length: 9_998 }, () => lowEmission),
      draw("low-red-factor", "multiply"),
    ],
    maskGroups: [],
  };
  const maskSource: DeformedGeometry = { ...geometry, texture: "low-alpha-mask" };
  const maskUnionFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [draw("white", "normal", { mode: "alpha", group: 0 })],
    maskGroups: [
      {
        sources: Array.from({ length: 256 }, () => maskSource),
      },
    ],
  };
  const largeUvGeometry: DeformedGeometry = {
    ...geometry,
    texture: "edge",
    uvs: Float64Array.of(3e38, 3e38, 3e38, 3e38, 3e38, 3e38, 3e38, 3e38),
  };
  const largeUvFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [
      {
        ...largeUvGeometry,
        opacity: 1,
        blend: "normal",
        effectiveZ: 0,
        mask: null,
      },
    ],
    maskGroups: [],
  };
  const mutableTexture: PremultipliedImage = {
    width: 1,
    height: 1,
    data: Uint8Array.of(255, 0, 0, 255),
  };
  const textures = new Map<string, PremultipliedImage>([
    ["low-emission", { width: 1, height: 1, data: Uint8Array.of(1, 0, 0, 255) }],
    ["low-red-factor", { width: 1, height: 1, data: Uint8Array.of(5, 0, 0, 255) }],
    ["low-alpha-mask", { width: 1, height: 1, data: Uint8Array.of(1, 1, 1, 1) }],
    ["white", { width: 1, height: 1, data: Uint8Array.of(255, 255, 255, 255) }],
    ["edge", { width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255) }],
    ["mutable-reuse", mutableTexture],
    ["premultiplied-atomic", { width: 1, height: 1, data: Uint8Array.of(30, 60, 90, 255) }],
  ]);
  const atlasSnapshotImage: PremultipliedImage = {
    width: 2,
    height: 1,
    data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255),
  };

  const cpu = createSoftRenderer(1, 1);
  const hostDrawFramebuffer = gl.createFramebuffer();
  const hostReadFramebuffer = gl.createFramebuffer();
  if (!hostDrawFramebuffer || !hostReadFramebuffer) {
    throw new Error("failed to create host framebuffer state");
  }
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hostDrawFramebuffer);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, hostReadFramebuffer);
  // Construction allocates the main RGBA32F target via texImage2D(null).
  // Poison state before construction so that path cannot inherit host state.
  const constructorUnpackBuffer = poisonPixelUnpackState(gl);
  const webgl = preservingHostGlState(gl, "constructor", () => createWebGLRenderer(gl, 1, 1));
  gl.deleteBuffer(constructorUnpackBuffer);
  for (const [id, texture] of textures) {
    cpu.setTexture(id, texture);
    preservingHostGlState(gl, "setTexture", () => webgl.setTexture(id, texture));
  }
  const nonPremultiplied: PremultipliedImage = {
    width: 1,
    height: 1,
    data: Uint8Array.of(255, 0, 0, 0),
  };
  requireThrows("CPU non-premultiplied texture replacement", /premultiplied.*alpha/, () => {
    cpu.setTexture("premultiplied-atomic", nonPremultiplied);
  });
  requireThrows("WebGL non-premultiplied texture replacement", /premultiplied.*alpha/, () => {
    webgl.setTexture("premultiplied-atomic", nonPremultiplied);
  });
  const premultipliedAtomicFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [draw("premultiplied-atomic", "normal")],
    maskGroups: [],
  };
  cpu.render(premultipliedAtomicFrame);
  webgl.render(premultipliedAtomicFrame);
  const expectedPremultipliedAtomic = "30,60,90,255";
  if (Array.from(cpu.readSurface()).join() !== expectedPremultipliedAtomic) {
    throw new Error("CPU non-premultiplied replacement changed the admitted texture");
  }
  if (Array.from(webgl.readSurface()).join() !== expectedPremultipliedAtomic) {
    throw new Error("WebGL non-premultiplied replacement changed the admitted texture");
  }
  const initialAtlasCrop: [number, number, number, number] = [0, 0, 1, 1];
  cpu.setTexture("atlas-initial", atlasSnapshotImage, initialAtlasCrop);
  webgl.setTexture("atlas-initial", atlasSnapshotImage, initialAtlasCrop);
  initialAtlasCrop[0] = 1;

  // A host sharing the context may leave both a PBO and non-default WebGL2
  // unpack layout behind. A typed-array upload must explicitly neutralize all
  // of it rather than interpreting this tightly packed image through it.
  const hostileTexture: PremultipliedImage = {
    width: 1,
    height: 1,
    data: Uint8Array.of(11, 22, 33, 255),
  };
  const unpackBuffer = poisonPixelUnpackState(gl);
  cpu.setTexture("hostile-transfer", hostileTexture);
  preservingHostGlState(gl, "setTexture with hostile pixel-transfer state", () =>
    webgl.setTexture("hostile-transfer", hostileTexture),
  );
  gl.deleteBuffer(unpackBuffer);
  // Registration snapshots the texture. Reusing the same source object after a
  // host mutation must keep both backends on the admitted 1×1 resource rather
  // than applying the source's new 2×1 dimensions to the old GPU allocation.
  mutableTexture.width = 2;
  mutableTexture.data = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255);
  cpu.setTexture("mutable-reuse", mutableTexture);
  webgl.setTexture("mutable-reuse", mutableTexture);

  cpu.render(additiveMultiplyFrame);
  // A shared host context may have arbitrary state between Lyre frames.
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, 0, 0);
  gl.enable(gl.RASTERIZER_DISCARD);
  gl.colorMask(false, false, false, false);
  gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
  preservingHostGlState(gl, "render", () => webgl.render(additiveMultiplyFrame));
  const additiveMultiply = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(preservingHostGlState(gl, "readSurface", () => webgl.readSurface())),
  };

  cpu.render(maskUnionFrame);
  // The mask target is allocated on demand at the first masked render.
  const maskTargetUnpackBuffer = poisonPixelUnpackState(gl);
  preservingHostGlState(gl, "render with lazy mask allocation", () => webgl.render(maskUnionFrame));
  gl.deleteBuffer(maskTargetUnpackBuffer);
  const maskUnion = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(webgl.readSurface()),
  };

  cpu.render(largeUvFrame);
  webgl.render(largeUvFrame);
  const largeUv = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(webgl.readSurface()),
  };

  const mutableTextureFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [draw("mutable-reuse", "normal")],
    maskGroups: [],
  };
  cpu.render(mutableTextureFrame);
  webgl.render(mutableTextureFrame);
  const mutableTextureReuse = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(webgl.readSurface()),
  };

  const atlasInitialFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [draw("atlas-initial", "normal")],
    maskGroups: [],
  };
  cpu.render(atlasInitialFrame);
  webgl.render(atlasInitialFrame);
  const atlasRectInitialSnapshot = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(webgl.readSurface()),
  };

  cpu.setTexture("atlas-reuse", atlasSnapshotImage, [0, 0, 1, 1]);
  webgl.setTexture("atlas-reuse", atlasSnapshotImage, [0, 0, 1, 1]);
  const replacementAtlasCrop: [number, number, number, number] = [1, 0, 1, 1];
  cpu.setTexture("atlas-reuse", atlasSnapshotImage, replacementAtlasCrop);
  webgl.setTexture("atlas-reuse", atlasSnapshotImage, replacementAtlasCrop);
  replacementAtlasCrop[0] = 0;
  const atlasReuseFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [draw("atlas-reuse", "normal")],
    maskGroups: [],
  };
  cpu.render(atlasReuseFrame);
  webgl.render(atlasReuseFrame);
  const atlasRectReuseSnapshot = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(webgl.readSurface()),
  };

  // Coordinates on either side of 1.5 both quantize to the exact float32
  // pixel center. The upload conversion must retain the original side so the
  // GPU edge test agrees with the CPU's binary64 edge function.
  const halfPixelFrame = (left: number): EvalFrame => {
    if (Math.fround(left) !== 1.5 || left === 1.5) {
      throw new Error("half-pixel probe no longer collapses to float32 1.5");
    }
    const halfPixelGeometry: DeformedGeometry = {
      sprite,
      texture: "white",
      positions: Float64Array.of(left, 0, 4, 0, left, 1, 4, 1),
      uvs: Float64Array.of(0, 0, 1, 0, 0, 1, 1, 1),
      indices: Uint32Array.of(0, 1, 3, 0, 3, 2),
    };
    return {
      canvas: { width: 4, height: 1 },
      drawList: [
        {
          ...halfPixelGeometry,
          opacity: 1,
          blend: "normal",
          effectiveZ: 0,
          mask: null,
        },
      ],
      maskGroups: [],
    };
  };
  const alphaRow = (surface: Uint8Array): number[] => {
    const alpha: number[] = [];
    for (let offset = 3; offset < surface.length; offset += 4) alpha.push(surface[offset]!);
    return alpha;
  };
  const halfPixelCpu = createSoftRenderer(4, 1);
  const halfPixelWebgl = createWebGLRenderer(gl, 4, 1);
  const white = textures.get("white")!;
  halfPixelCpu.setTexture("white", white);
  halfPixelWebgl.setTexture("white", white);
  const runHalfPixelProbe = (left: number): ProbeResult => {
    const frame = halfPixelFrame(left);
    halfPixelCpu.render(frame);
    halfPixelWebgl.render(frame);
    return {
      cpu: alphaRow(halfPixelCpu.readSurface()),
      webgl: alphaRow(halfPixelWebgl.readSurface()),
    };
  };
  const halfPixelAbove = runHalfPixelProbe(1.5 + Number.EPSILON);
  const halfPixelBelow = runHalfPixelProbe(1.5 - Number.EPSILON);
  halfPixelWebgl.dispose();

  const hostilePixelTransferFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [draw("hostile-transfer", "normal")],
    maskGroups: [],
  };
  cpu.render(hostilePixelTransferFrame);
  webgl.render(hostilePixelTransferFrame);
  // Poison the corresponding pack state immediately before typed-array
  // readback. The destination has room for exactly one tightly packed pixel.
  const packBuffer = gl.createBuffer();
  if (!packBuffer) throw new Error("failed to create hostile pixel-pack buffer");
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBuffer);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, 1024, gl.STREAM_READ);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 8);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, 7);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, 2);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, 3);
  const hostilePixelTransfer = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(
      preservingHostGlState(gl, "readSurface with hostile pixel-transfer state", () =>
        webgl.readSurface(),
      ),
    ),
  };
  gl.deleteBuffer(packBuffer);

  const hostileSamplerFrame: EvalFrame = {
    canvas: { width: 1, height: 1 },
    drawList: [draw("white", "normal", { mode: "alpha", group: 0 })],
    maskGroups: [{ sources: [{ ...geometry, texture: "white" }] }],
  };
  const hostileSampler = gl.createSampler();
  if (!hostileSampler) throw new Error("failed to create hostile sampler");
  gl.samplerParameteri(hostileSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.bindSampler(0, hostileSampler);
  gl.bindSampler(1, hostileSampler);
  gl.sampleCoverage(0, false);
  gl.enable(gl.SAMPLE_COVERAGE);
  gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  cpu.render(hostileSamplerFrame);
  preservingHostGlState(gl, "render with hostile sampler state", () =>
    webgl.render(hostileSamplerFrame),
  );
  const hostileSamplerRender = {
    cpu: Array.from(cpu.readSurface()),
    webgl: Array.from(webgl.readSurface()),
  };

  // Poison every default-framebuffer control that can suppress the fullscreen
  // presentation draw. present() must establish its own draw buffer, sampler,
  // multisample, scissor, rasterizer, mask, and viewport state.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.NONE]);
  gl.bindSampler(0, hostileSampler);
  gl.sampleCoverage(0, false);
  gl.enable(gl.SAMPLE_COVERAGE);
  gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, 0, 0);
  gl.enable(gl.RASTERIZER_DISCARD);
  gl.colorMask(false, false, false, false);
  gl.viewport(0, 0, 0, 0);
  preservingHostGlState(gl, "present", () => webgl.present());
  const hostilePresent = {
    cpu: hostileSamplerRender.cpu,
    webgl: readDefaultPixel(gl),
  };
  gl.deleteSampler(hostileSampler);
  gl.deleteFramebuffer(hostDrawFramebuffer);
  gl.deleteFramebuffer(hostReadFramebuffer);

  const hostFeedback = beginHostTransformFeedback(gl);
  let unexpectedRenderer: ReturnType<typeof createWebGLRenderer> | null = null;
  try {
    requireThrows("constructor during active transform feedback", /transform feedback/, () => {
      unexpectedRenderer = createWebGLRenderer(gl, 1, 1);
    });
    assertHostTransformFeedbackUnchanged(gl, hostFeedback);
    requireThrows("render during active transform feedback", /transform feedback/, () => {
      webgl.render(hostileSamplerFrame);
    });
    assertHostTransformFeedbackUnchanged(gl, hostFeedback);
    requireThrows("present during active transform feedback", /transform feedback/, () => {
      webgl.present();
    });
    assertHostTransformFeedbackUnchanged(gl, hostFeedback);
  } finally {
    hostFeedback.finish();
    unexpectedRenderer?.dispose();
  }

  const timerQueryExtension = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const hostQueryTargets: Array<readonly [number, string]> = [
    [gl.ANY_SAMPLES_PASSED, "ANY_SAMPLES_PASSED"],
    [gl.ANY_SAMPLES_PASSED_CONSERVATIVE, "ANY_SAMPLES_PASSED_CONSERVATIVE"],
    [gl.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN, "TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN"],
  ];
  if (timerQueryExtension) {
    hostQueryTargets.push([timerQueryExtension.TIME_ELAPSED_EXT, "TIME_ELAPSED_EXT"]);
  }
  for (const [target, label] of hostQueryTargets) {
    const query = gl.createQuery();
    if (!query) throw new Error(`failed to create host ${label} query`);
    gl.beginQuery(target, query);
    const beginError = gl.getError();
    if (beginError !== gl.NO_ERROR) {
      gl.deleteQuery(query);
      throw new Error(`failed to begin host ${label} query (0x${beginError.toString(16)})`);
    }
    try {
      requireThrows(`render during active ${label} query`, /host query/, () => {
        webgl.render(hostileSamplerFrame);
      });
      if (gl.getQuery(target, gl.CURRENT_QUERY) !== query) {
        throw new Error(`renderer changed the active host ${label} query`);
      }
      requireThrows(`present during active ${label} query`, /host query/, () => {
        webgl.present();
      });
      if (gl.getQuery(target, gl.CURRENT_QUERY) !== query) {
        throw new Error(`renderer changed the active host ${label} query`);
      }
      const error = gl.getError();
      if (error !== gl.NO_ERROR) {
        throw new Error(
          `renderer leaked a GL error while rejecting ${label} (0x${error.toString(16)})`,
        );
      }
    } finally {
      gl.endQuery(target);
      gl.deleteQuery(query);
    }
  }

  webgl.dispose();
  webgl.dispose(); // disposal is intentionally idempotent
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.drawBuffers([gl.BACK]);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.RASTERIZER_DISCARD);
  gl.disable(gl.SAMPLE_COVERAGE);
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.colorMask(true, true, true, true);
  gl.viewport(0, 0, 1, 1);
  gl.clearColor(64 / 255, 128 / 255, 192 / 255, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  const disposedBefore = readDefaultPixel(gl);
  requireThrows("setTexture after dispose", /disposed/, () => {
    webgl.setTexture("after-dispose", hostileTexture);
  });
  requireThrows("render after dispose", /disposed/, () => {
    webgl.render(hostilePixelTransferFrame);
  });
  requireThrows("readSurface after dispose", /disposed/, () => {
    webgl.readSurface();
  });
  requireThrows("present after dispose", /disposed/, () => {
    webgl.present();
  });
  requireThrows("surfaceTexture after dispose", /disposed/, () => {
    void webgl.surfaceTexture;
  });
  const disposedStatePreservation = {
    cpu: disposedBefore,
    webgl: readDefaultPixel(gl),
  };

  // Context loss is terminal for a renderer: every public operation must fail
  // explicitly instead of returning a zero surface or mutating stale GL state.
  const lostCanvas = document.createElement("canvas");
  lostCanvas.width = 1;
  lostCanvas.height = 1;
  lostCanvas.addEventListener("webglcontextlost", (event) => event.preventDefault());
  const lostGl = lostCanvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  if (!lostGl) throw new Error("second WebGL2 context unavailable");
  const lostRenderer = createWebGLRenderer(lostGl, 1, 1);
  lostRenderer.setTexture("white", textures.get("white")!);
  const loseContext = lostGl.getExtension("WEBGL_lose_context");
  if (!loseContext) throw new Error("WEBGL_lose_context unavailable");
  loseContext.loseContext();
  if (!lostGl.isContextLost()) throw new Error("WEBGL_lose_context was not immediate");
  requireThrows("constructor on a lost context", /context.*lost/i, () => {
    createWebGLRenderer(lostGl, 1, 1);
  });
  requireThrows("setTexture after context loss", /context.*lost/i, () => {
    lostRenderer.setTexture("later", hostileTexture);
  });
  requireThrows("render after context loss", /context.*lost/i, () => {
    lostRenderer.render(hostileSamplerFrame);
  });
  requireThrows("readSurface after context loss", /context.*lost/i, () => {
    lostRenderer.readSurface();
  });
  requireThrows("present after context loss", /context.*lost/i, () => {
    lostRenderer.present();
  });
  requireThrows("surfaceTexture after context loss", /context.*lost/i, () => {
    void lostRenderer.surfaceTexture;
  });
  lostRenderer.dispose();
  return {
    additiveMultiply,
    maskUnion,
    halfPixelAbove,
    halfPixelBelow,
    largeUv,
    mutableTextureReuse,
    atlasRectInitialSnapshot,
    atlasRectReuseSnapshot,
    hostilePixelTransfer,
    hostileSamplerRender,
    hostilePresent,
    disposedStatePreservation,
    guardChecks: {
      transformFeedback: true,
      activeQueries: true,
      timerQuery: timerQueryExtension ? true : null,
      disposed: true,
      contextLoss: true,
      sharedState: true,
    },
  };
};

window.lyreRunTimeline = (payload: RunPayload): RunReturn => {
  const model = loadModel(payload.raw);
  const canvas = document.createElement("canvas");
  canvas.width = model.canvas.width;
  canvas.height = model.canvas.height;
  const gl = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  if (!gl) throw new Error("WebGL2 unavailable");

  const renderer = createWebGLRenderer(gl, model.canvas.width, model.canvas.height);
  for (const t of payload.textures) {
    renderer.setTexture(
      t.id,
      { width: t.width, height: t.height, data: fromBase64(t.data) },
      t.atlasRect,
    );
  }

  const result = runTimelineSteps(model, renderer, payload.timeline);
  const captures: Record<string, string> = {};
  for (const [step, surface] of result.captures) captures[String(step)] = toBase64(surface);
  renderer.dispose();
  return { width: result.width, height: result.height, captures, trace: result.trace };
};
