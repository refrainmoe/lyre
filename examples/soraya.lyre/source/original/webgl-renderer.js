import {
  deformDrawable,
  evaluateGroupMatrices,
  fitViewToAspect,
} from "./rig-runtime.js";

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_uv;

uniform vec4 u_view;

out vec2 v_uv;

void main() {
  vec2 position = (a_position - u_view.xy) / u_view.zw;
  gl_Position = vec4(
    position.x * 2.0 - 1.0,
    1.0 - position.y * 2.0,
    0.0,
    1.0
  );
  v_uv = a_uv;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform sampler2D u_mask;
uniform vec2 u_mask_size;
uniform vec4 u_mask_channel;
uniform float u_opacity;
uniform bool u_clipped;
uniform bool u_mask_pass;

in vec2 v_uv;
out vec4 out_color;

void main() {
  vec4 color = texture(u_atlas, v_uv);
  color *= u_opacity;

  if (u_mask_pass) {
    out_color = vec4(color.a);
    return;
  }

  if (u_clipped) {
    vec2 mask_uv = gl_FragCoord.xy / u_mask_size;
    color *= dot(texture(u_mask, mask_uv), u_mask_channel);
  }

  out_color = color;
}
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Soraya shader compilation failed: ${message}`);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Soraya shader linking failed: ${message}`);
  }
  return program;
}

function createAtlasTexture(gl, image) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    image,
  );
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    gl.LINEAR_MIPMAP_LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function createDrawableResources(gl, locations, drawable) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, drawable.mesh.positions, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(locations.position);
  gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);

  const uvBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, drawable.mesh.uvs, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(locations.uv);
  gl.vertexAttribPointer(locations.uv, 2, gl.FLOAT, false, 0, 0);

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, drawable.mesh.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  return {
    vao,
    positionBuffer,
    uvBuffer,
    indexBuffer,
    indexCount: drawable.mesh.indices.length,
    opacity: 1,
  };
}

function deleteDrawableResources(gl, resource) {
  gl.deleteVertexArray(resource.vao);
  gl.deleteBuffer(resource.positionBuffer);
  gl.deleteBuffer(resource.uvBuffer);
  gl.deleteBuffer(resource.indexBuffer);
}

export class WebGLRigRenderer {
  constructor(canvas, compiledRig, atlasImage, contextOptions = {}) {
    this.canvas = canvas;
    this.rig = compiledRig;
    this.atlasImage = atlasImage;
    this.contextOptions = {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
      ...contextOptions,
    };
    this.gl = canvas.getContext("webgl2", this.contextOptions);
    if (!this.gl) {
      throw new Error("WebGL2 is unavailable");
    }
    const viewportLimits = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
    const sharedLimit = Math.min(
      this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE),
      this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE),
    );
    this.maxRenderSize = {
      width: Math.min(sharedLimit, viewportLimits[0]),
      height: Math.min(sharedLimit, viewportLimits[1]),
    };
    this.width = 1;
    this.height = 1;
    this.stats = {
      drawCalls: 0,
      maskDrawCalls: 0,
      width: 1,
      height: 1,
      vertices: compiledRig.drawables.reduce(
        (total, drawable) => total + drawable.mesh.vertexCount,
        0,
      ),
    };
    this._createResources();
  }

  _createResources() {
    const gl = this.gl;
    this.program = createProgram(gl);
    this.locations = {
      position: gl.getAttribLocation(this.program, "a_position"),
      uv: gl.getAttribLocation(this.program, "a_uv"),
      view: gl.getUniformLocation(this.program, "u_view"),
      atlas: gl.getUniformLocation(this.program, "u_atlas"),
      mask: gl.getUniformLocation(this.program, "u_mask"),
      maskSize: gl.getUniformLocation(this.program, "u_mask_size"),
      maskChannel: gl.getUniformLocation(this.program, "u_mask_channel"),
      opacity: gl.getUniformLocation(this.program, "u_opacity"),
      clipped: gl.getUniformLocation(this.program, "u_clipped"),
      maskPass: gl.getUniformLocation(this.program, "u_mask_pass"),
    };
    this.atlasTexture = createAtlasTexture(gl, this.atlasImage);
    this.drawableResources = new Map();
    for (const drawable of this.rig.drawables) {
      this.drawableResources.set(
        drawable.id,
        createDrawableResources(gl, this.locations, drawable),
      );
    }
    const maskSources = this.rig.drawables.filter((drawable) => (
      drawable.maskSource
    ));
    if (maskSources.length > 4) {
      throw new Error("The tiny Soraya renderer supports at most four clip masks");
    }
    this.clipChannels = new Map(maskSources.map((drawable, index) => {
      const channel = [0, 0, 0, 0];
      channel[index] = 1;
      return [drawable.id, channel];
    }));

    this.maskTexture = gl.createTexture();
    this.maskFramebuffer = gl.createFramebuffer();
    this._resizeMaskTarget();

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.useProgram(this.program);
    gl.uniform1i(this.locations.atlas, 0);
    gl.uniform1i(this.locations.mask, 1);
  }

  _resizeMaskTarget() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      Math.max(1, this.width),
      Math.max(1, this.height),
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.maskTexture,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Soraya eye-mask framebuffer is incomplete (${status})`);
    }
  }

  resize(width, height) {
    const requestedWidth = Math.max(1, Math.floor(width));
    const requestedHeight = Math.max(1, Math.floor(height));
    const fit = Math.min(
      1,
      this.maxRenderSize.width / requestedWidth,
      this.maxRenderSize.height / requestedHeight,
    );
    const nextWidth = Math.max(1, Math.floor(requestedWidth * fit));
    const nextHeight = Math.max(1, Math.floor(requestedHeight * fit));
    if (nextWidth === this.width && nextHeight === this.height) {
      return false;
    }
    this.width = nextWidth;
    this.height = nextHeight;
    if (this.canvas.width !== nextWidth) {
      this.canvas.width = nextWidth;
    }
    if (this.canvas.height !== nextHeight) {
      this.canvas.height = nextHeight;
    }
    this.stats.width = nextWidth;
    this.stats.height = nextHeight;
    this._resizeMaskTarget();
    return true;
  }

  _uploadDrawable(drawable) {
    const gl = this.gl;
    const resource = this.drawableResources.get(drawable.id);
    gl.bindBuffer(gl.ARRAY_BUFFER, resource.positionBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, drawable.mesh.positions);
  }

  _draw(drawable, maskPass) {
    const gl = this.gl;
    const resource = this.drawableResources.get(drawable.id);
    gl.bindVertexArray(resource.vao);
    gl.uniform1f(this.locations.opacity, resource.opacity);
    gl.uniform1i(this.locations.clipped, !maskPass && drawable.clip ? 1 : 0);
    const channel = this.clipChannels.get(drawable.clip) ?? [0, 0, 0, 0];
    gl.uniform4f(this.locations.maskChannel, ...channel);
    gl.drawElements(
      gl.TRIANGLES,
      resource.indexCount,
      gl.UNSIGNED_SHORT,
      0,
    );
  }

  render(parameters, view) {
    const gl = this.gl;
    if (gl.isContextLost()) {
      return this.stats;
    }

    const resolvedParameters = evaluateGroupMatrices(this.rig, parameters);
    for (const drawable of this.rig.drawables) {
      const resource = this.drawableResources.get(drawable.id);
      resource.opacity = deformDrawable(
        drawable,
        this.rig,
        resolvedParameters,
      );
      this._uploadDrawable(drawable);
    }

    const fittedView = fitViewToAspect(view, this.width / this.height);
    gl.useProgram(this.program);
    gl.uniform4f(
      this.locations.view,
      fittedView.x,
      fittedView.y,
      fittedView.width,
      fittedView.height,
    );
    gl.uniform2f(this.locations.maskSize, this.width, this.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(this.locations.maskPass, 1);
    this.stats.maskDrawCalls = 0;
    for (const drawable of this.rig.drawables) {
      if (!drawable.maskSource) {
        continue;
      }
      const channel = this.clipChannels.get(drawable.id);
      gl.colorMask(
        Boolean(channel[0]),
        Boolean(channel[1]),
        Boolean(channel[2]),
        Boolean(channel[3]),
      );
      this._draw(drawable, true);
      this.stats.maskDrawCalls += 1;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(this.locations.maskPass, 0);
    this.stats.drawCalls = 0;
    for (const drawable of this.rig.drawables) {
      this._draw(drawable, false);
      this.stats.drawCalls += 1;
    }
    gl.bindVertexArray(null);
    return this.stats;
  }

  restore() {
    this._createResources();
    this.resize(this.canvas.width, this.canvas.height);
  }

  destroy({ contextLost = false } = {}) {
    const gl = this.gl;
    if (!gl || contextLost) {
      return;
    }
    for (const resource of this.drawableResources?.values() ?? []) {
      deleteDrawableResources(gl, resource);
    }
    gl.deleteTexture(this.atlasTexture);
    gl.deleteTexture(this.maskTexture);
    gl.deleteFramebuffer(this.maskFramebuffer);
    gl.deleteProgram(this.program);
  }
}

export default WebGLRigRenderer;
