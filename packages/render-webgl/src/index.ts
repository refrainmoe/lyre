// @refrain-lyre/render-webgl — WebGL2 renderer for the §8.3 model surface.
//
// Correctness constraints (§8.3, §12):
// - Textures arrive as PremultipliedImage (CPU-premultiplied via @refrain-lyre/core);
//   UNPACK_PREMULTIPLY_ALPHA_WEBGL stays off — GL premultiply rounding is
//   unspecified.
// - No sRGB formats anywhere and no MSAA. The model surface is an RGBA32F
//   framebuffer so additive RGB can exceed 1 without clamping or RGBA8
//   quantization (or float16 precision loss) between layers. Mask coverage is
//   RGBA32F for the same reason. readSurface() performs the sole RGBA8
//   quantization after float32 readback.
// - Blend equations map exactly to blendFuncSeparate: normal (ONE,
//   ONE_MINUS_SRC_ALPHA on both channels), additive (ONE, ONE on RGB; dst
//   alpha kept), multiply (shader emits src.rgb·m + (1 − src.a·m), blended
//   with (ZERO, SRC_COLOR); dst alpha kept).
// - §8.4 masks: coverage union rendered into an offscreen alpha texture with
//   normal alpha blending (a + d(1−a) ≡ 1 − ∏(1 − aᵢ)), from raw texture
//   alpha over deformed geometry; sampled at the fragment's surface position.

import {
  assertRasterWorkWithinLimit,
  LIMITS,
  RUNTIME_LIMITS,
  type DeformedGeometry,
  type EvalFrame,
  type MaskGroup,
  type PremultipliedImage,
  type ReadonlyFloat64Array,
  type ReadonlyUint32Array,
  type SurfaceRenderer,
} from "@refrain-lyre/core";

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;   // canvas pixels, +y down
// Per-triangle affine canvas→uv map: u = dot(a_cu, vec3(x, y, 1)). Flat and
// identical on all three vertices — the fragment shader reconstructs uv from
// gl_FragCoord, sidestepping the rasterizer's subpixel vertex snap (SwiftShader
// snaps to 1/16 px, which shifts vertex-interpolated uvs past ±2/255 on steep
// texture gradients).
layout(location = 1) in vec3 a_cu;
layout(location = 2) in vec3 a_cv;
uniform vec2 u_canvas;
flat out vec3 v_cu;
flat out vec3 v_cv;
void main() {
  v_cu = a_cu;
  v_cv = a_cv;
  // Canvas top-left → NDC (-1, +1). The y-flip keeps canvas-space top/left
  // edges top/left in window space, so the GPU's top-left fill rule agrees
  // with the CPU reference on pixel centers that land exactly on edges;
  // readSurface() flips rows back.
  gl_Position = vec4(a_pos.x / u_canvas.x * 2.0 - 1.0, 1.0 - a_pos.y / u_canvas.y * 2.0, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;
flat in vec3 v_cu;
flat in vec3 v_cv;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform vec2 u_canvas;
uniform vec4 u_crop;      // crop rect [x, y, w, h] in texels
uniform float u_opacity;
// u_mode: 0 normal, 1 additive, 2 multiply, 3 mask-coverage
uniform int u_mode;
// u_maskMode: 0 none, 1 alpha, 2 inverted
uniform int u_maskMode;
out vec4 outColor;
void main() {
  // Exact pixel-center uv from the per-triangle affine map (canvas +y down).
  vec3 pix = vec3(gl_FragCoord.x, u_canvas.y - gl_FragCoord.y, 1.0);
  vec2 uv = clamp(vec2(dot(v_cu, pix), dot(v_cv, pix)), vec2(0.0), vec2(1.0));
  // Manual bilinear over premultiplied texels, texel indices clamped to the
  // crop interior (§3.2) — mirrors the CPU reference exactly; hardware LINEAR
  // filtering has unspecified subtexel precision and drifts past ±2/255 on
  // steep gradients.
  vec2 t = u_crop.xy + uv * u_crop.zw - 0.5;
  vec2 f0 = floor(t);
  vec2 fr = t - f0;
  ivec2 lo = ivec2(u_crop.xy + 0.5);
  ivec2 hi = lo + ivec2(u_crop.zw + 0.5) - 1;
  ivec2 i00 = clamp(ivec2(f0), lo, hi);
  ivec2 i11 = clamp(ivec2(f0) + 1, lo, hi);
  vec4 s00 = texelFetch(u_tex, ivec2(i00.x, i00.y), 0);
  vec4 s10 = texelFetch(u_tex, ivec2(i11.x, i00.y), 0);
  vec4 s01 = texelFetch(u_tex, ivec2(i00.x, i11.y), 0);
  vec4 s11 = texelFetch(u_tex, ivec2(i11.x, i11.y), 0);
  vec4 s = mix(mix(s00, s10, fr.x), mix(s01, s11, fr.x), fr.y);
  if (u_mode == 3) {
    outColor = vec4(0.0, 0.0, 0.0, s.a); // raw texture alpha only (§8.4)
    return;
  }
  vec4 src = s * u_opacity;
  if (u_maskMode != 0) {
    float m = texelFetch(u_mask, ivec2(gl_FragCoord.xy), 0).a;
    if (u_maskMode == 2) m = 1.0 - m;
    src *= m;
  }
  if (u_mode == 2) {
    // §8.3 multiply: out.rgb = dst.rgb · (src.rgb + (1 − src.a)); the factor
    // is emitted here and applied via blendFunc (ZERO, SRC_COLOR).
    outColor = vec4(src.rgb + vec3(1.0 - src.a), 1.0);
    return;
  }
  outColor = src;
}
`;

interface SharedTexture {
  readonly image: PremultipliedImage;
  texture: WebGLTexture;
  width: number;
  height: number;
  refs: number;
}

interface StoredTexture {
  resource: SharedTexture;
  crop: readonly [number, number, number, number];
}

interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
}

interface Uniforms {
  canvas: WebGLUniformLocation;
  tex: WebGLUniformLocation;
  mask: WebGLUniformLocation;
  crop: WebGLUniformLocation;
  opacity: WebGLUniformLocation;
  mode: WebGLUniformLocation;
  maskMode: WebGLUniformLocation;
}

interface TextureUnitState {
  readonly texture2D: WebGLTexture | null;
  readonly sampler: WebGLSampler | null;
}

interface GlStateSnapshot {
  readonly program: WebGLProgram | null;
  readonly vertexArray: WebGLVertexArrayObject | null;
  readonly arrayBuffer: WebGLBuffer | null;
  readonly pixelPackBuffer: WebGLBuffer | null;
  readonly pixelUnpackBuffer: WebGLBuffer | null;
  readonly drawFramebuffer: WebGLFramebuffer | null;
  readonly readFramebuffer: WebGLFramebuffer | null;
  readonly defaultDrawBuffer: number;
  readonly activeTexture: number;
  readonly textureUnits: readonly [TextureUnitState, TextureUnitState];
  readonly pixelStore: ReadonlyArray<readonly [number, number]>;
  readonly capabilities: ReadonlyArray<readonly [number, boolean]>;
  readonly colorMask: readonly [boolean, boolean, boolean, boolean];
  readonly blendEquationRgb: number;
  readonly blendEquationAlpha: number;
  readonly blendSrcRgb: number;
  readonly blendDstRgb: number;
  readonly blendSrcAlpha: number;
  readonly blendDstAlpha: number;
  readonly viewport: readonly [number, number, number, number];
  readonly clearColor: readonly [number, number, number, number];
}

export class WebGLRenderer implements SurfaceRenderer {
  readonly width: number;
  readonly height: number;
  private readonly gl: WebGL2RenderingContext;
  private readonly maxTextureSize: number;
  /** Smallest window-coordinate increment represented by this rasterizer. */
  private readonly subpixelQuantum: number;
  private readonly program: WebGLProgram;
  private readonly surface: Target;
  private maskCoverageTarget: Target | null = null;
  private readonly textures = new Map<string, StoredTexture>();
  private readonly textureResources = new Map<PremultipliedImage, SharedTexture>();
  private texturePixels = 0;
  private readonly vao: WebGLVertexArrayObject;
  private readonly posBuffer: WebGLBuffer;
  private readonly cuBuffer: WebGLBuffer;
  private readonly cvBuffer: WebGLBuffer;
  private readonly uniforms: Uniforms;
  private disposed = false;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    requireSurfaceDimensions(width, height);
    assertContextAvailable(gl, "construct a renderer");
    assertTransformFeedbackSafe(gl, "construct a renderer");
    const maxTextureSize = requireDeviceSurfaceDimensions(gl, width, height);
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.maxTextureSize = maxTextureSize;
    const subpixelBits = Number(gl.getParameter(gl.SUBPIXEL_BITS));
    const subpixelQuantum = 2 ** -subpixelBits;
    // WebGL requires at least four subpixel bits. Below that, moving an edge
    // off one sample center could cross the next one, so matching CPU coverage
    // would not be possible without changing the geometry materially.
    if (
      !Number.isInteger(subpixelBits) ||
      subpixelBits < 4 ||
      !Number.isFinite(subpixelQuantum) ||
      subpixelQuantum <= 0
    ) {
      throw new Error(`WebGL: invalid SUBPIXEL_BITS value ${String(subpixelBits)}`);
    }
    this.subpixelQuantum = subpixelQuantum;

    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error(
        "WebGL: EXT_color_buffer_float is required for RGBA32F model and mask targets",
      );
    }
    if (!gl.getExtension("EXT_float_blend")) {
      throw new Error(
        "WebGL: EXT_float_blend is required for blending into RGBA32F model and mask targets",
      );
    }

    let program: WebGLProgram | null = null;
    let surface: Target | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let posBuffer: WebGLBuffer | null = null;
    let cuBuffer: WebGLBuffer | null = null;
    let cvBuffer: WebGLBuffer | null = null;
    let uniforms: Uniforms | null = null;
    const hostState = captureGlState(gl);
    try {
      try {
        discardGlErrors(gl);
        program = buildProgram(gl, VERT, FRAG);
        gl.useProgram(program);
        const u = (name: string): WebGLUniformLocation => {
          const loc = gl.getUniformLocation(program!, name);
          if (loc === null) throw new Error(`uniform ${name} not found`);
          return loc;
        };
        uniforms = {
          canvas: u("u_canvas"),
          tex: u("u_tex"),
          mask: u("u_mask"),
          crop: u("u_crop"),
          opacity: u("u_opacity"),
          mode: u("u_mode"),
          maskMode: u("u_maskMode"),
        };
        gl.uniform1i(uniforms.tex, 0);
        gl.uniform1i(uniforms.mask, 1);
        gl.uniform2f(uniforms.canvas, width, height);
        assertNoGlError(gl, "initializing renderer uniforms");

        surface = createTarget(gl, width, height);

        vao = must(gl.createVertexArray(), "vao");
        posBuffer = must(gl.createBuffer(), "buffer");
        cuBuffer = must(gl.createBuffer(), "buffer");
        cvBuffer = must(gl.createBuffer(), "buffer");
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, cuBuffer);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, cvBuffer);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);

        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE); // deformation may flip triangles; never cull
        gl.disable(gl.DITHER);
        gl.enable(gl.BLEND);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        assertNoGlError(gl, "initializing renderer vertex and fixed-function state");
      } catch (error) {
        gl.bindVertexArray(null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        if (cvBuffer) gl.deleteBuffer(cvBuffer);
        if (cuBuffer) gl.deleteBuffer(cuBuffer);
        if (posBuffer) gl.deleteBuffer(posBuffer);
        if (vao) gl.deleteVertexArray(vao);
        if (surface) deleteTarget(gl, surface);
        if (program) gl.deleteProgram(program);
        throw error;
      }
    } finally {
      restoreGlState(gl, hostState);
    }

    this.program = program;
    this.uniforms = uniforms;
    this.surface = surface;
    this.vao = vao;
    this.posBuffer = posBuffer;
    this.cuBuffer = cuBuffer;
    this.cvBuffer = cvBuffer;
  }

  setTexture(
    id: string,
    image: PremultipliedImage,
    atlasRect?: readonly [number, number, number, number],
  ): void {
    this.assertAlive();
    assertContextAvailable(this.gl, "set a texture");
    const existing = this.textures.get(id);
    let resource = this.textureResources.get(image);
    if (resource) {
      // Texture registration snapshots the image into GPU storage. If a caller
      // later mutates the source object, every alias must continue to use the
      // dimensions of that stored snapshot rather than inventing a crop over
      // pixels that were never uploaded.
      requireAtlasRect(resource.width, resource.height, atlasRect);
    } else {
      requireTexture(image, atlasRect);
      if (image.width > this.maxTextureSize || image.height > this.maxTextureSize) {
        throw new RangeError(
          `texture ${image.width}x${image.height} exceeds this WebGL device's MAX_TEXTURE_SIZE ${this.maxTextureSize}`,
        );
      }
    }
    const gl = this.gl;
    if (existing?.resource.image === image) {
      this.textures.set(id, {
        resource: existing.resource,
        crop: snapshotAtlasRect(existing.resource.width, existing.resource.height, atlasRect),
      });
      return;
    }

    const releasedPixels =
      existing && existing.resource.refs === 1
        ? existing.resource.width * existing.resource.height
        : 0;
    const addedPixels = resource ? 0 : image.width * image.height;
    if (this.texturePixels - releasedPixels + addedPixels > LIMITS.totalTexturePixels) {
      throw new RangeError(`textures exceed ${LIMITS.totalTexturePixels} aggregate decoded pixels`);
    }
    const hostState = captureGlState(gl);
    try {
      let created = false;
      if (!resource) {
        const texture = must(gl.createTexture(), "texture");
        try {
          discardGlErrors(gl);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          // The context is host-owned and may retain WebGL2 row/skip state or a
          // pixel-unpack buffer. This overload supplies a typed array, so always
          // establish the complete neutral unpack state before uploading it.
          resetPixelUnpackState(gl);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA8, // never an sRGB format (R4)
            image.width,
            image.height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            image.data,
          );
          assertNoGlError(gl, `allocating ${image.width}x${image.height} RGBA8 texture`);
        } catch (error) {
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.deleteTexture(texture);
          throw error;
        }
        resource = { image, texture, width: image.width, height: image.height, refs: 0 };
        created = true;
      }
      if (existing) this.releaseTexture(existing.resource);
      if (created) {
        this.textureResources.set(image, resource);
        this.texturePixels += image.width * image.height;
      }
      resource.refs++;
      this.textures.set(id, {
        resource,
        crop: snapshotAtlasRect(resource.width, resource.height, atlasRect),
      });
    } finally {
      restoreGlState(gl, hostState);
    }
  }

  render(frame: EvalFrame): void {
    this.assertAlive();
    assertContextAvailable(this.gl, "render");
    assertTransformFeedbackSafe(this.gl, "render");
    assertDrawQueriesSafe(this.gl, "render");
    assertRasterWorkWithinLimit(frame, this.width, this.height);
    preflightWebGLGeometry(frame, this.subpixelQuantum);
    const needsMaskTarget = this.preflightTextures(frame);
    const gl = this.gl;
    const hostState = captureGlState(gl);
    try {
      // Allocate the lazy mask target before clearing the existing surface. A
      // device OOM or incomplete framebuffer must leave the last good rendered
      // surface readable instead of replacing it with a partial/empty frame.
      if (needsMaskTarget) this.getMaskCoverageTarget();
      discardGlErrors(gl);
      // The host may share this context with other drawing code between frames.
      // Re-establish every fixed-function state that affects the model surface.
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DITHER);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.disable(gl.SAMPLE_COVERAGE);
      gl.colorMask(true, true, true, true);
      gl.bindSampler(0, null);
      gl.bindSampler(1, null);
      gl.enable(gl.BLEND);
      gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.surface.framebuffer);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      assertNoGlError(gl, "preparing the model surface");

      // A single full-canvas mask target is reused. Rebuild it only when the
      // draw list switches groups, which bounds mask memory independently of
      // the number of groups in a model.
      let activeMaskGroup: number | null = null;
      for (const item of frame.drawList) {
        if (item.opacity === 0) continue; // src ≡ 0 is a no-op in every mode
        const texture = this.textures.get(item.texture);
        if (!texture) throw new Error(`texture "${item.texture}" not loaded`);

        if (item.mask && item.mask.group !== activeMaskGroup) {
          const target = this.getMaskCoverageTarget();
          this.renderCoverage(frame.maskGroups[item.mask.group]!, target);
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.surface.framebuffer);
          gl.viewport(0, 0, this.width, this.height);
          assertNoGlError(gl, "restoring the model surface after mask coverage");
          activeMaskGroup = item.mask.group;
        }

        if (item.blend === "normal") {
          gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform1i(this.uniforms.mode, 0);
        } else if (item.blend === "additive") {
          gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
          gl.uniform1i(this.uniforms.mode, 1);
        } else {
          gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
          gl.uniform1i(this.uniforms.mode, 2);
        }

        if (item.mask) {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this.maskCoverageTarget!.texture);
          gl.uniform1i(this.uniforms.maskMode, item.mask.mode === "alpha" ? 1 : 2);
        } else {
          gl.uniform1i(this.uniforms.maskMode, 0);
        }

        gl.uniform1f(this.uniforms.opacity, item.opacity);
        this.drawGeometry(item.positions, item.uvs, item.indices, texture);
      }
      assertNoGlError(gl, "rendering the model surface");
    } finally {
      restoreGlState(gl, hostState);
    }
  }

  readSurface(): Uint8Array {
    this.assertAlive();
    assertContextAvailable(this.gl, "read the model surface");
    const gl = this.gl;
    const raw = new Float32Array(this.width * this.height * 4);
    const hostState = captureGlState(gl);
    try {
      discardGlErrors(gl);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.surface.framebuffer);
      // readPixels writes into a typed array. Host-owned pack row/skip state or
      // a bound pixel-pack buffer would otherwise redirect or invalidate it.
      resetPixelPackState(gl);
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.FLOAT, raw);
      assertNoGlError(gl, "reading the RGBA32F model surface");
    } finally {
      restoreGlState(gl, hostState);
    }

    // readPixels returns rows bottom-up; the model surface is +y down. This is
    // also the one normative quantization point: round-half-up, then clamp.
    const out = new Uint8Array(raw.length);
    const rowValues = this.width * 4;
    for (let y = 0; y < this.height; y++) {
      const srcRow = y * rowValues;
      const dstRow = (this.height - 1 - y) * rowValues;
      for (let i = 0; i < rowValues; i++) {
        const q = Math.floor(raw[srcRow + i]! * 255 + 0.5);
        out[dstRow + i] = q < 0 ? 0 : q > 255 ? 255 : q;
      }
    }
    return out;
  }

  /** The model-surface texture (row 0 = canvas BOTTOM row), for viewer blits. */
  get surfaceTexture(): WebGLTexture {
    this.assertAlive();
    assertContextAvailable(this.gl, "access the model-surface texture");
    return this.surface.texture;
  }

  /**
   * Draw the model surface to the default framebuffer (the hosting canvas).
   * The surface is premultiplied; the canvas context should be created with
   * premultipliedAlpha: true (CONTEXT_ATTRIBUTES) so the compositor reads it
   * correctly.
   */
  present(): void {
    this.assertAlive();
    const gl = this.gl;
    assertContextAvailable(gl, "present");
    assertTransformFeedbackSafe(gl, "present");
    assertDrawQueriesSafe(gl, "present");
    const hostState = captureGlState(gl);
    try {
      if (!this.blit) this.blit = buildBlit(gl);
      discardGlErrors(gl);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.DITHER);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.disable(gl.SAMPLE_COVERAGE);
      gl.colorMask(true, true, true, true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.drawBuffers([gl.BACK]);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(this.blit.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindSampler(0, null);
      gl.bindTexture(gl.TEXTURE_2D, this.surface.texture);
      gl.bindVertexArray(this.blit.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      assertNoGlError(gl, "presenting the model surface");
    } finally {
      restoreGlState(gl, hostState);
    }
  }

  private blit: { program: WebGLProgram; vao: WebGLVertexArrayObject } | null = null;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.textures.clear();
    for (const resource of this.textureResources.values()) gl.deleteTexture(resource.texture);
    this.textureResources.clear();
    this.texturePixels = 0;
    if (this.maskCoverageTarget) {
      deleteTarget(gl, this.maskCoverageTarget);
      this.maskCoverageTarget = null;
    }
    deleteTarget(gl, this.surface);
    if (this.blit) {
      gl.deleteVertexArray(this.blit.vao);
      gl.deleteProgram(this.blit.program);
      this.blit = null;
    }
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.posBuffer);
    gl.deleteBuffer(this.cuBuffer);
    gl.deleteBuffer(this.cvBuffer);
  }

  // -----------------------------------------------------------------------

  private getMaskCoverageTarget(): Target {
    this.maskCoverageTarget ??= createTarget(this.gl, this.width, this.height);
    return this.maskCoverageTarget;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("WebGL renderer has been disposed");
  }

  private releaseTexture(resource: SharedTexture): void {
    resource.refs--;
    if (resource.refs > 0) return;
    this.gl.deleteTexture(resource.texture);
    this.textureResources.delete(resource.image);
    this.texturePixels -= resource.width * resource.height;
  }

  private preflightTextures(frame: EvalFrame): boolean {
    let activeMaskGroup = -1;
    let needsMaskTarget = false;
    for (const item of frame.drawList) {
      if (item.opacity === 0) continue;
      if (!this.textures.has(item.texture)) {
        throw new Error(`texture "${item.texture}" not loaded`);
      }
      if (item.mask && item.mask.group !== activeMaskGroup) {
        needsMaskTarget = true;
        for (const source of frame.maskGroups[item.mask.group]!.sources) {
          if (!this.textures.has(source.texture)) {
            throw new Error(`mask source texture "${source.texture}" not loaded`);
          }
        }
        activeMaskGroup = item.mask.group;
      }
    }
    return needsMaskTarget;
  }

  private renderCoverage(group: MaskGroup, target: Target): void {
    const gl = this.gl;
    // The target texture may still be bound to unit 1 from a previous masked
    // draw; rendering into it then would be a sampling-feedback loop (ANGLE
    // rejects the draw and coverage silently stays empty).
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    assertNoGlError(gl, "preparing mask coverage");
    // Coverage union via normal alpha blending on the alpha channel (§8.4).
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.uniforms.mode, 3);
    gl.uniform1i(this.uniforms.maskMode, 0);
    gl.uniform1f(this.uniforms.opacity, 1);
    for (const source of group.sources) {
      const texture = this.textures.get(source.texture);
      if (!texture) throw new Error(`mask source texture "${source.texture}" not loaded`);
      this.drawGeometry(source.positions, source.uvs, source.indices, texture);
    }
  }

  private drawGeometry(
    positions: ReadonlyFloat64Array,
    uvs: ReadonlyFloat64Array,
    indices: ReadonlyUint32Array,
    texture: StoredTexture,
  ): void {
    const gl = this.gl;
    const { pos, cu, cv, vertexCount } = deindex(positions, uvs, indices, this.subpixelQuantum);
    if (vertexCount === 0) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture.resource.texture);
    gl.uniform4f(this.uniforms.crop, ...texture.crop);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cuBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, cu, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, cv, gl.DYNAMIC_DRAW);
    assertNoGlError(gl, `uploading ${vertexCount} de-indexed vertices`);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    assertNoGlError(gl, `drawing ${vertexCount / 3} triangles`);
  }
}

interface Deindexed {
  pos: Float32Array;
  cu: Float32Array;
  cv: Float32Array;
  vertexCount: number;
}

const FLOAT32_MAX = 3.4028234663852886e38;
const float32StepValue = new Float32Array(1);
const float32StepBits = new Uint32Array(float32StepValue.buffer);

/** Return the adjacent finite float32 in the requested numeric direction. */
function adjacentFloat32(value: number, towardPositive: boolean): number {
  float32StepValue[0] = value;
  const bits = float32StepBits[0]!;
  // Position sample centers are non-zero, but keep this helper total for zero
  // so future callers cannot accidentally step to the opposite signed zero.
  if (value === 0) {
    float32StepBits[0] = towardPositive ? 1 : 0x80000001;
  } else {
    float32StepBits[0] = value > 0 === towardPositive ? bits + 1 : bits - 1;
  }
  return float32StepValue[0]!;
}

/**
 * Convert a canvas coordinate to the uploaded float32 without moving it onto
 * an exact pixel-center boundary from either side.
 *
 * Half-integer canvas coordinates are exactly representable throughout the
 * bounded Lyre canvas. A nearby binary64 position can nevertheless round onto
 * that half-integer, changing an edge-function result from strictly positive
 * or negative to an equality governed by the top-left rule. Preserve that one
 * bit of coverage information by selecting the next raster-grid coordinate in
 * the original direction. All other positions retain ordinary nearest
 * rounding.
 */
function float32Position(value: number, subpixelQuantum: number): number {
  const rounded = Math.fround(value);
  if (rounded === value) return rounded;
  const doubled = rounded * 2;
  const isPixelCenter = Number.isSafeInteger(doubled) && Math.abs(doubled % 2) === 1;
  if (!isPixelCenter) return rounded;
  // Moving by one unit of the implementation's reported window-coordinate
  // precision is the smallest displacement guaranteed to survive its
  // subpixel rasterization. Keep an adjacent-float fallback for unusually
  // high precision where the quantum is below the float32 ULP at this value.
  const towardPositive = value > rounded;
  const shifted = Math.fround(rounded + (towardPositive ? subpixelQuantum : -subpixelQuantum));
  return shifted === rounded ? adjacentFloat32(rounded, towardPositive) : shifted;
}

function preflightWebGLGeometry(frame: EvalFrame, subpixelQuantum: number): void {
  let uploadBytes = 0;
  const inspect = (geometry: DeformedGeometry): void => {
    const bytes = (geometry.indices.length / 3) * 3 * 8 * Float32Array.BYTES_PER_ELEMENT;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > RUNTIME_LIMITS.webglVertexUploadBytesPerFrame - uploadBytes
    ) {
      throw new RangeError(
        `frame exceeds ${RUNTIME_LIMITS.webglVertexUploadBytesPerFrame} WebGL vertex-upload bytes`,
      );
    }
    uploadBytes += bytes;
    assertFloat32Geometry(geometry, frame.canvas.width, frame.canvas.height, subpixelQuantum);
  };

  let activeMaskGroup = -1;
  for (const item of frame.drawList) {
    if (item.opacity === 0) continue;
    if (item.mask && item.mask.group !== activeMaskGroup) {
      for (const source of frame.maskGroups[item.mask.group]!.sources) inspect(source);
      activeMaskGroup = item.mask.group;
    }
    inspect(item);
  }
}

function assertFloat32Affine(
  a: number,
  b: number,
  c: number,
  width: number,
  height: number,
  spriteId: string,
): void {
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    !Number.isFinite(c) ||
    Math.abs(a) > FLOAT32_MAX ||
    Math.abs(b) > FLOAT32_MAX ||
    Math.abs(c) > FLOAT32_MAX
  ) {
    throw new RangeError(
      `geometry for sprite "${spriteId}" has a canvas-to-uv map outside float32 range`,
    );
  }
  const fa = Math.fround(a);
  const fb = Math.fround(b);
  const fc = Math.fround(c);
  const termX = Math.fround(Math.abs(fa) * (width - 0.5));
  const termY = Math.fround(Math.abs(fb) * (height - 0.5));
  const magnitudeBound = Math.fround(termX + termY + Math.abs(fc));
  if (!Number.isFinite(termX) || !Number.isFinite(termY) || !Number.isFinite(magnitudeBound)) {
    throw new RangeError(`geometry for sprite "${spriteId}" can overflow float32 UV evaluation`);
  }
}

function assertFloat32Geometry(
  geometry: DeformedGeometry,
  width: number,
  height: number,
  subpixelQuantum: number,
): void {
  const { positions, uvs, indices } = geometry;
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t]!;
    const i1 = indices[t + 1]!;
    const i2 = indices[t + 2]!;
    const x0 = positions[2 * i0]!;
    const y0 = positions[2 * i0 + 1]!;
    const x1 = positions[2 * i1]!;
    const y1 = positions[2 * i1 + 1]!;
    const x2 = positions[2 * i2]!;
    const y2 = positions[2 * i2 + 1]!;
    if (
      Math.abs(x0) > FLOAT32_MAX ||
      Math.abs(y0) > FLOAT32_MAX ||
      Math.abs(x1) > FLOAT32_MAX ||
      Math.abs(y1) > FLOAT32_MAX ||
      Math.abs(x2) > FLOAT32_MAX ||
      Math.abs(y2) > FLOAT32_MAX
    ) {
      throw new RangeError(`geometry for sprite "${geometry.sprite.id}" exceeds float32 range`);
    }
    const ndcX0 = Math.fround(Math.fround(float32Position(x0, subpixelQuantum) / width) * 2 - 1);
    const ndcY0 = Math.fround(1 - Math.fround(float32Position(y0, subpixelQuantum) / height) * 2);
    const ndcX1 = Math.fround(Math.fround(float32Position(x1, subpixelQuantum) / width) * 2 - 1);
    const ndcY1 = Math.fround(1 - Math.fround(float32Position(y1, subpixelQuantum) / height) * 2);
    const ndcX2 = Math.fround(Math.fround(float32Position(x2, subpixelQuantum) / width) * 2 - 1);
    const ndcY2 = Math.fround(1 - Math.fround(float32Position(y2, subpixelQuantum) / height) * 2);
    if (
      !Number.isFinite(ndcX0) ||
      !Number.isFinite(ndcY0) ||
      !Number.isFinite(ndcX1) ||
      !Number.isFinite(ndcY1) ||
      !Number.isFinite(ndcX2) ||
      !Number.isFinite(ndcY2)
    ) {
      throw new RangeError(
        `geometry for sprite "${geometry.sprite.id}" can overflow its float32 clip transform`,
      );
    }
    const denom = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (denom === 0) continue;
    const floatArea = Math.fround(
      Math.fround(Math.fround(ndcX1 - ndcX0) * Math.fround(ndcY2 - ndcY0)) -
        Math.fround(Math.fround(ndcY1 - ndcY0) * Math.fround(ndcX2 - ndcX0)),
    );
    if (floatArea === 0) {
      throw new RangeError(
        `geometry for sprite "${geometry.sprite.id}" collapses after float32 clip conversion`,
      );
    }
    const a0 = -(y2 - y1);
    const b0 = x2 - x1;
    const c0 = (y2 - y1) * x1 - (x2 - x1) * y1;
    const a1 = -(y0 - y2);
    const b1 = x0 - x2;
    const c1 = (y0 - y2) * x2 - (x0 - x2) * y2;
    const a2 = -(y1 - y0);
    const b2 = x1 - x0;
    const c2 = (y1 - y0) * x0 - (x1 - x0) * y0;
    const u0 = uvs[2 * i0]!;
    const v0 = uvs[2 * i0 + 1]!;
    const u1 = uvs[2 * i1]!;
    const v1 = uvs[2 * i1 + 1]!;
    const u2 = uvs[2 * i2]!;
    const v2 = uvs[2 * i2 + 1]!;
    const cux = (u0 * a0 + u1 * a1 + u2 * a2) / denom;
    const cuy = (u0 * b0 + u1 * b1 + u2 * b2) / denom;
    const cuz = (u0 * c0 + u1 * c1 + u2 * c2) / denom;
    const cvx = (v0 * a0 + v1 * a1 + v2 * a2) / denom;
    const cvy = (v0 * b0 + v1 * b1 + v2 * b2) / denom;
    const cvz = (v0 * c0 + v1 * c1 + v2 * c2) / denom;
    assertFloat32Affine(cux, cuy, cuz, width, height, geometry.sprite.id);
    assertFloat32Affine(cvx, cvy, cvz, width, height, geometry.sprite.id);
  }
}

function requireSurfaceDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.canvasDimension ||
    height > LIMITS.canvasDimension ||
    width * height > LIMITS.canvasPixels
  ) {
    throw new RangeError(
      `surface dimensions must fit ${LIMITS.canvasDimension}px per axis and ${LIMITS.canvasPixels} total pixels`,
    );
  }
}

function requireDeviceSurfaceDimensions(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): number {
  const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as ArrayLike<number>;
  const maxViewportWidth = Number(viewport[0]);
  const maxViewportHeight = Number(viewport[1]);
  if (
    !Number.isFinite(maxTextureSize) ||
    !Number.isFinite(maxViewportWidth) ||
    !Number.isFinite(maxViewportHeight)
  ) {
    throw new Error("WebGL: failed to query device texture/viewport limits");
  }
  if (width > maxTextureSize || height > maxTextureSize) {
    throw new RangeError(
      `surface ${width}x${height} exceeds this WebGL device's MAX_TEXTURE_SIZE ${maxTextureSize}`,
    );
  }
  if (width > maxViewportWidth || height > maxViewportHeight) {
    throw new RangeError(
      `surface ${width}x${height} exceeds this WebGL device's MAX_VIEWPORT_DIMS ${maxViewportWidth}x${maxViewportHeight}`,
    );
  }
  return maxTextureSize;
}

function requireTexture(
  image: PremultipliedImage,
  atlasRect?: readonly [number, number, number, number],
): void {
  const { width, height, data } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.textureDimension ||
    height > LIMITS.textureDimension ||
    width * height > LIMITS.texturePixels
  ) {
    throw new RangeError(
      `texture dimensions must fit ${LIMITS.textureDimension}px per axis and ${LIMITS.texturePixels} total pixels`,
    );
  }
  if (!(data instanceof Uint8Array)) {
    throw new RangeError(`premultiplied texture data must be a Uint8Array`);
  }
  if (data.length !== width * height * 4) {
    throw new RangeError(
      `premultiplied texture data has ${data.length} bytes; expected ${width * height * 4}`,
    );
  }
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    if (data[i]! > alpha || data[i + 1]! > alpha || data[i + 2]! > alpha) {
      throw new RangeError(`premultiplied texture RGB channels must not exceed alpha`);
    }
  }
  requireAtlasRect(width, height, atlasRect);
}

function requireAtlasRect(
  width: number,
  height: number,
  atlasRect?: readonly [number, number, number, number],
): void {
  if (atlasRect) {
    const [x, y, w, h] = atlasRect;
    if (
      !atlasRect.every(Number.isInteger) ||
      x < 0 ||
      y < 0 ||
      w < 1 ||
      h < 1 ||
      x + w > width ||
      y + h > height
    ) {
      throw new RangeError(`atlas crop must be a positive integer rectangle inside the texture`);
    }
  }
}

function snapshotAtlasRect(
  width: number,
  height: number,
  atlasRect?: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  return atlasRect
    ? [atlasRect[0], atlasRect[1], atlasRect[2], atlasRect[3]]
    : [0, 0, width, height];
}

/**
 * Expand indexed geometry into per-triangle vertices carrying the triangle's
 * affine canvas→uv map (u = cuₓ·x + cu_y·y + cu_z, float64-derived), and
 * normalize winding to positive.
 *
 * - Winding: deformation may flip triangles. The CPU reference rasterizes
 *   every triangle in positive winding, keeping shared edges of
 *   opposite-winding neighbors covered exactly once; the GPU applies its fill
 *   rule to the winding as submitted, leaving one-pixel holes where flipped
 *   and unflipped cells meet on a pixel center.
 * - Affine uv: the fragment shader evaluates the map at gl_FragCoord instead
 *   of using vertex-interpolated uvs, which the rasterizer derives from
 *   subpixel-snapped vertices (SwiftShader: 4 bits → 1/16 px, enough to drift
 *   past ±2/255 on steep gradients).
 * - Degenerate (zero-area) triangles are dropped — the CPU reference skips
 *   them too.
 */
function deindex(
  positions: ReadonlyFloat64Array,
  uvs: ReadonlyFloat64Array,
  indices: ReadonlyUint32Array,
  subpixelQuantum: number,
): Deindexed {
  const triCount = indices.length / 3;
  const pos = new Float32Array(triCount * 6);
  const cu = new Float32Array(triCount * 9);
  const cv = new Float32Array(triCount * 9);
  let out = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t]!;
    let i1 = indices[t + 1]!;
    let i2 = indices[t + 2]!;
    const x0 = positions[2 * i0]!;
    const y0 = positions[2 * i0 + 1]!;
    let x1 = positions[2 * i1]!;
    let y1 = positions[2 * i1 + 1]!;
    let x2 = positions[2 * i2]!;
    let y2 = positions[2 * i2 + 1]!;
    let denom = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (denom === 0) continue;
    if (denom < 0) {
      const ti = i1;
      i1 = i2;
      i2 = ti;
      let tv = x1;
      x1 = x2;
      x2 = tv;
      tv = y1;
      y1 = y2;
      y2 = tv;
      denom = -denom;
    }
    // Barycentric edge functions as linear forms wᵢ(x, y) = aᵢx + bᵢy + cᵢ.
    const a0 = -(y2 - y1);
    const b0 = x2 - x1;
    const c0 = (y2 - y1) * x1 - (x2 - x1) * y1;
    const a1 = -(y0 - y2);
    const b1 = x0 - x2;
    const c1 = (y0 - y2) * x2 - (x0 - x2) * y2;
    const a2 = -(y1 - y0);
    const b2 = x1 - x0;
    const c2 = (y1 - y0) * x0 - (x1 - x0) * y0;
    const u0 = uvs[2 * i0]!;
    const v0 = uvs[2 * i0 + 1]!;
    const u1 = uvs[2 * i1]!;
    const v1 = uvs[2 * i1 + 1]!;
    const u2 = uvs[2 * i2]!;
    const v2 = uvs[2 * i2 + 1]!;
    const cux = (u0 * a0 + u1 * a1 + u2 * a2) / denom;
    const cuy = (u0 * b0 + u1 * b1 + u2 * b2) / denom;
    const cuz = (u0 * c0 + u1 * c1 + u2 * c2) / denom;
    const cvx = (v0 * a0 + v1 * a1 + v2 * a2) / denom;
    const cvy = (v0 * b0 + v1 * b1 + v2 * b2) / denom;
    const cvz = (v0 * c0 + v1 * c1 + v2 * c2) / denom;

    const xs = [x0, x1, x2];
    const ys = [y0, y1, y2];
    for (let k = 0; k < 3; k++) {
      pos[out * 2] = float32Position(xs[k]!, subpixelQuantum);
      pos[out * 2 + 1] = float32Position(ys[k]!, subpixelQuantum);
      cu[out * 3] = cux;
      cu[out * 3 + 1] = cuy;
      cu[out * 3 + 2] = cuz;
      cv[out * 3] = cvx;
      cv[out * 3 + 1] = cvy;
      cv[out * 3 + 2] = cvz;
      out++;
    }
  }
  return {
    pos: pos.subarray(0, out * 2) as Float32Array,
    cu: cu.subarray(0, out * 3) as Float32Array,
    cv: cv.subarray(0, out * 3) as Float32Array,
    vertexCount: out,
  };
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  let texture: WebGLTexture | null = null;
  let framebuffer: WebGLFramebuffer | null = null;
  try {
    discardGlErrors(gl);
    texture = must(gl.createTexture(), "texture");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // A null allocation is still a texImage2D pixel-transfer operation. In a
    // shared context it must not inherit a host PBO or unpack layout, either
    // during construction or when the mask target is allocated lazily.
    resetPixelUnpackState(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    assertNoGlError(gl, `allocating ${width}x${height} RGBA32F render target`);

    framebuffer = must(gl.createFramebuffer(), "framebuffer");
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    assertNoGlError(gl, "attaching the RGBA32F render target");
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`WebGL: RGBA32F framebuffer incomplete (status 0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer, texture };
  } catch (error) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    if (texture) gl.deleteTexture(texture);
    throw error;
  }
}

function deleteTarget(gl: WebGL2RenderingContext, target: Target): void {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

function buildProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = must(gl.createShader(type), "shader");
    try {
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
      }
      return shader;
    } catch (error) {
      gl.deleteShader(shader);
      throw error;
    }
  };

  let vertexShader: WebGLShader | null = null;
  let fragmentShader: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    vertexShader = compile(gl.VERTEX_SHADER, vert);
    fragmentShader = compile(gl.FRAGMENT_SHADER, frag);
    program = must(gl.createProgram(), "program");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    if (fragmentShader) gl.deleteShader(fragmentShader);
    if (vertexShader) gl.deleteShader(vertexShader);
  }
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`WebGL: failed to create ${what}`);
  return value;
}

function discardGlErrors(gl: WebGL2RenderingContext): void {
  assertContextAvailable(gl, "start a WebGL operation");
  for (let i = 0; i < 32; i++) {
    if (gl.getError() === gl.NO_ERROR) {
      assertContextAvailable(gl, "start a WebGL operation");
      return;
    }
  }
  assertContextAvailable(gl, "start a WebGL operation");
}

function assertContextAvailable(gl: WebGL2RenderingContext, operation: string): void {
  if (gl.isContextLost()) {
    throw new Error(`WebGL: cannot ${operation} because the context is lost`);
  }
}

function assertTransformFeedbackSafe(gl: WebGL2RenderingContext, operation: string): void {
  const active = Boolean(gl.getParameter(gl.TRANSFORM_FEEDBACK_ACTIVE));
  const paused = Boolean(gl.getParameter(gl.TRANSFORM_FEEDBACK_PAUSED));
  if (active && !paused) {
    throw new Error(
      `WebGL: cannot ${operation} while transform feedback is active and unpaused on the shared context`,
    );
  }
}

function assertDrawQueriesSafe(gl: WebGL2RenderingContext, operation: string): void {
  const targets: Array<readonly [number, string]> = [
    [gl.ANY_SAMPLES_PASSED, "ANY_SAMPLES_PASSED"],
    [gl.ANY_SAMPLES_PASSED_CONSERVATIVE, "ANY_SAMPLES_PASSED_CONSERVATIVE"],
    [gl.TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN, "TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN"],
  ];
  const timerQuery = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (timerQuery) targets.push([timerQuery.TIME_ELAPSED_EXT, "TIME_ELAPSED_EXT"]);
  for (const [target, name] of targets) {
    if (gl.getQuery(target, gl.CURRENT_QUERY) !== null) {
      throw new Error(`WebGL: cannot ${operation} while host query ${name} is active`);
    }
  }
}

/**
 * Snapshot every caller-owned binding and fixed-function value this renderer
 * can touch. WebGL has no push/pop state API, and DRAW/READ framebuffer
 * bindings plus sampler bindings are independently indexed in WebGL2.
 */
function captureGlState(gl: WebGL2RenderingContext): GlStateSnapshot {
  const activeTexture = Number(gl.getParameter(gl.ACTIVE_TEXTURE));
  const textureUnits: TextureUnitState[] = [];
  try {
    for (let unit = 0; unit < 2; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      textureUnits.push({
        texture2D: gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null,
        sampler: gl.getParameter(gl.SAMPLER_BINDING) as WebGLSampler | null,
      });
    }
  } finally {
    gl.activeTexture(activeTexture);
  }

  const drawFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  let defaultDrawBuffer: number = gl.BACK;
  try {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    defaultDrawBuffer = Number(gl.getParameter(gl.DRAW_BUFFER0));
  } finally {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFramebuffer);
  }

  const colorMask = gl.getParameter(gl.COLOR_WRITEMASK) as ArrayLike<boolean>;
  const viewport = gl.getParameter(gl.VIEWPORT) as ArrayLike<number>;
  const clearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE) as ArrayLike<number>;
  const pixelStorePnames = [
    gl.UNPACK_ALIGNMENT,
    gl.UNPACK_ROW_LENGTH,
    gl.UNPACK_IMAGE_HEIGHT,
    gl.UNPACK_SKIP_PIXELS,
    gl.UNPACK_SKIP_ROWS,
    gl.UNPACK_SKIP_IMAGES,
    gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
    gl.UNPACK_FLIP_Y_WEBGL,
    gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,
    gl.PACK_ALIGNMENT,
    gl.PACK_ROW_LENGTH,
    gl.PACK_SKIP_PIXELS,
    gl.PACK_SKIP_ROWS,
  ];
  const capabilityPnames = [
    gl.BLEND,
    gl.CULL_FACE,
    gl.DEPTH_TEST,
    gl.DITHER,
    gl.RASTERIZER_DISCARD,
    gl.SAMPLE_ALPHA_TO_COVERAGE,
    gl.SAMPLE_COVERAGE,
    gl.SCISSOR_TEST,
    gl.STENCIL_TEST,
  ];

  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
    vertexArray: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null,
    pixelPackBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) as WebGLBuffer | null,
    pixelUnpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null,
    drawFramebuffer,
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    defaultDrawBuffer,
    activeTexture,
    textureUnits: [textureUnits[0]!, textureUnits[1]!],
    pixelStore: pixelStorePnames.map((pname) => [pname, Number(gl.getParameter(pname))] as const),
    capabilities: capabilityPnames.map((pname) => [pname, gl.isEnabled(pname)] as const),
    colorMask: [
      Boolean(colorMask[0]),
      Boolean(colorMask[1]),
      Boolean(colorMask[2]),
      Boolean(colorMask[3]),
    ],
    blendEquationRgb: Number(gl.getParameter(gl.BLEND_EQUATION_RGB)),
    blendEquationAlpha: Number(gl.getParameter(gl.BLEND_EQUATION_ALPHA)),
    blendSrcRgb: Number(gl.getParameter(gl.BLEND_SRC_RGB)),
    blendDstRgb: Number(gl.getParameter(gl.BLEND_DST_RGB)),
    blendSrcAlpha: Number(gl.getParameter(gl.BLEND_SRC_ALPHA)),
    blendDstAlpha: Number(gl.getParameter(gl.BLEND_DST_ALPHA)),
    viewport: [Number(viewport[0]), Number(viewport[1]), Number(viewport[2]), Number(viewport[3])],
    clearColor: [
      Number(clearColor[0]),
      Number(clearColor[1]),
      Number(clearColor[2]),
      Number(clearColor[3]),
    ],
  };
}

function restoreGlState(gl: WebGL2RenderingContext, state: GlStateSnapshot): void {
  // A lost context has no restorable object namespace. Its restoration event,
  // if the host requests one, recreates default state and invalidates this
  // renderer separately.
  if (gl.isContextLost()) return;

  if (gl.getParameter(gl.CURRENT_PROGRAM) !== state.program) gl.useProgram(state.program);
  if (gl.getParameter(gl.VERTEX_ARRAY_BINDING) !== state.vertexArray) {
    gl.bindVertexArray(state.vertexArray);
  }
  if (gl.getParameter(gl.ARRAY_BUFFER_BINDING) !== state.arrayBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, state.arrayBuffer);
  }
  if (gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) !== state.pixelUnpackBuffer) {
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, state.pixelUnpackBuffer);
  }
  if (gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) !== state.pixelPackBuffer) {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, state.pixelPackBuffer);
  }
  for (const [pname, value] of state.pixelStore) {
    if (Number(gl.getParameter(pname)) !== value) gl.pixelStorei(pname, value);
  }

  let activeTexture = Number(gl.getParameter(gl.ACTIVE_TEXTURE));
  for (let unit = 0; unit < 2; unit++) {
    const textureUnit = gl.TEXTURE0 + unit;
    if (activeTexture !== textureUnit) {
      gl.activeTexture(textureUnit);
      activeTexture = textureUnit;
    }
    const saved = state.textureUnits[unit]!;
    if (gl.getParameter(gl.TEXTURE_BINDING_2D) !== saved.texture2D) {
      gl.bindTexture(gl.TEXTURE_2D, saved.texture2D);
    }
    if (gl.getParameter(gl.SAMPLER_BINDING) !== saved.sampler) gl.bindSampler(unit, saved.sampler);
  }
  if (activeTexture !== state.activeTexture) gl.activeTexture(state.activeTexture);

  // drawBuffers() mutates state owned by the currently bound draw
  // framebuffer. present() targets the default framebuffer, so restore that
  // framebuffer's selection before reinstating the caller's two bindings.
  if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  if (Number(gl.getParameter(gl.DRAW_BUFFER0)) !== state.defaultDrawBuffer) {
    gl.drawBuffers([state.defaultDrawBuffer]);
  }
  if (state.drawFramebuffer !== null) {
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, state.drawFramebuffer);
  }
  if (gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) !== state.readFramebuffer) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, state.readFramebuffer);
  }

  const viewport = gl.getParameter(gl.VIEWPORT) as ArrayLike<number>;
  if (state.viewport.some((value, index) => Number(viewport[index]) !== value)) {
    gl.viewport(...state.viewport);
  }
  const clearColor = gl.getParameter(gl.COLOR_CLEAR_VALUE) as ArrayLike<number>;
  if (state.clearColor.some((value, index) => Number(clearColor[index]) !== value)) {
    gl.clearColor(...state.clearColor);
  }
  const colorMask = gl.getParameter(gl.COLOR_WRITEMASK) as ArrayLike<boolean>;
  if (state.colorMask.some((value, index) => Boolean(colorMask[index]) !== value)) {
    gl.colorMask(...state.colorMask);
  }
  if (
    Number(gl.getParameter(gl.BLEND_EQUATION_RGB)) !== state.blendEquationRgb ||
    Number(gl.getParameter(gl.BLEND_EQUATION_ALPHA)) !== state.blendEquationAlpha
  ) {
    gl.blendEquationSeparate(state.blendEquationRgb, state.blendEquationAlpha);
  }
  if (
    Number(gl.getParameter(gl.BLEND_SRC_RGB)) !== state.blendSrcRgb ||
    Number(gl.getParameter(gl.BLEND_DST_RGB)) !== state.blendDstRgb ||
    Number(gl.getParameter(gl.BLEND_SRC_ALPHA)) !== state.blendSrcAlpha ||
    Number(gl.getParameter(gl.BLEND_DST_ALPHA)) !== state.blendDstAlpha
  ) {
    gl.blendFuncSeparate(
      state.blendSrcRgb,
      state.blendDstRgb,
      state.blendSrcAlpha,
      state.blendDstAlpha,
    );
  }
  for (const [pname, enabled] of state.capabilities) {
    if (gl.isEnabled(pname) !== enabled) {
      if (enabled) gl.enable(pname);
      else gl.disable(pname);
    }
  }
}

/** Establish the renderer-owned state for a tightly packed 2D typed-array upload. */
function resetPixelUnpackState(gl: WebGL2RenderingContext): void {
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
}

/** Establish the renderer-owned state for a tightly packed typed-array readback. */
function resetPixelPackState(gl: WebGL2RenderingContext): void {
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
}

function assertNoGlError(gl: WebGL2RenderingContext, operation: string): void {
  if (gl.isContextLost()) {
    throw new Error(`WebGL: ${operation} failed because the context is lost`);
  }
  const errors: number[] = [];
  for (let i = 0; i < 32; i++) {
    const error = gl.getError();
    if (error === gl.NO_ERROR) break;
    errors.push(error);
  }
  if (errors.length > 0) {
    const names = errors.map((error) => glErrorName(gl, error)).join(", ");
    throw new Error(`WebGL: ${operation} failed (${names})`);
  }
  if (gl.isContextLost()) {
    throw new Error(`WebGL: ${operation} failed because the context is lost`);
  }
}

function glErrorName(gl: WebGL2RenderingContext, error: number): string {
  switch (error) {
    case gl.INVALID_ENUM:
      return "INVALID_ENUM";
    case gl.INVALID_VALUE:
      return "INVALID_VALUE";
    case gl.INVALID_OPERATION:
      return "INVALID_OPERATION";
    case gl.INVALID_FRAMEBUFFER_OPERATION:
      return "INVALID_FRAMEBUFFER_OPERATION";
    case gl.OUT_OF_MEMORY:
      return "OUT_OF_MEMORY";
    case gl.CONTEXT_LOST_WEBGL:
      return "CONTEXT_LOST_WEBGL";
    default:
      return `0x${error.toString(16)}`;
  }
}

/** Fullscreen-triangle blit used by present(). */
function buildBlit(gl: WebGL2RenderingContext): {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
} {
  discardGlErrors(gl);
  const program = buildProgram(
    gl,
    `#version 300 es
     precision highp float;
     out vec2 v_uv;
     void main() {
       vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
       v_uv = p;
       gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
     }`,
    `#version 300 es
     precision highp float;
     in vec2 v_uv;
     uniform sampler2D u_tex;
     out vec4 outColor;
     void main() { outColor = texture(u_tex, v_uv); }`,
  );
  let vao: WebGLVertexArrayObject | null = null;
  try {
    vao = must(gl.createVertexArray(), "vao");
    gl.useProgram(program);
    const loc = gl.getUniformLocation(program, "u_tex");
    if (loc === null) throw new Error("uniform u_tex not found");
    gl.uniform1i(loc, 0);
    assertNoGlError(gl, "initializing the presentation program");
    return { program, vao };
  } catch (error) {
    if (vao) gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    throw error;
  }
}

/** Recommended context attributes for hosting canvases (R3/R4). */
export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  antialias: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
};

export function createWebGLRenderer(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLRenderer {
  return new WebGLRenderer(gl, width, height);
}
