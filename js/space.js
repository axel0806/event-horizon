/* Space — ray-traced, monochrome Schwarzschild black hole rendered with WebGL.
 * Photons are integrated with the classic  a = -1.5 h^2 p / r^5  approximation, so the
 * accretion disk is gravitationally lensed over and under the shadow.
 *
 *   const space = Space.create(canvas);
 *   space.frame(nowMs);          // call once per animation frame
 *   space.setEnergy(0..1);       // bass level, brightens the disk
 *   space.setLook(x, y);         // -1..1 pointer parallax
 *   space.setRain(0..1);         // fogs/blurs the image like a wet window (eased over ~1 s)
 *
 * The trace renders into a texture; a post chain adds bloom/halation, lens softness and film grain,
 * and draws the final image to the canvas inside frame().
 */
window.Space = (() => {
  'use strict';

  const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform float uEnergy;
uniform vec2  uLook;
uniform vec2  uCenter;
uniform float uZoom;
uniform float uDist;
uniform float uDetail;   // 0..1: how much sub-pixel filament detail the current resolution can carry

const float R_IN  = 2.4;
const float R_OUT = 12.0;
const float B_CRIT = 2.598;   // critical impact parameter (3*sqrt(3)/2, r_s = 1)

float hash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  p = fract((p.xxy + p.yxx) * p.zyx);
  return fract(p.x + p.y * 1.618 + p.z * 2.414);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}

float fbm4(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.07 + 17.3; a *= 0.5; }
  return s / 0.9375;
}
float fbm5(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s / 0.969;
}

mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1,0,0, 0,c,s, 0,-s,c); }
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c,0,-s, 0,1,0, s,0,c); }

// ---------------------------------------------------------------- background
// One 2D star layer on a cube-face projection: varied sizes, a few bright stars with glints.
float starLayer(vec2 p, float sc, float dens, float seed) {
  vec2 q = p * sc;
  vec2 c = floor(q);
  vec2 f = fract(q) - 0.5;
  float h = hash13(vec3(c, seed));
  if (h < 1.0 - dens) return 0.0;
  float k = (h - (1.0 - dens)) / dens;                 // 0..1 rarity inside this layer
  vec2 j = vec2(hash13(vec3(c, seed + 7.1)), hash13(vec3(c, seed + 3.3))) - 0.5;
  vec2 d = f - j * 0.6;
  float size = mix(0.035, 0.085, k * k);
  float b = mix(0.25, 1.0, k * k * k) * (0.75 + 0.25 * sin(uTime * (0.6 + 2.5 * h) + h * 70.0));
  float s = b * exp(-dot(d, d) / (size * size));
  if (k > 0.82) {                                     // diffraction glint on the brightest
    float g = (k - 0.82) / 0.18;
    vec2 a = abs(d);
    float spike = exp(-a.x * 60.0 - a.y * 14.0) + exp(-a.y * 60.0 - a.x * 14.0);
    s += g * 0.45 * spike + g * 0.25 * exp(-dot(d, d) / 0.004);
  }
  return s;
}

vec3 background(vec3 d) {
  vec3 ad = abs(d);
  vec2 p; float face;
  if (ad.x > ad.y && ad.x > ad.z) { p = d.yz / ad.x; face = sign(d.x); }
  else if (ad.y > ad.z)           { p = d.xz / ad.y; face = 3.0 + sign(d.y); }
  else                            { p = d.xy / ad.z; face = 6.0 + sign(d.z); }
  p += face * 0.37;
  float s = starLayer(p, 70.0, 0.035, 1.0 + face)
          + starLayer(p, 130.0, 0.05, 19.0 + face) * 0.7
          + starLayer(p, 230.0, 0.07, 41.0 + face) * 0.45;
  // faint nebular dust so space is not flat black
  float n = fbm4(d * 2.3 + vec3(4.0, 1.0, 0.0));
  float m = fbm4(d * 6.5 - n * 1.5);
  float neb = smoothstep(0.42, 0.85, n) * (0.35 + 0.65 * m);
  float lane = smoothstep(0.55, 0.75, fbm4(d * 4.0 + 9.0));
  return vec3(s + 0.07 * neb * (1.0 - 0.6 * lane) + 0.006);
}

// ---------------------------------------------------------------- accretion disk
float diskProfile(float r) {
  float inner = smoothstep(R_IN - 0.05, R_IN + 0.35, r);
  float outer = 1.0 - smoothstep(4.0, R_OUT, r);
  return inner * outer * pow(R_IN / r, 1.6);
}

// Texture of the disk at a given rotation phase.
float diskTex(float a, float r, float t, float sharp) {
  float ang = a - t * 1.6 / pow(r, 1.5);               // Keplerian shear winds features into spirals
  vec2 dir = vec2(cos(ang), sin(ang));
  float lr = log(r);

  // domain warp
  float w = fbm4(vec3(dir * 1.6, lr * 3.0 + 2.0));
  float w2 = noise(vec3(dir * 3.1 + 5.0, lr * 6.0 - 3.0));
  // turbulent body
  float body = fbm5(vec3(dir * 2.2 + w * 1.2, r * 1.6 + w2 * 1.8));
  // fine concentric filaments: high radial, low angular frequency
  float fr = r * 8.0 + w * 4.0 + w2 * 2.0;
  float fil = noise(vec3(dir * 2.5, fr)) * 0.62 + noise(vec3(dir * 3.5 + 3.0, fr * 1.9)) * 0.38 * sharp;
  fil = mix(0.55, pow(fil, 2.2) * 2.4, 0.35 + 0.65 * sharp);
  // dark dust lanes
  float dust = smoothstep(0.52, 0.72, fbm4(vec3(dir * 2.6 - 4.0, r * 2.4 + w * 2.5)));
  // bright clumps
  float clump = smoothstep(0.55, 0.85, body);

  float tex = (0.3 + 0.95 * body) * (0.45 + 0.75 * fil);
  tex *= 1.0 - 0.65 * dust;
  tex += 0.9 * clump * fil;
  return pow(tex, 1.25);
}

vec4 disk(vec3 q, float r, vec3 rayDir) {
  float sharp = smoothstep(0.03, 0.22, abs(rayDir.y)) * uDetail;   // fade fine detail where foreshortened or under-sampled
  float a = atan(q.z, q.x);
  // Two texture phases cross-faded so the differential-rotation shear stays bounded forever.
  const float PERIOD = 24.0;
  // Phase A restarts at ph = 0 (hidden then), phase B at ph = 0.5 (hidden then); only one is evaluated
  // outside the short cross-fades.
  float ph = fract(uTime / PERIOD);
  float wB = smoothstep(0.2, 0.3, abs(ph - 0.5));
  float tex;
  if (wB < 0.001) tex = diskTex(a, r, ph * PERIOD + 6.0, sharp);
  else if (wB > 0.999) tex = diskTex(a + 2.1, r, fract(ph + 0.5) * PERIOD + 6.0, sharp);
  else tex = mix(diskTex(a, r, ph * PERIOD + 6.0, sharp), diskTex(a + 2.1, r, fract(ph + 0.5) * PERIOD + 6.0, sharp), wB);
  float dust = 0.0;

  // Doppler beaming: the approaching side is clearly brighter
  vec3 tang = normalize(vec3(-q.z, 0.0, q.x));
  float g = 1.0 + 0.42 * dot(tang, -rayDir);
  float beam = g * g * g;

  float prof = diskProfile(r);
  float hot = smoothstep(R_IN + 0.9, R_IN, r) * smoothstep(R_IN - 0.05, R_IN + 0.15, r); // hot inner rim
  float I = prof * tex * beam * (1.5 + 0.55 * uEnergy) + hot * 1.6 * beam * (1.0 + 0.5 * uEnergy);
  float alpha = clamp(prof * (0.55 + 0.6 * tex) * 1.2, 0.0, 0.97) * (1.0 - 0.35 * dust);
  return vec4(vec3(I), alpha);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  uv -= uCenter;
  float roll = -0.2;
  uv = mat2(cos(roll), sin(roll), -sin(roll), cos(roll)) * uv;

  float pitch = 0.085 + uLook.y * 0.02;
  float yaw = uTime * 0.01 + uLook.x * 0.045;
  mat3 cam = rotY(yaw) * rotX(pitch);
  vec3 ro = cam * vec3(0.0, 0.0, -uDist);
  vec3 rd = cam * normalize(vec3(uv, uZoom));

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  vec3 p = ro;
  vec3 v = rd;
  bool captured = false;
  float haze = 0.0;
  float nCross = 0.0;

  float b = length(cross(ro, rd));                    // impact parameter (conserved)
  if (b < R_OUT * 1.45) {
    for (int i = 0; i < 200; i++) {
      float r = length(p);
      if (r < 1.0) { captured = true; break; }
      vec3 h = cross(p, v);
      float h2 = dot(h, h);
      float dt = clamp(0.08 * r, 0.03, 1.2);
      vec3 prev = p;
      v += -1.5 * h2 * p / (r * r * r * r * r) * dt;
      p += v * dt;

      // soft volumetric glow / wispy material around the disk plane
      float rr = length(p.xz);
      float thick = 0.18 + 0.06 * rr;
      float hz = exp(-abs(p.y) / thick) * smoothstep(R_IN - 0.7, R_IN + 0.6, rr) * pow(R_IN / max(rr, R_IN), 1.5)
               * (1.0 - smoothstep(8.0, R_OUT * 1.4, rr));
      haze += hz * dt * (1.0 - alpha);

      if (prev.y * p.y < 0.0) {
        vec3 q = mix(prev, p, prev.y / (prev.y - p.y));
        float dr = length(q.xz);
        if (dr > R_IN - 0.1 && dr < R_OUT) {
          vec4 d = disk(q, dr, normalize(v));
          d.a *= nCross < 0.5 ? 1.0 : smoothstep(0.004, 0.03, b - B_CRIT);   // hide noisy near-critical windings
          col += (1.0 - alpha) * d.rgb * d.a;
          alpha += (1.0 - alpha) * d.a;
          if (alpha > 0.985) break;
        }
        nCross += 1.0;
      }
      if (r > uDist + 4.0 && dot(p, v) > 0.0) break;
    }
  }

  // photon rings: crisp primary just outside the critical impact parameter, fainter higher-order inside it
  float db = b - B_CRIT;
  vec2 sp = uv;  // screen-space azimuth for asymmetry/texture
  float az = atan(sp.y, sp.x);
  float side = 0.6 + 0.4 * cos(az - 3.14159);         // approaching (left) side brighter
  float rtex = 0.7 + 0.6 * noise(vec3(cos(az) * 6.0, sin(az) * 6.0, uTime * 0.3));
  float ring = exp(-pow((db - 0.03) / 0.022, 2.0)) * 2.2 + exp(-pow((db - 0.085) / 0.012, 2.0)) * 0.55;
  ring *= side * rtex;
  float halo = exp(-max(db, 0.0) * 2.2) * step(0.0, db) * 0.12;

  float vis = smoothstep(0.0, 0.02, db);
  if (db > 0.03) captured = false;                    // the integrator is coarse near the photon sphere
  // full lensing of the sky near the hole; fade it out further away so stars are not smeared into streaks
  // full lensing of the sky near the hole; further out cross-fade (in brightness, not direction, to avoid caustics)
  // to the unlensed sky so stars are not smeared into streaks
  if (!captured) {
    float lw = smoothstep(3.4, 6.5, b);
    vec3 sky = lw < 0.999 ? background(normalize(v)) : vec3(0.0);
    if (lw > 0.001) sky = mix(sky, background(rd), lw);
    col += (1.0 - alpha) * sky * vis;
  }
  float hazeLum = haze * (0.05 + 0.035 * uEnergy);
  col += vec3(hazeLum);
  col += (1.0 - alpha * 0.85) * vec3(ring * (1.0 + 0.4 * uEnergy) + halo);

  // filmic tone map. R: display value, G: linear scene luminance / 5 (feeds bloom + halation in the post chain)
  col = col * 1.15;
  float hdr = dot(col, vec3(0.299, 0.587, 0.114));
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  float lum = clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);
  gl_FragColor = vec4(lum, clamp(hdr * 0.2, 0.0, 1.0), 0.0, 1.0);
}`;

  // ---------------------------------------------------------------- post-processing (all WebGL1 / GLSL ES 1.00)
  // The scene is traced into an RGBA8 texture (R = tone-mapped value, G = linear luminance / 5). A dual-filter
  // pyramid (1/2 .. 1/32) then carries three things at once, since the image is monochrome:
  //   R: the image itself, blurred wide (rain fog), G: thresholded highlights (bloom/halation),
  //   B: brightest highlights spread horizontally only (a faint anamorphic streak).
  const PVERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const PHEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
`;

  // Downsample: 5-tap dual-filter for R/G, 4 horizontal taps for B. On the first level it also extracts highlights.
  const DOWN = PHEAD + `
uniform sampler2D uSrc;
uniform vec2 uTexel;      // source texel
uniform float uFirst;
vec3 fetch(vec2 uv) {
  vec3 c = texture2D(uSrc, uv).rgb;
  if (uFirst > 0.5) {
    float hdr = c.g * 5.0;
    // soft-knee threshold: the disk body glows a little, the inner rim and photon ring a lot
    float q = clamp(hdr - 0.45, 0.0, 0.7);
    float b = max(q * q / 1.4, hdr - 0.8);
    float s = max(hdr - 1.7, 0.0);
    c = vec3(c.r, b * 0.25, s * 0.25);
  }
  return c;
}
void main() {
  vec2 d = uTexel;
  vec3 c = fetch(vUv);
  vec3 a = fetch(vUv + vec2(-d.x, -d.y)) + fetch(vUv + vec2(d.x, -d.y)) + fetch(vUv + vec2(-d.x, d.y)) + fetch(vUv + vec2(d.x, d.y));
  vec2 rg = (c.rg * 4.0 + a.rg) / 8.0;
  float bh = (fetch(vUv + vec2(-2.5 * d.x, 0.0)).b + fetch(vUv + vec2(2.5 * d.x, 0.0)).b) * 0.3 + a.b * 0.1;
  gl_FragColor = vec4(rg, bh, 1.0);
}`;

  // Upsample: 9-tap tent of the coarser level combined with this level.
  const UP = PHEAD + `
uniform sampler2D uLow;
uniform sampler2D uCur;
uniform vec2 uLowTexel;
uniform float uMixR;      // R: energy-preserving blend towards the wider blur
uniform float uStreak;    // B: how much of the coarser streak carries up
void main() {
  vec2 d = uLowTexel;
  vec3 t = texture2D(uLow, vUv).rgb * 4.0
    + (texture2D(uLow, vUv + vec2(d.x, 0.0)).rgb + texture2D(uLow, vUv - vec2(d.x, 0.0)).rgb
     + texture2D(uLow, vUv + vec2(0.0, d.y)).rgb + texture2D(uLow, vUv - vec2(0.0, d.y)).rgb) * 2.0
    + texture2D(uLow, vUv + d).rgb + texture2D(uLow, vUv - d).rgb
    + texture2D(uLow, vUv + vec2(d.x, -d.y)).rgb + texture2D(uLow, vUv + vec2(-d.x, d.y)).rgb;
  t /= 16.0;
  float sb = (texture2D(uLow, vUv + vec2(-2.0 * d.x, 0.0)).b + texture2D(uLow, vUv + vec2(2.0 * d.x, 0.0)).b) * 0.5;
  vec3 c = texture2D(uCur, vUv).rgb;
  gl_FragColor = vec4(mix(c.r, t.r, uMixR), c.g + t.g, c.b + (t.b * 0.5 + sb * 0.5) * uStreak, 1.0);
}`;

  // Composite to the canvas: lens softness, bloom/halation, streak, rain fog, vignette, film grain.
  const COMP = PHEAD + `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform vec2 uTexel;
uniform vec2 uFocus;      // black-hole centre in pixels: the sharpest point
uniform float uSoft;      // base softness radius in pixels
uniform float uRain;
uniform float uSeed;
uniform float uGrain;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = vUv;
  float e = smoothstep(0.12, 0.95, length(gl_FragCoord.xy - uFocus) / uRes.y);
  vec2 o = mix(0.75, 1.35, e) * uSoft * uTexel;
  float v = texture2D(uScene, uv).r * 0.4
    + (texture2D(uScene, uv + vec2(o.x, o.y)).r + texture2D(uScene, uv + vec2(-o.x, -o.y)).r
     + texture2D(uScene, uv + vec2(o.x, -o.y)).r + texture2D(uScene, uv + vec2(-o.x, o.y)).r) * 0.15;

  vec3 B = texture2D(uBloom, uv).rgb;
  float rain = uRain;
  // condensation: most of the image comes from the wide blur, blacks lift, contrast drops
  v = mix(v, B.r, rain * 0.9);
  float glow = B.g * 4.0 / 5.0 * (0.7 + 0.9 * rain) + B.b * 4.0 * 0.045 * (1.0 - 0.5 * rain);
  v = 1.0 - (1.0 - v) * exp(-glow);
  v = mix(v, 0.07 + v * 0.78, rain);

  vec2 sv = gl_FragCoord.xy / uRes - 0.5;
  v *= 1.0 - 0.38 * dot(sv, sv);

  // film grain: fine, luminance-only, strongest in the mid-tones, re-seeded every frame
  vec2 fc = floor(gl_FragCoord.xy);
  float n = hash(fc + uSeed) + hash(fc * 1.37 + uSeed * 1.71 + 19.1) - 1.0;
  float amp = uGrain * (0.25 + 1.6 * sqrt(max(v, 0.0)) * (1.0 - v));
  v = clamp(v + n * amp, 0.0, 1.0);
  gl_FragColor = vec4(vec3(v) * vec3(0.985, 0.99, 1.0), 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log);
    }
    return s;
  }

  function program(gl, vs, fs, names) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    names.forEach((n) => { u[n] = gl.getUniformLocation(p, n); });
    return { p, u };
  }

  const noop = { frame() {}, setEnergy() {}, setLook() {}, setRain() {}, stats() { return null; }, ok: false };
  const LEVELS = 5;   // pyramid 1/2 .. 1/32

  // opts.scale: fixed render scale (disables adaptive resolution), used to render stills.
  function create(canvas, opts = {}) {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    // preserveDrawingBuffer stays false: the rain overlay reads this canvas in the same task as frame().
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) { canvas.classList.add('fallback'); return noop; }

    let G = null;        // GL resources, rebuilt after a context loss
    let lost = false;

    function init() {
      const scene = program(gl, VERT, FRAG, ['uRes', 'uTime', 'uEnergy', 'uLook', 'uCenter', 'uZoom', 'uDist', 'uDetail']);
      const down = program(gl, PVERT, DOWN, ['uSrc', 'uTexel', 'uFirst']);
      const up = program(gl, PVERT, UP, ['uLow', 'uCur', 'uLowTexel', 'uMixR', 'uStreak']);
      const comp = program(gl, PVERT, COMP, ['uScene', 'uBloom', 'uRes', 'uTexel', 'uFocus', 'uSoft', 'uRain', 'uSeed', 'uGrain']);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      G = { scene, down, up, comp, targets: null, tw: 0, th: 0 };
    }

    function target(tw, th) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w: tw, h: th };
    }

    // (Re)allocate the scene and pyramid render targets for the current canvas size.
    function alloc() {
      if (!G || (G.tw === w && G.th === h && G.targets)) return;
      if (G.targets) {
        const all = [G.targets.scene].concat(G.targets.down, G.targets.up);
        all.forEach((t) => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); });
      }
      const T = { scene: target(w, h), down: [], up: [] };
      for (let i = 0; i < LEVELS; i++) T.down.push(target(Math.max(1, Math.ceil(w / (2 << i))), Math.max(1, Math.ceil(h / (2 << i)))));
      for (let i = 0; i < LEVELS - 1; i++) T.up.push(target(T.down[i].w, T.down[i].h));
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) throw new Error('render target incomplete');
      G.targets = T; G.tw = w; G.th = h;
    }

    try { init(); } catch (err) {
      console.warn('[space] shader failed, using CSS fallback', err);
      canvas.classList.add('fallback');
      return noop;
    }

    // Render below native resolution and let CSS upscale; adapt to the GPU.
    // Up to native resolution (capped at 1.5 device px per CSS px), never below 45%: when even that is
    // too slow we drop frames instead, which is far less visible than a blocky, aliased disk.
    const maxScale = Math.min(window.devicePixelRatio || 1, 1.5);
    const MIN_SCALE = 0.45;
    let scale = opts.scale || Math.min(maxScale, 0.75);
    let w = 0, h = 0;
    const resize = () => {
      w = Math.max(2, Math.round(innerWidth * scale));
      h = Math.max(2, Math.round(innerHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (!lost) {
        try { alloc(); } catch (err) { console.warn('[space] render targets failed', err); }
      }
    };
    resize();
    addEventListener('resize', resize);

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; G = null; });
    canvas.addEventListener('webglcontextrestored', () => {
      try { init(); lost = false; resize(); } catch (err) { console.warn('[space] context restore failed', err); }
    });

    let energy = 0;
    let rain = 0, rainTarget = 0;
    const look = { x: 0, y: 0, tx: 0, ty: 0 };
    const t0 = performance.now();
    let last = t0;
    let lastPost = t0;
    let samples = [];
    let adjustments = 0;
    let firstFrame = true;
    let skip = 1;      // render every Nth frame when even the lowest scale is too slow
    let slowRuns = 0, fastRuns = 0;
    let refresh = 1000;          // estimated display frame interval (ms)
    let ceiling = Infinity;      // lowest scale that proved too slow
    let frameNo = 0;
    let hole = { x: 0, y: 0 };   // black-hole centre in pixels, for the lens focus

    function bindTarget(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
      gl.viewport(0, 0, t ? t.w : w, t ? t.h : h);
    }

    // Pyramid + composite. Runs every frame (also when the trace is skipped), so the canvas always
    // holds a fresh image for anything that samples it right after frame().
    function post(now, traced) {
      const T = G.targets;
      const dts = Math.min(0.1, Math.max(0, (now - lastPost) / 1000));
      lastPost = now;
      rain += (rainTarget - rain) * (1 - Math.exp(-dts / 0.33));    // ~95% after 1 s
      if (Math.abs(rainTarget - rain) < 0.002) rain = rainTarget;

      if (traced) {
        gl.useProgram(G.down.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(G.down.u.uSrc, 0);
        let src = T.scene;
        for (let i = 0; i < LEVELS; i++) {
          bindTarget(T.down[i]);
          gl.bindTexture(gl.TEXTURE_2D, src.tex);
          gl.uniform2f(G.down.u.uTexel, 1 / src.w, 1 / src.h);
          gl.uniform1f(G.down.u.uFirst, i === 0 ? 1 : 0);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          src = T.down[i];
        }
        gl.useProgram(G.up.p);
        gl.uniform1i(G.up.u.uLow, 0);
        gl.uniform1i(G.up.u.uCur, 1);
        gl.uniform1f(G.up.u.uMixR, 0.5 + 0.22 * rain);   // rain: weight the wider levels
        gl.uniform1f(G.up.u.uStreak, 0.85);
        for (let i = LEVELS - 2; i >= 0; i--) {
          const low = i === LEVELS - 2 ? T.down[LEVELS - 1] : T.up[i + 1];
          bindTarget(T.up[i]);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, low.tex);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.down[i].tex);
          gl.uniform2f(G.up.u.uLowTexel, 1 / low.w, 1 / low.h);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
      }

      bindTarget(null);
      gl.useProgram(G.comp.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.scene.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.up[0].tex);
      gl.uniform1i(G.comp.u.uScene, 0);
      gl.uniform1i(G.comp.u.uBloom, 1);
      gl.uniform2f(G.comp.u.uRes, w, h);
      gl.uniform2f(G.comp.u.uTexel, 1 / w, 1 / h);
      gl.uniform2f(G.comp.u.uFocus, hole.x, hole.y);
      gl.uniform1f(G.comp.u.uSoft, Math.max(0.6, h / 820));
      gl.uniform1f(G.comp.u.uRain, rain);
      gl.uniform1f(G.comp.u.uSeed, (frameNo * 7.31) % 997);
      gl.uniform1f(G.comp.u.uGrain, 0.022);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    }

    function frame(now) {
      if (lost || !G || !G.targets) return;
      if (++frameNo % skip !== 0) { post(now, false); return; }
      const dt = (now - last) / skip;
      last = now;

      // Adaptive quality with hysteresis. Windows containing a hitch (tab switch, GC, file import) or a
      // hidden page are discarded, so one stall can't strand the renderer at low resolution.
      if (!firstFrame && !opts.scale) {
        if (dt > 120 || document.hidden) { samples = []; }
        else {
          samples.push(dt);
          if (samples.length >= 30) {
            samples.sort((a, b) => a - b);
            const med = samples[15];
            const floor = samples[2];
            samples = [];
            // Frame time is capped by vsync, so judge it against the display's own refresh interval.
            refresh = Math.min(refresh * 1.02, floor);   // slowly-forgetting minimum frame interval
            // ...but a consistently slow GPU also looks "steady", so keep absolute bounds as well:
            // under ~40 fps is always slow, and "fast" requires keeping up with a 60 Hz-class display.
            const slow = med > refresh * 1.35 || med > 25;
            const fast = med < refresh * 1.12 && med < 18.5;
            slowRuns = slow ? slowRuns + 1 : 0;
            fastRuns = fast ? fastRuns + 1 : 0;
            if (slowRuns >= 2) {
              slowRuns = 0;
              if (scale > MIN_SCALE + 0.001) { ceiling = scale; scale = Math.max(MIN_SCALE, scale * 0.85); resize(); adjustments++; }
              else if (skip < 3) skip++;
            } else if (fastRuns >= 2) {
              fastRuns = 0;
              if (skip > 1) skip--;
              else if (scale * 1.12 < ceiling - 0.001 && scale < maxScale - 0.001) { scale = Math.min(maxScale, scale * 1.12); resize(); adjustments++; }
            }
          }
        }
      }
      if (!G.targets || G.tw !== w || G.th !== h) return;

      look.x += (look.tx - look.x) * 0.03;
      look.y += (look.ty - look.y) * 0.03;

      const aspect = w / h;
      let cx, cy, zoom, dist;
      if (aspect > 1.15) { cx = aspect * 0.5 * 0.6; cy = 0.03; zoom = 3.0; dist = 26.0; }
      else { cx = 0.0; cy = 0.27; zoom = 1.45; dist = 38.0; }
      hole = { x: w * 0.5 + cx * h, y: h * 0.5 + cy * h };

      const t = (now - t0) / 1000 * (reduced ? 0.25 : 1);
      const su = G.scene.u;
      bindTarget(G.targets.scene);
      gl.useProgram(G.scene.p);
      gl.uniform2f(su.uRes, w, h);
      gl.uniform1f(su.uTime, t + 40.0);
      gl.uniform1f(su.uEnergy, energy);
      gl.uniform2f(su.uLook, look.x, look.y);
      gl.uniform2f(su.uCenter, cx, cy);
      gl.uniform1f(su.uZoom, zoom);
      gl.uniform1f(su.uDist, dist);
      gl.uniform1f(su.uDetail, Math.min(1, Math.max(0.35, (h - 380) / 520)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      post(now, true);

      if (firstFrame) { firstFrame = false; canvas.classList.add('ready'); }
    }

    return {
      ok: true,
      frame,
      setEnergy(e) { energy = e; },
      setLook(x, y) { look.tx = x; look.ty = y; },
      setRain(level) { rainTarget = Math.min(1, Math.max(0, +level || 0)); },
      stats() { return { scale: +scale.toFixed(3), skip, w, h, adjustments, refresh: +refresh.toFixed(1), ceiling: isFinite(ceiling) ? +ceiling.toFixed(3) : null, rain: +rain.toFixed(3), lost }; },
    };
  }

  return { create };
})();
