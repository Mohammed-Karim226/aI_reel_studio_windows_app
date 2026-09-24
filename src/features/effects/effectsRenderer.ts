import type { EvaluatedEffect } from "@/domain/effects";

export type PreviewMedia = HTMLImageElement | HTMLVideoElement;

const MAX_PREVIEW_EDGE = 1920;
const MAX_PREVIEW_PIXELS = 1920 * 1080;
const MAX_SOURCE_EDGE = 4096;
const MAX_SOURCE_PIXELS = 3840 * 2160;

/** Bound GPU allocations independently of monitor DPI, window size, and original media size. */
export function boundedDimensions(
  width: number,
  height: number,
  maxEdge: number,
  maxPixels: number,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    maxEdge / Math.max(width, height),
    Math.sqrt(maxPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

const vertexSource = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 point = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = point;
  gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
}`;

// All intermediate textures contain premultiplied alpha. This avoids dark fringes when
// blurring transparent images or the edges of media fitted into a portrait composition.
const fragmentSource = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
uniform sampler2D uOriginal;
uniform int uMode;
uniform vec2 uFit;
uniform vec2 uCenter;
uniform vec2 uStep;
uniform vec4 uValues;
uniform vec2 uBalance;

vec4 gaussianBlur() {
  vec4 total = vec4(0.0);
  float weightSum = 0.0;
  for (int i = -8; i <= 8; i++) {
    float distance = float(i) / 8.0;
    float weight = exp(-4.5 * distance * distance);
    total += texture(uInput, vUv + uStep * distance) * weight;
    weightSum += weight;
  }
  return total / weightSum;
}

void main() {
  vec4 pixel = texture(uInput, vUv);
  if (uMode == 1) {
    vec2 uv = (vUv - 0.5) / uFit + 0.5;
    outColor = any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))
      ? vec4(0.0) : texture(uInput, uv);
  } else if (uMode == 2) {
    outColor = texture(uInput, uCenter + (vUv - uCenter) / uValues.x);
  } else if (uMode == 3) {
    outColor = gaussianBlur();
  } else if (uMode == 4) {
    vec3 color = pixel.a > 0.00001 ? pixel.rgb / pixel.a : vec3(0.0);
    color *= uValues.x;
    color = (color - 0.5) * uValues.y + 0.5;
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = mix(vec3(luminance), color, uValues.z);
    color += vec3(uBalance.x * 0.1 + uBalance.y * 0.08,
                  -uBalance.y * 0.08, -uBalance.x * 0.1 + uBalance.y * 0.08);
    outColor = vec4(clamp(color, 0.0, 1.0) * pixel.a, pixel.a);
  } else if (uMode == 5) {
    vec4 original = texture(uOriginal, vUv);
    float alpha = original.a + pixel.a * min(uValues.x, 1.0) * (1.0 - original.a);
    vec3 color = original.rgb + pixel.rgb * uValues.x * (1.0 - original.rgb);
    outColor = vec4(clamp(color, vec3(0.0), vec3(alpha)), alpha);
  } else if (uMode == 6) {
    vec4 neighbors = texture(uInput, vUv + vec2(uStep.x, 0.0))
      + texture(uInput, vUv - vec2(uStep.x, 0.0))
      + texture(uInput, vUv + vec2(0.0, uStep.y))
      + texture(uInput, vUv - vec2(0.0, uStep.y));
    vec3 color = pixel.rgb + uValues.x * (4.0 * pixel.rgb - neighbors.rgb);
    outColor = vec4(clamp(color, vec3(0.0), vec3(pixel.a)), pixel.a);
  } else if (uMode == 7) {
    float distance = length((vUv - 0.5) * 1.41421356237);
    float shade = smoothstep(uValues.y, uValues.y + uValues.z, distance) * uValues.x;
    outColor = vec4(pixel.rgb * (1.0 - shade), pixel.a);
  } else {
    outColor = pixel;
  }
}`;

/** One source texture, three reusable targets, and one program per active visual clip. */
export class EffectsRenderer {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  private sourceTexture: WebGLTexture | null = null;
  private targets: WebGLTexture[] = [];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private width = 0;
  private height = 0;
  private sourceWidth = 0;
  private sourceHeight = 0;
  private verifiedFrame = false;
  private stagingCanvas: HTMLCanvasElement | null = null;
  private readonly maxTextureSize: number;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is unavailable in this graphics session.");
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const shaders: WebGLShader[] = [];
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertexSource],
        [gl.FRAGMENT_SHADER, fragmentSource],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error("Unable to allocate an effects shader.");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(gl.getShaderInfoLog(shader) || "An effects shader could not compile.");
      }
      this.program = gl.createProgram();
      if (!this.program) throw new Error("Unable to allocate the effects program.");
      shaders.forEach((shader) => gl.attachShader(this.program!, shader));
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw new Error(
          gl.getProgramInfoLog(this.program) || "The effects program could not link.",
        );
      for (const name of [
        "uInput",
        "uOriginal",
        "uMode",
        "uFit",
        "uCenter",
        "uStep",
        "uValues",
        "uBalance",
      ])
        this.uniforms[name] = gl.getUniformLocation(this.program, name);
      this.framebuffer = gl.createFramebuffer();
      if (!this.framebuffer) throw new Error("Unable to allocate the effects framebuffer.");
      this.sourceTexture = this.createTexture();
      for (let index = 0; index < 3; index++) this.targets.push(this.createTexture());
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      shaders.forEach((shader) => gl.deleteShader(shader));
    }
  }

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("Unable to allocate an effects texture.");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private resize(): boolean {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    if (!cssWidth || !cssHeight) return false;
    const { width, height } = boundedDimensions(
      cssWidth * ratio,
      cssHeight * ratio,
      Math.min(MAX_PREVIEW_EDGE, this.maxTextureSize),
      MAX_PREVIEW_PIXELS,
    );
    if (width === this.width && height === this.height) return true;
    const gl = this.gl;
    this.canvas.width = this.width = width;
    this.canvas.height = this.height = height;
    this.verifiedFrame = false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    for (const texture of this.targets) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error("The graphics device could not allocate an effects frame.");
    }
    if (gl.getError() !== gl.NO_ERROR)
      throw new Error("The graphics device ran out of effects memory.");
    return true;
  }

  private upload(media: PreviewMedia, width: number, height: number): void {
    const gl = this.gl;
    const size = boundedDimensions(
      width,
      height,
      Math.min(MAX_SOURCE_EDGE, this.maxTextureSize),
      MAX_SOURCE_PIXELS,
    );
    let source: TexImageSource = media;
    if (size.width !== width || size.height !== height) {
      this.stagingCanvas ??= document.createElement("canvas");
      if (this.stagingCanvas.width !== size.width || this.stagingCanvas.height !== size.height) {
        this.stagingCanvas.width = size.width;
        this.stagingCanvas.height = size.height;
      }
      const context = this.stagingCanvas.getContext("2d");
      if (!context) throw new Error("The source could not be resized for effects preview.");
      context.clearRect(0, 0, size.width, size.height);
      context.drawImage(media, 0, 0, size.width, size.height);
      source = this.stagingCanvas;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    if (size.width !== this.sourceWidth || size.height !== this.sourceHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.sourceWidth = size.width;
      this.sourceHeight = size.height;
      if (gl.getError() !== gl.NO_ERROR)
        throw new Error("The graphics device could not load this media for effects preview.");
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  private pass(
    mode: number,
    input: WebGLTexture,
    output: WebGLTexture | null,
    original: WebGLTexture = input,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, output ? this.framebuffer : null);
    if (output)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, original);
    gl.uniform1i(this.uniforms.uMode, mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Returns false until the requested media frame and nonzero canvas layout are available. */
  render(media: PreviewMedia, effects: EvaluatedEffect[], designWidth: number): boolean {
    if (this.disposed) return false;
    const video = "videoWidth" in media;
    if (video ? media.readyState < 2 || media.seeking : !media.complete) return false;
    const width = video ? media.videoWidth : media.naturalWidth;
    const height = video ? media.videoHeight : media.naturalHeight;
    if (!width || !height || !this.resize()) return false;
    this.upload(media, width, height);
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.width, this.height);
    gl.uniform1i(this.uniforms.uInput, 0);
    gl.uniform1i(this.uniforms.uOriginal, 1);
    const fit = Math.min(this.width / width, this.height / height);
    gl.uniform2f(this.uniforms.uFit, (width * fit) / this.width, (height * fit) / this.height);
    let current = this.targets[0];
    this.pass(1, this.sourceTexture!, current);
    const next = (except?: WebGLTexture) =>
      this.targets.find((texture) => texture !== current && texture !== except)!;
    const values = (a = 0, b = 0, c = 0, d = 0) => gl.uniform4f(this.uniforms.uValues, a, b, c, d);
    const apply = (mode: number) => {
      const output = next();
      this.pass(mode, current, output);
      current = output;
    };
    const blur = (radius: number, preserve?: WebGLTexture) => {
      const horizontal = next(preserve);
      gl.uniform2f(this.uniforms.uStep, radius / designWidth, 0);
      this.pass(3, current, horizontal);
      current = horizontal;
      const vertical = next(preserve);
      gl.uniform2f(this.uniforms.uStep, 0, (radius / designWidth) * (this.width / this.height));
      this.pass(3, current, vertical);
      current = vertical;
    };

    // Never group by effect type: every pass consumes the preceding stack entry's result.
    for (const { type, params } of effects) {
      switch (type) {
        case "zoom":
        case "punchZoom":
          if (params.scale === 1) break;
          values(params.scale);
          gl.uniform2f(this.uniforms.uCenter, params.centerX / 100, 1 - params.centerY / 100);
          apply(2);
          break;
        case "blur":
          if (params.radius > 0) blur(params.radius);
          break;
        case "color":
          if (
            params.brightness === 1 &&
            params.contrast === 1 &&
            params.saturation === 1 &&
            params.temperature === 0 &&
            params.tint === 0
          )
            break;
          values(params.brightness, params.contrast, params.saturation);
          gl.uniform2f(this.uniforms.uBalance, params.temperature, params.tint);
          apply(4);
          break;
        case "glow": {
          if (params.intensity === 0) break;
          const original = current;
          if (params.radius > 0) blur(params.radius, original);
          const output = next(original);
          values(params.intensity);
          this.pass(5, current, output, original);
          current = output;
          break;
        }
        case "sharpen":
          if (params.amount === 0) break;
          values(params.amount);
          gl.uniform2f(this.uniforms.uStep, 1 / this.width, 1 / this.height);
          apply(6);
          break;
        case "vignette":
          if (params.amount === 0) break;
          values(params.amount, params.radius, params.softness);
          apply(7);
          break;
      }
    }
    this.pass(0, current, null);
    if (!this.verifiedFrame) {
      if (gl.getError() !== gl.NO_ERROR)
        throw new Error("The graphics device could not render the effects stack.");
      this.verifiedFrame = true;
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (const unit of [gl.TEXTURE0, gl.TEXTURE1]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    this.targets.forEach((texture) => gl.deleteTexture(texture));
    gl.deleteTexture(this.sourceTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.program);
    this.targets = [];
    this.sourceTexture = null;
    this.framebuffer = null;
    this.program = null;
    this.canvas.width = this.canvas.height = 1;
    if (this.stagingCanvas) this.stagingCanvas.width = this.stagingCanvas.height = 0;
    this.stagingCanvas = null;
  }
}
