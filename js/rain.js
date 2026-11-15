/* Event Horizon: rain on the glass.
   A transparent WebGL overlay of water drops stuck on a window pane in front of the scene. Each drop is a small
   lens: it shows the black-hole canvas (#space) behind it inverted and minified, with a dark refractive rim, a
   specular glint from a soft top light and a faint shadow below. Small beads and medium drops form, sit and
   evaporate; a few heavy drops slide down in stick-slip steps, wiping the beads in their path and leaving a trail
   of tiny droplets that evaporate behind them. Over DOM glass (the card, the dock) the scene texture is wrong, so
   there the refraction fades out and the drop is drawn with rim, glint and a slight darkening only.
   API: Rain.create(canvas, sourceCanvas, {masks: [elements]}) -> {ok, frame(now), setEnabled(bool), enabled, stats()}.
   frame(now) must run right after the source canvas has been drawn, in the same task (its drawing buffer is only
   readable until it is composited). */
window.Rain = (() => {
  'use strict';

  const VERT = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';

  const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;     // latest snapshot of the scene
uniform sampler2D uTexPrev; // the one before (cross-faded when snapshots are throttled)
uniform float uTexMix;
uniform vec2 uRes;       // render pixels
uniform float uPx;       // render pixels per CSS pixel
uniform float uTime;
uniform float uAmount;   // 0..1 fade
uniform float uK;        // drop size factor (viewport)
uniform vec4 uMask0;     // DOM glass rects in CSS px, y up: x0, y0, x1, y1
uniform vec4 uMask1;
uniform vec2 uMaskR;     // corner radii
uniform float uFog;      // how much the scene canvas is fogged by its own rain mode (0..1)

// Closest drop (by water thickness) covering this pixel.
float bH; vec2 bQ; float bR; vec2 bC;
float shade;             // shadow from drops just above
float streak;            // glass wiped clear by a sliding drop

vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

void consider(vec2 p, vec2 c, vec2 rad, float r, float wob, vec3 irr) {
  vec2 q = (p - c) / rad;
  // Irregular outline: low angular harmonics (cos/sin 2θ, cos 3θ) without atan.
  float l2 = max(dot(q, q), 1e-4);
  q *= 1.0 + (irr.x * (q.x * q.x - q.y * q.y) + irr.y * 2.0 * q.x * q.y) / l2 + irr.z * q.x * (4.0 * q.x * q.x - 3.0 * l2) / (l2 * sqrt(l2));
  // Heavier at the bottom, a little narrower at the top (y is up).
  q.x *= 1.0 + 0.16 * wob * q.y;
  float d2 = dot(q, q);
  float h = (1.0 - d2) * r;
  if (h > bH) { bH = h; bQ = q; bR = r; bC = c; }
  // Shadow cast a little below the drop.
  vec2 qs = (p + vec2(0.0, r * 0.45) - c) / (rad * 1.06);
  shade = max(shade, (1.0 - smoothstep(0.55, 1.0, length(qs))) * clamp(r / 9.0, 0.25, 1.0));
}

// ---- Sliding drops: one column per cell, a heavy drop that slips down in steps.
const float CW = 118.0;    // column width (CSS px)
const float CH = 1000.0;   // column period (CSS px)

// x of the path in column-local units (0..1), as a function of local y (CSS px), so the trail follows the drop.
float pathX(float ly, vec3 h) {
  // Mostly straight, with small jogs where the drop met a bead or a speck on the glass.
  float jog = sin(ly * 0.047 + h.y * 6.28) * sin(ly * 0.0131 + h.z * 9.0);
  return 0.5 + 0.07 * sin(ly * 0.006 + h.x * 6.28) + 0.06 * jog * abs(jog) + 0.015 * sin(ly * 0.13 + h.x * 17.0);
}

// Drop state for a column cell: returns (drop y local px, radius, active), and its hashes in h.
vec3 slider(vec2 id, out vec3 h, out vec3 g) {
  h = hash32(id * vec2(1.0, 7.31) + 11.7);
  float speed = (0.022 + 0.03 * h.z);
  float ph = uTime * speed + h.x * 3.0;
  float cyc = floor(ph);
  float f = fract(ph);
  g = hash32(id + vec2(cyc * 13.17, cyc * 3.71) + 4.1);
  float active = step(g.z, 0.72);
  // Stick-slip: rest, then slide.
  float N = 5.0 + floor(g.y * 4.0);
  float s = f * N;
  float m = (floor(s) + smoothstep(0.35, 1.0, fract(s))) / N;
  float y = (0.94 - 1.0 * m) * CH;
  float r = mix(7.0, 14.0, g.x) * uK;
  // Grow at the start (a bead getting heavy), lose water to the trail and evaporate at the end.
  r *= smoothstep(0.0, 0.07, f) * (1.0 - 0.25 * m) * (1.0 - smoothstep(0.88, 1.0, f));
  return vec3(y, r, active);
}

float columnOffset(float ix) { return hash32(vec2(ix, 91.3)).x * CH; }

// How strongly a sliding drop has just wiped the glass at point c (0..1).
float wipeAt(vec2 c) {
  float ix = floor(c.x / CW);
  float off = columnOffset(ix);
  float iy = floor((c.y + off) / CH);
  vec3 h, g;
  vec3 d = slider(vec2(ix, iy), h, g);
  if (d.z < 0.5 || d.y < 0.5) return 0.0;
  float ly = c.y + off - iy * CH;
  float px = (ix + pathX(ly, h)) * CW;
  float above = ly - d.x;
  float w = 1.0 - smoothstep(d.y * 0.7, d.y * 1.4, abs(c.x - px));
  return w * step(-d.y, above) * (1.0 - smoothstep(0.0, 320.0 * uK, above));
}

void sliding(vec2 p) {
  float ix = floor(p.x / CW);
  float off = columnOffset(ix);
  float iy = floor((p.y + off) / CH);
  vec3 h, g;
  vec3 d = slider(vec2(ix, iy), h, g);
  if (d.z < 0.5) return;
  float ly = p.y + off - iy * CH;
  float base = iy * CH - off;
  float r = d.y;
  if (r > 0.3) {
    float cx = (ix + pathX(d.x, h)) * CW;
    consider(p, vec2(cx, base + d.x), vec2(r * 0.92, r * 1.12), r, 1.0, vec3(0.03 * (h.y - 0.5), 0.05 * (h.z - 0.5), 0.0));
  }
  // The path behind it is wiped clear of condensation, which slowly forms again.
  float pathAbove = ly - d.x;
  if (pathAbove > 0.0 && d.y > 0.3) {
    float sx = (ix + pathX(ly, h)) * CW;
    float wdt = mix(7.0, 14.0, g.x) * uK * 0.55 * (0.8 + 0.3 * sin(ly * 0.061 + h.z * 40.0) * sin(ly * 0.023 + h.x * 13.0));
    streak = (1.0 - smoothstep(wdt * 0.5, wdt, abs(p.x - sx))) * (1.0 - smoothstep(0.0, 420.0 * uK, pathAbove))
           * (1.0 - smoothstep(0.86, 0.95, ly / CH));
  }
  // Trail: droplets left on the path, smaller and fewer the older they are.
  float TS = 8.0 * uK;
  float k = floor(ly / TS);
  vec3 t = hash32(vec2(ix * 3.1 + k, iy * 5.7 + g.x * 31.0));
  float ty = (k + 0.5) * TS + (t.y - 0.5) * TS * 0.3;
  float above = ty - d.x;
  if (above > r * 0.9 && t.z < 0.7) {
    float age = above / (260.0 * uK);
    float tr = mix(1.0, 3.0, t.x * t.x) * uK * (1.0 - smoothstep(0.15, 1.0, age));
    if (tr > 0.25) {
      float tx = (ix + pathX(ty, h)) * CW + (t.z - 0.35) * 4.0 * uK;
      consider(p, vec2(tx, base + ty), vec2(tr), tr, 0.0, vec3(0.0));
    }
  }
}

// ---- Static drops: one per grid cell, forming, sitting and evaporating.
void beads(vec2 p, float cell, float minR, float maxR, float density, float period, float seed) {
  vec2 id = floor(p / cell);
  vec3 h = hash32(id + seed);
  float life = period * (0.6 + 0.8 * h.z);
  float ph = uTime / life + h.x;
  float cyc = floor(ph);
  float f = fract(ph);
  vec3 g = hash32(id * 1.37 + vec2(cyc * 17.13, seed));
  if (g.z > density) return;
  vec3 g2 = hash32(id * 2.11 + vec2(seed, cyc * 5.3));
  float rMax = mix(minR, maxR, g.x * g.x * g.x) * uK;
  float r = rMax * smoothstep(0.0, 0.05, f) * sqrt(1.0 - smoothstep(0.45, 1.0, f));
  vec2 c = id * cell + rMax * 1.15 + (cell - 2.3 * rMax) * g2.xy;
  r *= 1.0 - wipeAt(c);
  if (r < 0.3) return;
  // Slightly irregular, oval beads.
  vec2 rad = r * vec2(1.0 + 0.16 * (g2.z - 0.5), 1.0 - 0.12 * (g2.z - 0.5));
  float irr = smoothstep(4.0, 16.0, r) * 0.09;
  vec3 hi = hash32(id * 3.7 + vec2(cyc, seed * 0.37)) - 0.5;
  consider(p, c, rad, r, 0.35 * g.y, hi * irr * vec3(1.0, 1.0, 0.6));
}

vec3 scene(vec2 uv) {
  return mix(texture2D(uTexPrev, uv).rgb, texture2D(uTex, uv).rgb, uTexMix);
}

float roundRect(vec2 p, vec4 r, float rad) {
  vec2 c = (r.xy + r.zw) * 0.5;
  vec2 b = (r.zw - r.xy) * 0.5 - rad;
  vec2 d = abs(p - c) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rad;
}

void main() {
  vec2 p = gl_FragCoord.xy / uPx;            // CSS px, y up
  bH = 0.0; shade = 0.0; streak = 0.0;
  bQ = vec2(2.0); bR = 0.0; bC = vec2(0.0);

  beads(p, 12.0, 0.6, 2.4, 0.6, 26.0, 1.0);
  beads(p + vec2(7.3, 3.1), 23.0, 0.8, 4.2, 0.6, 34.0, 17.0);
  beads(p + vec2(19.0, 41.0), 47.0, 2.0, 8.5, 0.55, 48.0, 43.0);
  beads(p + vec2(53.0, 11.0), 92.0, 4.5, 15.0, 0.4, 70.0, 77.0);
  beads(p + vec2(31.0, 67.0), 170.0, 9.0, 24.0, 0.22, 90.0, 131.0);
  sliding(p);

  float onGlass = max(1.0 - smoothstep(-8.0, 8.0, roundRect(p, uMask0, uMaskR.x)),
                      1.0 - smoothstep(-6.0, 6.0, roundRect(p, uMask1, uMaskR.y)));

  float dist = length(bQ);
  float rpx = max(bR * uPx, 0.01);
  float cov = smoothstep(0.0, min(1.0, 1.4 / rpx), 1.0 - dist);
  float shadowA = shade * (1.0 - cov) * 0.16 * (1.0 - 0.5 * onGlass);

  vec4 o = vec4(0.0);
  vec2 uv0 = gl_FragCoord.xy / uRes;
  if (streak > 0.0 && cov < 1.0 && uFog > 0.0) {
    // Clear glass: the scene without the haze the fog adds (the blur stays, but the contrast comes back).
    float Ls = dot(scene(uv0), vec3(0.299, 0.587, 0.114));
    Ls = clamp((Ls - 0.07) / 0.78, 0.0, 1.0);
    float a = streak * uFog * 0.7 * (1.0 - cov) * (1.0 - onGlass);
    o = vec4(vec3(Ls) * a, a);
  }
  if (cov > 0.0) {
    float d2 = dist * dist;
    vec2 uv = gl_FragCoord.xy / uRes;
    // Lens: the scene behind appears inverted and minified, more strongly towards the rim.
    vec2 src = bC - bQ * bR * (1.5 + 1.3 * d2) + vec2(0.0, bR * 0.3);
    vec2 suv = clamp(src * uPx / uRes, vec2(0.002), vec2(0.998));
    float L = dot(scene(suv), vec3(0.299, 0.587, 0.114));
    // Drops look through the condensation: a little clearer and more contrasty than the glass around them.
    L = mix(L, clamp((L - 0.07) / 0.78, 0.0, 1.0), uFog);
    L = pow(clamp(L * 1.15, 0.0, 1.0), 1.1) + 0.035;
    // Same vignette as the CSS overlay below us.
    float vd = length((uv - 0.5) / vec2(1.3, 0.95));
    L *= 1.0 - 0.78 * clamp((vd - 0.52) / 0.48, 0.0, 1.0);

    float refrA = cov * (1.0 - 0.9 * onGlass);
    o = o * (1.0 - refrA) + vec4(vec3(L) * refrA, refrA);

    // Dark refractive rim (rays from the edge come from far off-axis, or are internally reflected).
    float rim = smoothstep(0.6, 1.0, dist);
    rim = rim * (0.8 - 0.15 * smoothstep(-0.6, 0.8, bQ.y));
    float darkA = cov * clamp(rim + 0.13 * onGlass, 0.0, 1.0);
    darkA *= mix(1.0, 0.75, onGlass) * clamp(rpx / 1.6, 0.35, 1.0);
    o = o * (1.0 - darkA) + vec4(0.0, 0.0, 0.0, darkA);

    // Light from a soft top source focused into a crescent on the lower inner edge.
    float caustic = smoothstep(0.5, 0.82, dist) * (1.0 - smoothstep(0.82, 0.98, dist)) * smoothstep(0.1, -0.85, bQ.y / max(dist, 0.001));
    // Small glint near the top.
    vec2 gq = bQ - vec2(-0.22, 0.48);
    float sk = 38.0 * clamp(bR / 5.0, 1.0, 3.5);
    float spec = exp(-dot(gq, gq) * sk) * 0.95 + exp(-dot(gq, gq) * 6.0) * 0.05;
    float lightA = cov * clamp(caustic * (0.38 + 0.1 * onGlass) + spec * clamp(rpx / 3.0, 0.4, 1.0), 0.0, 1.0);
    o = o * (1.0 - lightA) + vec4(lightA, lightA, lightA, lightA);
  }
  o = o * (1.0 - shadowA) + vec4(0.0, 0.0, 0.0, shadowA);
  gl_FragColor = o * uAmount;
}
`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  }

  const FADE = 1.2;   // seconds

  function create(canvas, source, opts = {}) {
    const noop = { ok: false, enabled: false, frame() {}, setEnabled() {}, stats() { return null; } };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const masks = (opts.masks || []).slice(0, 2);
    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    } catch { gl = null; }
    if (!gl) return noop;

    let prog, u, tex, lost = false;
    function init() {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link failed');
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      u = {};
      ['uTex', 'uRes', 'uPx', 'uTime', 'uAmount', 'uK', 'uMask0', 'uMask1', 'uMaskR', 'uFog', 'uTexPrev', 'uTexMix'].forEach((n) => { u[n] = gl.getUniformLocation(prog, n); });
      tex = [0, 1].map(() => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        return { t, w: 1, h: 1 };
      });
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.uniform1i(u.uTex, 0);
      gl.uniform1i(u.uTexPrev, 1);
      cur = 0;
      bindTextures();
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
    }
    let cur = 0;
    function bindTextures() {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex[1 - cur].t);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex[cur].t);
    }
    try { init(); } catch (err) { console.warn('[rain] shader failed, rain disabled', err); return noop; }

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      try { init(); lost = false; resize(true); } catch (err) { console.warn('[rain] restore failed', err); }
    });

    // Render resolution: ~0.7 of device pixels (the drops are soft-edged lenses; this is plenty), lower when
    // the main renderer had to drop its own resolution.
    let scale = 0, w = 0, h = 0, cssW = 1, cssH = 1;
    function pickScale() {
      const dpr = window.devicePixelRatio || 1;
      let s = Math.min(1, Math.max(0.5, 0.85 * dpr));
      if (opts.quality) s *= Math.max(0.6, Math.min(1, opts.quality()));
      return Math.max(0.42, s);
    }
    function resize(force) {
      cssW = Math.max(1, innerWidth);
      cssH = Math.max(1, innerHeight);
      const s = pickScale();
      const nw = Math.max(2, Math.round(cssW * s)), nh = Math.max(2, Math.round(cssH * s));
      if (force || nw !== w || nh !== h) {
        scale = s; w = nw; h = nh;
        canvas.width = w; canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      measureMasks();
    }

    // DOM glass rectangles (CSS px, converted to y-up). getBoundingClientRect() of a 3D-tilted element is the
    // bounding box of its projection, a fair approximation of the tilted card.
    const maskRects = [[-1e4, -1e4, -1e4, -1e4], [-1e4, -1e4, -1e4, -1e4]];
    const maskRadii = [0, 0];
    function isShown(m) {
      const cs = getComputedStyle(m);
      return cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.4;
    }
    function measureMasks() {
      for (let i = 0; i < 2; i++) {
        const m = masks[i];
        const r = m && m.isConnected ? m.getBoundingClientRect() : null;
        if (!r || r.width < 1 || r.height < 1 || !isShown(m)) { maskRects[i] = [-1e4, -1e4, -1e4, -1e4]; continue; }
        maskRects[i] = [r.left, cssH - r.bottom, r.right, cssH - r.top];
        maskRadii[i] = Math.min(r.width, r.height) * 0.5 > 30 ? (i === 0 ? 24 : 18) : Math.min(r.width, r.height) * 0.5;
      }
    }
    addEventListener('resize', () => resize(false));
    addEventListener('scroll', measureMasks, { capture: true, passive: true });

    let enabled = false, amount = 0, last = -1, frameNo = 0, lastT = 0;
    // Snapshot cadence. Chromium copies a WebGL canvas into a texture on the GPU (well under 1 ms). Gecko reads
    // it back through the CPU and must first wait for the scene's frame to finish on the GPU (~10 ms measured in
    // Firefox at 1907x942 with ANGLE), so there the snapshot is throttled and the shader cross-fades between
    // the last two snapshots, which hides the lower rate inside the small, minified drop images.
    let interval = 0, uploadMs = 0, uploadSamples = 0, uploadFails = 0, lastUpload = -1e9, mix = 1;
    const tStart = performance.now();

    function upload(now) {
      if (!source || !source.width || !source.height || uploadFails > 3) return;
      const t0 = performance.now();
      const next = 1 - cur;
      const slot = tex[next];
      try {
        gl.bindTexture(gl.TEXTURE_2D, slot.t);
        if (source.width !== slot.w || source.height !== slot.h) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
          slot.w = source.width; slot.h = source.height;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
        }
      } catch (err) {
        if (++uploadFails === 1) console.warn('[rain] could not read the scene canvas', err);
        bindTextures();
        return;
      }
      cur = next;
      bindTextures();
      lastUpload = now;
      const ms = performance.now() - t0;
      uploadMs = uploadSamples ? uploadMs * 0.8 + ms * 0.2 : ms;
      // Coarse timers (resistFingerprinting rounds to whole ms or more) are fine: this is a moving average.
      if (++uploadSamples > 4) interval = uploadMs > 5 ? 100 : uploadMs > 1.5 ? 50 : 0;
    }

    function frame(now) {
      if (lost) return;
      const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const target = enabled ? 1 : 0;
      if (amount === target && !enabled) return;
      amount = target > amount ? Math.min(1, amount + dt / FADE) : Math.max(0, amount - dt / FADE);
      if (!w) resize(true);
      frameNo++;
      if (frameNo % 6 === 1) measureMasks();
      if (now - lastUpload >= interval || now < lastUpload) upload(now);
      mix = interval > 0 && uploadSamples > 1 ? Math.min(1, Math.max(0, (now - lastUpload) / interval)) : 1;

      const eased = amount * amount * (3 - 2 * amount);
      const t = reduced ? 41.0 : 30.0 + (now - tStart) / 1000;
      lastT = t;
      gl.uniform2f(u.uRes, w, h);
      gl.uniform1f(u.uPx, w / cssW);
      gl.uniform1f(u.uTime, t);
      gl.uniform1f(u.uAmount, eased);
      gl.uniform1f(u.uK, Math.max(0.8, Math.min(1.25, Math.min(cssW, cssH * 1.4) / 900)));
      gl.uniform4fv(u.uMask0, maskRects[0]);
      gl.uniform4fv(u.uMask1, maskRects[1]);
      gl.uniform2f(u.uMaskR, maskRadii[0], maskRadii[1]);
      gl.uniform1f(u.uTexMix, mix);
      gl.uniform1f(u.uFog, opts.fog ? Math.max(0, Math.min(1, +opts.fog() || 0)) : 0);
      if (amount > 0) gl.drawArrays(gl.TRIANGLES, 0, 3);
      else gl.clear(gl.COLOR_BUFFER_BIT);
      canvas.classList.toggle('on', amount > 0);
    }

    return {
      ok: true,
      frame,
      setEnabled(on) {
        enabled = !!on;
        if (enabled && !w) resize(true);
        if (enabled) measureMasks();
      },
      get enabled() { return enabled; },
      stats() { return { t: +lastT.toFixed(2), reduced, w, h, scale: +scale.toFixed(3), amount: +amount.toFixed(3), snapshotInterval: interval, uploadMs: +uploadMs.toFixed(2), masks: maskRects.map((r) => r.map(Math.round)) }; },
    };
  }

  return { create };
})();
