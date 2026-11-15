/* Event Horizon: rain.
   Two wet surfaces, each its own WebGL canvas:
   - the window (#rain, full screen, above the stage, below the queue panel, drop overlay and toasts), with the
     falling rain behind it and the drops flying in;
   - the card (#rainCard, inside .face): drops that land on the card stay on it, tilt and float with it, and creep
     down its rougher glass (more friction than the window) until they run off the bottom edge.

   Falling rain: four depth layers of motion-blurred streaks. Every column falls at its own speed and sways a
   little, and gusting wind shears the whole field. Each streak is a small falling lens: it shows the light behind
   it, shifted and brightened, so rain is bright in front of the disk and nearly invisible against black space.
   Sheets of fine mist drift through, lit only where there is light to scatter. Rain falls behind the card and dock.
   Impacts: drops never just appear. Each one flies in out of focus along the wind, hits, spreads flat, pulls back
   into a bead and throws a few spray droplets.
   On the glass (CPU simulation, CSS px, y down): drops merge with what they land on; heavy ones break loose and
   slide in stick-slip steps, steering towards water ahead of them and jogging sideways as they swallow drops,
   leaving sparse trails that dry fast. When the rain stops the glass dries.
   Rendering: drops are splatted additively into a float water field (R: thickness, G: thickness * radius);
   thresholding the sum gives metaball outlines. The field's gradient is the water surface slope: each drop refracts
   a snapshot of what is behind its glass (inverted, minified), darkens at the rim, mirrors the brightest light
   around it and focuses light into its lower edge.
   API: Rain.create(canvas, {scene, face, dock, card, quality}) -> {ok, frame(now), setEnabled(bool), enabled, stats()}.
   frame(now) must run right after the scene canvas was drawn, in the same task (its drawing buffer is only readable
   until it is composited). */
window.Rain = (() => {
  'use strict';

  const SPLAT_V = 'attribute vec2 aPos; attribute vec4 aQ; uniform vec2 uSize; varying vec4 vQ;\n' +
    'void main() { vQ = aQ; gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0); }';
  // A drop's outline is not a circle: pinned at specks on the glass, it is pulled into an irregular shape
  // (2nd and 3rd angular harmonics, amplitudes from the drop's seed, stronger for bigger drops).
  // vQ.w packs the drop's irregularity (0..15, x100) and its seed (0..100).
  const SPLAT_F = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec4 vQ;
void main() {
  vec2 q = vQ.xy;
  float irr = floor(vQ.w / 100.0) / 15.0, sd = mod(vQ.w, 100.0);
  float l2 = max(dot(q, q), 1e-4), l = sqrt(l2);
  float c = q.x / l, s = q.y / l;                         // cos θ, sin θ
  float c2 = c * c - s * s, s2 = 2.0 * s * c;
  float c3 = c * c2 - s * s2, s3 = s * c2 + c * s2;
  float c4 = c2 * c2 - s2 * s2, s4 = 2.0 * s2 * c2;
  float c5 = c * c4 - s * s4, s5 = s * c4 + c * s4;
  float amp = smoothstep(1.0, 5.0, vQ.z) * (0.08 + 0.5 * irr);
  float k = 1.0 + amp * ((fract(sd * 13.1) - 0.5) * 0.5 * c2 + (fract(sd * 7.7) - 0.5) * 0.5 * s2
                       + (fract(sd * 3.3) - 0.5) * 0.36 * c3 + (fract(sd * 5.9) - 0.5) * 0.36 * s3
                       + (fract(sd * 2.1) - 0.5) * 0.22 * c4 + (fract(sd * 9.3) - 0.5) * 0.22 * s4
                       + (fract(sd * 4.7) - 0.5) * 0.14 * c5 + (fract(sd * 6.3) - 0.5) * 0.14 * s5);
  q *= k;
  // Gravity: resting water sags, wider at the bottom (y points down here).
  q.x *= 1.0 - 0.12 * smoothstep(2.0, 8.0, vQ.z) * clamp(q.y, -1.2, 1.2);
  float f = max(0.0, 1.0 - dot(q, q) / 2.56); f *= f;
  gl_FragColor = vec4(f, f * vQ.z / 24.0, 0.0, 0.0);
}`;
  // Incoming raindrops: soft, out-of-focus streaks (vQ: along -1 tail..1 head, across, alpha).
  const FLY_F = 'precision mediump float; varying vec4 vQ;\n' +
    'void main() { float a = exp(-vQ.y * vQ.y * 4.0) * smoothstep(-1.0, 0.6, vQ.x) * (1.0 - smoothstep(0.75, 1.0, vQ.x)) * vQ.z;\n' +
    '  gl_FragColor = vec4(vec3(a * 0.95), a); }';
  const QUAD_V = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';
  const COMP_F = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uField;
uniform sampler2D uBg;      // what is behind this glass (y up)
uniform vec2 uRes;          // render px
uniform float uPx;          // render px per CSS px
uniform float uTime;
uniform float uRainA;       // falling-rain intensity 0..1 (0 on the card layer)
uniform float uWind;        // current slant: dx per unit of fall
uniform vec4 uMask0;        // card and dock, CSS px y up; rain falls behind them
uniform vec4 uMask1;
uniform vec2 uMaskR;
const float T = 0.371;      // field value at a lone drop's rim

vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash32(i).x, hash32(i + vec2(1.0, 0.0)).x, f.x), mix(hash32(i + vec2(0.0, 1.0)).x, hash32(i + 1.0).x, f.x), f.y);
}
float roundRect(vec2 p, vec4 r, float rad) {
  vec2 c = (r.xy + r.zw) * 0.5;
  vec2 b = (r.zw - r.xy) * 0.5 - rad;
  vec2 d = abs(p - c) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rad;
}
vec3 bgAt(vec2 cssP, float blur) {
  vec2 uv = clamp(cssP * uPx / uRes, vec2(0.001), vec2(0.999));
  vec2 o = vec2(blur) * uPx / uRes;
  return 0.25 * (texture2D(uBg, uv + o).rgb + texture2D(uBg, uv - o).rgb
               + texture2D(uBg, uv + vec2(o.x, -o.y)).rgb + texture2D(uBg, uv + vec2(-o.x, o.y)).rgb);
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Falling rain. Four depth layers; every column falls at its own speed, sways a little in the air, and the whole
// field is sheared by the (gusting) wind. Returns coverage in x and the signed position across the streak in y.
vec2 streaks(vec2 p) {
  vec2 best = vec2(0.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float s = 1.0 - fi * 0.24;                       // 1 near .. 0.28 far
    vec2 cell = vec2(6.0 + 15.0 * s, 170.0 + 360.0 * s);
    float qx = p.x + p.y * uWind * (0.7 + 0.3 * s);
    float cx = floor(qx / cell.x);
    vec3 hc = hash32(vec2(cx, fi * 17.0 + 3.0));
    float qy = p.y + uTime * (380.0 + 1200.0 * s) * (0.78 + 0.44 * hc.x);
    float cy = floor(qy / cell.y);
    vec3 h = hash32(vec2(cx, cy) + fi * 37.1);
    if (h.z > 0.16 + 0.12 * s) continue;
    float len = (0.22 + 0.4 * h.y) * cell.y;
    float fy = qy - cy * cell.y - h.x * (cell.y - len);
    float along = fy / len;
    if (along < 0.0 || along > 1.0) continue;
    float x0 = (0.25 + 0.5 * fract(h.x * 7.3)) * cell.x + sin(qy * 0.012 + h.y * 6.3) * 1.2 * s;
    float w = 0.35 + 1.6 * s * s;                    // near drops are wide and out of focus
    float dx = (qx - cx * cell.x) - x0;
    float a = (1.0 - smoothstep(w * 0.2, w, abs(dx))) * pow(sin(along * 3.14159), 0.7) * mix(0.5, 1.0, h.y);
    a *= (0.45 + 0.55 * s) / (0.7 + 0.5 * w);
    if (a > best.x) best = vec2(a, dx / w);
  }
  return best;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = gl_FragCoord.xy / uPx;
  vec4 o = vec4(0.0);

  if (uRainA > 0.0) {
    float behind = max(1.0 - smoothstep(-2.0, 2.0, roundRect(p, uMask0, uMaskR.x)),
                       1.0 - smoothstep(-2.0, 2.0, roundRect(p, uMask1, uMaskR.y)));
    if (behind < 1.0) {
      vec3 near = bgAt(p, 2.0);
      float glow = lum(bgAt(p, 14.0));
      // Mist: sheets of fine rain drifting down, visible only where light scatters in it.
      float m = noise(vec2(p.x * 0.006 + p.y * uWind * 0.006, p.y * 0.004 + uTime * 0.9)) * noise(vec2(p.x * 0.017, p.y * 0.011 + uTime * 2.1));
      float mist = m * glow * 0.22 * uRainA;
      // A streak is a falling lens: it shows the light behind it, shifted across and brightened, plus a sheen.
      vec2 st = streaks(p);
      float a = clamp(st.x * uRainA, 0.0, 1.0);
      vec3 seen = bgAt(p + vec2(-st.y * 3.0, 5.0), 1.0) * 1.35 + 0.05 + 0.5 * glow;
      a *= clamp(0.22 + 2.0 * max(lum(seen) - 0.05, 0.0), 0.0, 1.0);
      vec3 col = mix(near, seen, a);
      float A = clamp(a + mist, 0.0, 1.0) * (1.0 - behind);
      col = col * a + vec3(mist);
      o = vec4(col * (1.0 - behind), A);
    }
  }

  vec4 c = texture2D(uField, uv);
  // Specks and scratches on the glass pin the waterline: a ragged edge instead of a perfect curve.
  float F = c.r + ((noise(p * 0.45) - 0.5) * 0.07 + (noise(p * 1.6 + 7.0) - 0.5) * 0.045) * smoothstep(0.1, 0.3, c.r);
  if (F > T * 0.5) {
    vec2 e = 1.0 / uRes;
    vec2 g = 0.5 * vec2(texture2D(uField, uv + vec2(e.x, 0.0)).r - texture2D(uField, uv - vec2(e.x, 0.0)).r,
                        texture2D(uField, uv + vec2(0.0, e.y)).r - texture2D(uField, uv - vec2(0.0, e.y)).r);
    float mask = clamp((F - T) / max(length(g), 1e-4) + 0.5, 0.0, 1.0);
    if (mask > 0.0) {
      float lr = clamp(c.g * 24.0 / max(F, 1e-3), 0.4, 40.0);   // local drop radius, CSS px
      vec2 n = g * uPx * lr;                                     // slope, inward, ~1 at the rim
      float nl = length(n);
      if (nl > 1.3) { n *= 1.3 / nl; nl = 1.3; }
      // Lens: what is behind the glass, inverted and minified, more so towards the rim.
      vec3 col = bgAt(p + n * lr * 1.15 * (1.0 + 0.9 * nl * nl), 0.6);
      col = col * 0.92 + 0.012;
      col *= 1.0 - 0.8 * smoothstep(0.4, 1.05, nl);
      // Reflection: the rim mirrors the brightest light around it (the disk), not a fixed lamp.
      vec3 refl = bgAt(p - n * (60.0 + 6.0 * lr), 10.0);
      col += refl * smoothstep(0.55, 1.1, nl) * 0.55;
      float caustic = smoothstep(0.2, 0.85, n.y / max(nl, 1e-3)) * smoothstep(0.35, 0.8, nl) * (1.0 - smoothstep(0.85, 1.2, nl));
      col += caustic * (0.08 + 0.5 * lum(bgAt(p + vec2(0.0, 2.5 * lr), 4.0)));
      vec3 N = normalize(vec3(-n * 1.25, 1.0));
      vec3 H = normalize(normalize(vec3(-0.45, 0.7, 1.0)) + vec3(0.0, 0.0, 1.0));
      float nh = max(dot(N, H), 0.0);
      col += pow(nh, 110.0) * 0.9 + pow(nh, 14.0) * 0.04 * clamp(lr * uPx / 5.0, 0.35, 1.0);
      col = min(col, vec3(1.0));
      o = o * (1.0 - mask) + vec4(col * mask, mask);
    }
  }
  gl_FragColor = o;
}
`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  }
  function program(gl, vs, fs, attrs, unis) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    attrs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    const u = {};
    unis.forEach((n) => { u[n] = gl.getUniformLocation(p, n); });
    return { p, u };
  }

  // The size and offset of the "view": the window, or the recording frame when the body is framed.
  const framed = () => !!document.body && document.body.classList.contains('framed');
  const viewSize = () => (framed() ? [document.body.clientWidth, document.body.clientHeight] : [innerWidth, innerHeight]);

  const SLIDE = 5.2;         // CSS px radius at which a drop can start to slide
  const RATE = 1.5e-5;       // impacts per CSS px² per second at full rain
  const rnd = Math.random;

  /* ------------------------------------------------------------------ simulation */
  // fr: friction of the surface. The card's glass is rougher than the window: drops need more weight to break
  // loose, accelerate less, snag more often and creep instead of running.
  // onEdge: called for a drop that runs off the bottom edge (the card hands it to the window as a drip).
  function Sim(fr = { slide: SLIDE, start: 0.12, accel: 220, snag: 1.6, vmax: 130 }, onEdge = null) {
    let W = 1, H = 1, drops = [];
    const CELL = 32, grid = new Map();
    const key = (cx, cy) => (cx + 8) * 65536 + (cy + 8);
    function buildGrid() {
      grid.clear();
      for (const d of drops) {
        const k = key(Math.floor(d.x / CELL), Math.floor(d.y / CELL));
        const a = grid.get(k);
        if (a) a.push(d); else grid.set(k, [d]);
      }
    }
    function near(x, y, fn) {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const a = grid.get(key(cx + i, cy + j));
        if (a) for (const o of a) if (!o.dead && !o.drip) fn(o);
      }
    }
    function add(x, y, r, droplet) {
      const d = { x, y, r, v: 0, vx: 0, trail: 0, nextTrail: 4, grow: droplet ? 1 : 0, droplet, seed: rnd() * 100,
        dry: droplet ? 0.012 + 0.012 * rnd() : 0.005, sx: 0.78 + 0.44 * rnd(), rot: (rnd() - 0.5) * 0.8,
        irr: Math.min(1, Math.pow(rnd(), 1.4) * 1.1), lobes: [], dead: false };
      drops.push(d);
      return d;
    }
    function absorb(d, o, k) {
      // Merging pulls the drop towards what it swallowed: paths jog sideways.
      const a = d.r * d.r, b = o.r * o.r * k;
      d.x += (o.x - d.x) * b / (a + b) * 0.8;
      d.r = Math.sqrt(a + b);
      o.dead = true;
    }
    function land(x, y, r) {
      let merged = null;
      near(x, y, (o) => {
        if (merged || o.droplet) return;
        const dx = o.x - x, dy = o.y - y;
        if (dx * dx + dy * dy < (o.r + r) * (o.r + r) * 0.12) merged = o;
      });
      if (merged) {
        // Hitting a drop off-centre leaves a lumpy, two-lobed drop rather than a bigger circle.
        const ox = x - merged.x, oy = y - merged.y;
        if (merged.v === 0 && merged.lobes.length < 3 && ox * ox + oy * oy > merged.r * merged.r * 0.1) {
          merged.lobes.push({ x: ox * 0.8, y: oy * 0.8, r: r * 0.9 });
          merged.r = Math.sqrt(merged.r * merged.r + r * r * 0.3);
          merged.irr = Math.min(1, merged.irr + 0.15);
        } else merged.r = Math.sqrt(merged.r * merged.r + r * r);
        merged.grow = Math.min(merged.grow, 0.6);
      }
      else {
        const d = add(x, y, r, false);
        near(x, y, (o) => {
          if (!o.droplet) return;
          const dx = o.x - x, dy = o.y - y;
          if (dx * dx + dy * dy < r * r) { o.dead = true; d.r = Math.sqrt(d.r * d.r + o.r * o.r * 0.5); }
        });
      }
      // Spray: a few droplets thrown out by the impact.
      const n = Math.floor(1 + rnd() * (2 + r));
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2;
        const dist = r * (1.4 + 2.6 * rnd() * rnd());
        const s = add(x + Math.cos(a) * dist, y + Math.abs(Math.sin(a)) * dist * 0.9 - dist * 0.2, r * (0.07 + 0.17 * rnd() * rnd()), true);
        s.dry = 0.02 + 0.03 * rnd();
      }
    }
    function step(dt, drying, still) {
      buildGrid();
      for (const d of drops) {
        if (d.dead || d.drip) continue;
        if (d.grow < 1) d.grow = Math.min(1, d.grow + dt / 0.14);
        if (!still) d.r -= dt * (d.dry + drying * (0.4 + d.r * 0.1));
        if (d.r < 0.35) { d.dead = true; continue; }
        for (const l of d.lobes) {
          // Lobes evaporate with the drop and slowly pull in (surface tension), so lumpy drops relax over time.
          if (!still) l.r -= dt * d.dry;
          const k = Math.exp(-dt * 0.04);
          l.x *= k; l.y *= k;
        }
        if (d.lobes.length) d.lobes = d.lobes.filter((l) => l.r > 0.4);
        if (still || d.droplet) continue;
        if (d.v > 0 && d.lobes.length) {
          // A drop that starts to run gathers its lobes into one body.
          for (const l of d.lobes) d.r = Math.sqrt(d.r * d.r + l.r * l.r * 0.7);
          d.lobes = [];
        }
        if (d.v === 0) {
          if (rnd() < dt * 2) near(d.x, d.y, (o) => {
            if (o === d || o.dead || o.droplet || o.v > 0 || o.r > d.r) return;
            const ox = o.x - d.x, oy = o.y - d.y, rr = (d.r + o.r) * 0.7;
            if (ox * ox + oy * oy < rr * rr) {
              if (d.lobes.length < 3 && rnd() < 0.7) {
                d.lobes.push({ x: ox * 0.6, y: oy * 0.6, r: o.r * 0.85 });
                d.r = Math.sqrt(d.r * d.r + o.r * o.r * 0.3);
                o.dead = true;
              } else { absorb(d, o, 1); d.y += oy * 0.2; }
            }
          });
          if (d.r > fr.slide && rnd() < dt * fr.start * (d.r - fr.slide + 0.5)) { d.v = 8 + rnd() * 14; d.vx = (rnd() - 0.5) * 14; d.nextTrail = 4; }
          continue;
        }
        // Sliding: gravity against pinning; snags on specks; surges when it runs into wet glass.
        d.v += dt * fr.accel * Math.min(1.4, (d.r - fr.slide * 0.75) / 5);
        if (rnd() < dt * fr.snag) d.v *= 0.1 + rnd() * 0.35;
        if (d.r < fr.slide * 0.75 || d.v < 1) { d.v = 0; continue; }
        d.v = Math.min(d.v, fr.vmax);
        // Steer towards water ahead (it runs down existing paths) and wander otherwise.
        let pull = 0;
        near(d.x, d.y + d.r * 2, (o) => {
          if (o === d) return;
          const ox = o.x - d.x, oy = o.y - d.y;
          if (oy > d.r * 0.5 && oy < d.r * 5 && Math.abs(ox) < d.r * 3.5) pull += Math.sign(ox) * o.r * o.r / (ox * ox + oy * oy + 4);
        });
        d.vx += pull * 260 * dt + (rnd() - 0.5) * dt * 160;
        if (rnd() < dt * 0.8) d.vx += (rnd() - 0.5) * 60;
        d.vx *= Math.exp(-dt * 2.5);
        const dy = d.v * dt;
        d.y += dy;
        d.x += d.vx * dt;
        d.trail += Math.hypot(dy, d.vx * dt);
        if (d.trail > d.nextTrail) {
          d.trail = 0;
          d.nextTrail = Math.max(3, d.r * 0.9) * (0.5 + 2.2 * rnd() * rnd());
          if (rnd() < 0.6) {
            const tr = d.r * (0.1 + 0.24 * rnd() * rnd());
            const t = add(d.x - d.vx * 0.02 + (rnd() - 0.5) * d.r * 0.5, d.y - d.r * (0.9 + 0.3 * rnd()), tr, true);
            t.dry = 0.03 + 0.03 * rnd();
            d.r = Math.sqrt(Math.max(0, d.r * d.r - tr * tr * 0.5));
          }
        }
        near(d.x, d.y, (o) => {
          if (o === d || o.dead) return;
          const ox = o.x - d.x, oy = o.y - d.y;
          const rr = (d.r + o.r) * 0.85;
          if (ox * ox + oy * oy < rr * rr && oy > -d.r * 0.5) {
            const was = o.v === 0 && !o.droplet;
            absorb(d, o, 0.9);
            if (was) d.v *= 0.75;
          }
        });
        if (onEdge && d.y + d.r * 0.2 > H) { onEdge(d); d.dead = true; continue; }
        if (d.y - d.r * 3 > H) d.dead = true;
      }
      if (drops.some((d) => d.dead)) drops = drops.filter((d) => !d.dead);
    }
    return {
      get drops() { return drops; },
      resize(w, h) { W = w; H = h; },
      clear() { drops = []; },
      land, step,
    };
  }

  /* ------------------------------------------------------------------ replica of the card face */
  function Replica(face) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    let RS = 1;
    const q = (sel) => face.querySelector(sel);
    function pos(el) {
      let x = 0, y = 0, n = el;
      while (n && n !== face) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    }
    function rrect(x, y, w, h, r) {
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
    }
    function text(el) {
      if (!el || !el.offsetWidth) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) return;
      const b = pos(el);
      let t = (el.textContent || '').trim();
      if (cs.textTransform === 'uppercase') t = t.toUpperCase();
      g.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      if ('letterSpacing' in g) g.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
      g.fillStyle = cs.color;
      const fs = parseFloat(cs.fontSize);
      const lh = parseFloat(cs.lineHeight) || fs * 1.2;
      const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
      const maxW = b.w - pl - pr;
      const lines = [];
      let line = '';
      for (const word of t.split(/\s+/)) {
        const tryL = line ? line + ' ' + word : word;
        if (line && g.measureText(tryL).width > maxW) { lines.push(line); line = word; } else line = tryL;
      }
      if (line) lines.push(line);
      const al = cs.textAlign;
      g.textAlign = al === 'center' ? 'center' : al === 'right' || al === 'end' ? 'right' : 'left';
      const x = g.textAlign === 'center' ? b.x + pl + maxW / 2 : g.textAlign === 'right' ? b.x + b.w - pr : b.x + pl;
      g.textBaseline = 'middle';
      const top = b.y + (b.h - lh * lines.length) / 2;
      lines.forEach((l, i) => g.fillText(l, x, top + lh * (i + 0.5)));
    }
    function draw(w, h, scale) {
      RS = scale || 1;
      const cw = Math.max(2, Math.round(w * RS)), ch = Math.max(2, Math.round(h * RS));
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      g.setTransform(RS, 0, 0, RS, 0, 0);
      const grd = g.createLinearGradient(w * 0.37, 0, w * 0.63, h);
      grd.addColorStop(0, '#1b1b1d'); grd.addColorStop(0.42, '#09090a'); grd.addColorStop(1, '#030304');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
      const img = q('#coverImg'), cover = q('#cover');
      if (cover && cover.offsetWidth) {
        const b = pos(cover);
        g.save();
        rrect(b.x, b.y, b.w, b.h, 7);
        g.clip();
        g.fillStyle = '#050505';
        g.fillRect(b.x, b.y, b.w, b.h);
        if (img && img.complete && img.naturalWidth) {
          if ('filter' in g) g.filter = document.body.classList.contains('color-art') ? 'none' : 'grayscale(1) contrast(1.12)';
          try { g.drawImage(img, b.x, b.y, b.w, b.h); } catch { /* not decodable */ }
          g.filter = 'none';
        }
        g.restore();
        g.strokeStyle = 'rgba(255,255,255,.92)';
        g.lineWidth = 2;
        rrect(b.x - 1, b.y - 1, b.w + 2, b.h + 2, 8);
        g.stroke();
      }
      ['#artist', '#title', '#album', '#elapsed', '#remaining', '#badgeText'].forEach((s) => text(q(s)));
      const rail = q('#rail');
      if (rail && rail.offsetWidth) {
        const b = pos(rail);
        g.fillStyle = 'rgba(255,255,255,.16)';
        g.fillRect(b.x, b.y, b.w, Math.max(2, b.h));
        const fill = rail.querySelector('.fill');
        const rw = rail.getBoundingClientRect().width;
        const fw = fill && rw ? fill.getBoundingClientRect().width / rw : 0;
        g.fillStyle = '#fff';
        g.fillRect(b.x, b.y, b.w * Math.min(1, fw), Math.max(2, b.h));
      }
      const play = q('#play');
      if (play && play.offsetWidth) {
        const b = pos(play), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        g.strokeStyle = 'rgba(255,255,255,.75)';
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(cx, cy, b.w / 2 - 1, 0, Math.PI * 2); g.stroke();
        g.fillStyle = '#fff';
        if (document.body.classList.contains('playing')) { g.fillRect(cx - 6, cy - 7, 4, 14); g.fillRect(cx + 2, cy - 7, 4, 14); }
        else { g.beginPath(); g.moveTo(cx - 4, cy - 7); g.lineTo(cx + 7, cy); g.lineTo(cx - 4, cy + 7); g.fill(); }
      }
      ['#prev', '#next'].forEach((s, k) => {
        const el = q(s);
        if (!el || !el.offsetWidth) return;
        const b = pos(el), cx = b.x + b.w / 2, cy = b.y + b.h / 2, d = k ? 1 : -1;
        g.fillStyle = el.disabled ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.8)';
        for (const o of [-4, 4]) { g.beginPath(); g.moveTo(cx + o - 4 * d, cy - 6); g.lineTo(cx + o + 4 * d, cy); g.lineTo(cx + o - 4 * d, cy + 6); g.fill(); }
      });
      const wave = q('#wave');
      if (wave && wave.width && wave.offsetWidth) {
        const b = pos(wave);
        try { g.drawImage(wave, b.x, b.y, b.w, b.h); } catch { /* ignore */ }
      }
      // Bright glass edge.
      const eg = g.createLinearGradient(0, 0, w, h);
      eg.addColorStop(0, '#fff'); eg.addColorStop(0.4, 'rgba(255,255,255,.2)'); eg.addColorStop(0.6, 'rgba(255,255,255,.25)'); eg.addColorStop(1, '#fff');
      g.strokeStyle = eg;
      g.lineWidth = 1.6;
      rrect(0.8, 0.8, w - 1.6, h - 1.6, 24);
      g.stroke();
      return c;
    }
    return { draw };
  }

  /* ------------------------------------------------------------------ one wet surface */
  // A canvas with its own GL context, drop simulation, water field and composite. 'screen' is the window in front
  // of everything (falling rain, incoming drops); 'card' lives inside the card face and tilts with it.
  function Glass(canvas, o) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    } catch { gl = null; }
    if (!gl) return null;
    const sim = Sim(o.friction, o.onEdge);
    const bgc = document.createElement('canvas');
    const bg2 = bgc.getContext('2d');
    let splat, fly, comp, quadBuf, dropBuf, fieldTex, fieldFbo, bgTex, floatType = 0, lost = false;
    let w = 0, h = 0, cssW = 1, cssH = 1;

    function pickFloat() {
      const hf = gl.getExtension('OES_texture_half_float');
      gl.getExtension('EXT_color_buffer_half_float');
      if (!hf || !gl.getExtension('OES_texture_half_float_linear')) return gl.UNSIGNED_BYTE;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, hf.HALF_FLOAT_OES, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(f); gl.deleteTexture(t);
      return ok ? hf.HALF_FLOAT_OES : gl.UNSIGNED_BYTE;
    }
    function makeTex() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    function init() {
      splat = program(gl, SPLAT_V, SPLAT_F, ['aPos', 'aQ'], ['uSize']);
      fly = program(gl, SPLAT_V, FLY_F, ['aPos', 'aQ'], ['uSize']);
      comp = program(gl, QUAD_V, COMP_F, ['aPos'], ['uField', 'uBg', 'uRes', 'uPx', 'uTime', 'uRainA', 'uWind', 'uMask0', 'uMask1', 'uMaskR']);
      quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      dropBuf = gl.createBuffer();
      floatType = pickFloat();
      fieldTex = makeTex();
      fieldFbo = gl.createFramebuffer();
      bgTex = makeTex();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.disable(gl.DEPTH_TEST);
      w = 0;
    }
    try { init(); } catch (err) { console.warn('[rain] shader failed', err); return null; }
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      try { init(); lost = false; } catch (err) { console.warn('[rain] restore failed', err); }
    });

    function resize() {
      const [cw, ch, s] = o.size();
      cssW = Math.max(1, cw); cssH = Math.max(1, ch);
      const nw = Math.max(2, Math.round(cssW * s)), nh = Math.max(2, Math.round(cssH * s));
      if (nw !== w || nh !== h) {
        w = nw; h = nh;
        canvas.width = w; canvas.height = h;
        gl.bindTexture(gl.TEXTURE_2D, fieldTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, floatType, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fieldFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fieldTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        lastBg = -1e9;
      }
      sim.resize(cssW, cssH);
    }

    // Snapshot of what is behind this glass; the cadence adapts to its measured cost (Gecko reads WebGL canvases
    // back through the CPU).
    let lastBg = -1e9, bgInterval = 100, bgMs = 0;
    function updateBg(now) {
      if (now - lastBg < bgInterval && now >= lastBg) return;
      lastBg = now;
      const t0 = performance.now();
      const BS = o.bgScale;
      const bw = Math.max(2, Math.round(cssW * BS)), bh = Math.max(2, Math.round(cssH * BS));
      if (bgc.width !== bw || bgc.height !== bh) { bgc.width = bw; bgc.height = bh; }
      bg2.setTransform(1, 0, 0, 1, 0, 0);
      o.drawBg(bg2, bw, bh, BS, cssW, cssH);
      try {
        gl.bindTexture(gl.TEXTURE_2D, bgTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgc);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      } catch { /* keep the previous snapshot */ }
      const ms = performance.now() - t0;
      bgMs = bgMs ? bgMs * 0.8 + ms * 0.2 : ms;
      bgInterval = bgMs > 6 ? 250 : bgMs > 2 ? 150 : 100;
    }

    const VS = 6;   // floats per vertex: x, y, qx, qy, r, seed
    let verts = new Float32Array(6 * VS * 1024);
    function ensure(n) { if (verts.length < n * 6 * VS) verts = new Float32Array(n * 12 * VS); }
    const CORNERS = [[-1, -1], [1, -1], [-1, 1], [-1, 1], [1, -1], [1, 1]];
    function drawQuads(prog, k) {
      gl.useProgram(prog.p);
      gl.uniform2f(prog.u.uSize, cssW, cssH);
      gl.bindBuffer(gl.ARRAY_BUFFER, dropBuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, k), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, VS * 4, 0);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, VS * 4, 8);
      gl.drawArrays(gl.TRIANGLES, 0, k / VS);
    }
    function splatDrops() {
      const ds = sim.drops;
      let n = ds.length;
      for (const d of ds) n += d.lobes.length;
      ensure(n);
      let k = 0;
      const E = 1.6;
      for (const d of ds) {
        const imp = (1 - d.grow) * (1 - d.grow);          // impact: lands spread flat, pulls back into a bead
        const r = d.r;
        const st = Math.min(0.35, d.v / 280);
        const spread = 1 + 0.55 * imp;
        const moving = d.v > 0;
        let rx = r * spread * (1 - st * 0.3) * (moving ? 1 : d.sx);
        let ry = r * spread * (1 - 0.3 * imp) * (1 + st) * (moving ? 1 : 2 - d.sx);
        const cy = d.y - (ry - r) * 0.6 * (st > 0 ? 1 : 0);
        const rot = moving ? 0 : d.rot * Math.min(1, r / 4);
        const cr = Math.cos(rot), sr = Math.sin(rot);
        const packed = Math.round((d.droplet ? 0.2 : d.irr) * 15) * 100 + (d.seed % 100);
        for (const [qx, qy] of CORNERS) {
          const ox = qx * E * rx, oy = qy * E * ry;
          verts[k++] = d.x + ox * cr - oy * sr; verts[k++] = cy + ox * sr + oy * cr;
          verts[k++] = qx * E; verts[k++] = qy * E; verts[k++] = r * (1 - 0.3 * imp); verts[k++] = packed;
        }
        for (let j = 0; j < d.lobes.length; j++) {
          const l = d.lobes[j], lr = l.r * (0.35 + 0.65 * d.grow);
          const lp = Math.round(Math.min(1, d.irr + 0.2) * 15) * 100 + ((d.seed + 17.3 * (j + 1)) % 100);
          for (const [qx, qy] of CORNERS) {
            verts[k++] = d.x + l.x + qx * E * lr; verts[k++] = d.y + l.y + qy * E * lr;
            verts[k++] = qx * E; verts[k++] = qy * E; verts[k++] = lr; verts[k++] = lp;
          }
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fieldFbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!k) return;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawQuads(splat, k);
      gl.disable(gl.BLEND);
    }
    function drawIncoming(list, wind) {
      if (!list.length) return;
      ensure(list.length);
      let k = 0;
      for (const f of list) {
        const u = Math.min(1, f.t / f.dur);
        const dl = Math.hypot(wind, 1), dx = wind / dl, dy = 1 / dl;
        // Out of focus while still in the air, sharpening and slowing as it reaches the glass.
        const back = (1 - u) * (40 + f.r * 6);
        const hx = f.x - dx * back, hy = f.y - dy * back;
        const len = (12 + f.r * 3.5) * (1.15 - 0.5 * u), wid = f.r * (1.4 - 0.6 * u) + 0.8;
        const a = 0.45 * u * u;
        const cx = hx - dx * len * 0.5, cy = hy - dy * len * 0.5;
        for (const [qa, qc] of CORNERS) {
          verts[k++] = cx + dx * qa * len * 0.5 - dy * qc * wid;
          verts[k++] = cy + dy * qa * len * 0.5 + dx * qc * wid;
          verts[k++] = qa; verts[k++] = qc; verts[k++] = a; verts[k++] = 0;
        }
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      drawQuads(fly, k);
      gl.disable(gl.BLEND);
    }
    function composite(t, rainA, wind, masks) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(comp.p);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.disableVertexAttribArray(1);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bgTex);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.uniform1i(comp.u.uField, 0);
      gl.uniform1i(comp.u.uBg, 1);
      gl.uniform2f(comp.u.uRes, w, h);
      gl.uniform1f(comp.u.uPx, w / cssW);
      gl.uniform1f(comp.u.uTime, t);
      gl.uniform1f(comp.u.uRainA, rainA);
      gl.uniform1f(comp.u.uWind, wind);
      gl.uniform4fv(comp.u.uMask0, masks ? masks[0] : NOMASK);
      gl.uniform4fv(comp.u.uMask1, masks ? masks[1] : NOMASK);
      gl.uniform2f(comp.u.uMaskR, masks ? masks[2] : 0, masks ? masks[3] : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    let shown = false;
    return {
      sim,
      resize,
      get size() { return [cssW, cssH]; },
      get bgMs() { return bgMs; },
      get floatOk() { return floatType !== gl.UNSIGNED_BYTE; },
      render(now, t, rainA, wind, masks, incoming) {
        if (lost) return;
        const any = rainA > 0 || sim.drops.length > 0 || (incoming && incoming.length > 0);
        if (!any) {
          if (shown) { shown = false; gl.clear(gl.COLOR_BUFFER_BIT); canvas.classList.remove('on'); }
          return;
        }
        if (!shown) { shown = true; canvas.classList.add('on'); }
        if (!w) resize();
        updateBg(now);
        splatDrops();
        composite(t, rainA, wind, masks);
        if (incoming) drawIncoming(incoming, wind);
      },
    };
  }
  const NOMASK = new Float32Array([-1e4, -1e4, -1e4, -1e4]);

  /* ------------------------------------------------------------------ rain */
  function create(canvas, opts = {}) {
    const noop = { ok: false, enabled: false, frame() {}, setEnabled() {}, stats() { return null; } };
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { scene, face, dock, card: cardCanvas } = opts;
    const replica = face ? Replica(face) : null;

    // Card and dock rectangles. getBoundingClientRect() of the tilted card is the box of its projection: close
    // enough to place the card in the window's snapshot, to hide rain behind it, and to decide where drops land.
    const masks = [new Float32Array([-1e4, -1e4, -1e4, -1e4]), new Float32Array([-1e4, -1e4, -1e4, -1e4]), 24, 18];
    const rects = [null, null];
    let vw = 1, vh = 1;
    function visible(el) {
      if (!el || !el.isConnected) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.4;
    }
    function measure() {
      [vw, vh] = viewSize();
      vw = Math.max(1, vw); vh = Math.max(1, vh);
      const off = framed() ? document.body.getBoundingClientRect() : { left: 0, top: 0 };
      [face, dock].forEach((el, i) => {
        const b = visible(el) ? el.getBoundingClientRect() : null;
        const r = b ? { left: b.left - off.left, top: b.top - off.top, right: b.right - off.left, bottom: b.bottom - off.top, width: b.width, height: b.height } : null;
        rects[i] = r && r.width > 1 ? r : null;
        masks[i].set(rects[i] ? [r.left, vh - r.bottom, r.right, vh - r.top] : [-1e4, -1e4, -1e4, -1e4]);
        if (rects[i]) masks[2 + i] = Math.min(i ? 18 : 24, Math.min(r.width, r.height) / 2);
      });
    }

    const screen = Glass(canvas, {
      size: () => {
        let s = Math.min(1.25, window.devicePixelRatio || 1);
        if (opts.quality) s *= Math.max(0.6, Math.min(1, opts.quality() || 1));
        return [...viewSize(), Math.max(0.5, s)];
      },
      bgScale: 0.5,
      drawBg(g, bw, bh, BS) {
        g.fillStyle = '#000';
        g.fillRect(0, 0, bw, bh);
        if (scene && scene.width) { try { g.drawImage(scene, 0, 0, bw, bh); } catch { /* unreadable */ } }
        g.setTransform(bw * 1.3, 0, 0, bh * 0.95, bw / 2, bh / 2);   // the CSS vignette
        const vg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
        vg.addColorStop(0.52, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.78)');
        g.fillStyle = vg;
        g.fillRect(-1, -1, 2, 2);
        g.setTransform(1, 0, 0, 1, 0, 0);
        if (rects[0] && replica) {
          const r = rects[0];
          g.drawImage(replica.draw(face.offsetWidth, face.offsetHeight, (r.width / face.offsetWidth) * BS), r.left * BS, r.top * BS, r.width * BS, r.height * BS);
        }
        if (rects[1]) {
          const r = rects[1];
          g.fillStyle = 'rgba(12,12,14,.92)';
          g.strokeStyle = 'rgba(255,255,255,.18)';
          g.beginPath();
          if (g.roundRect) g.roundRect(r.left * BS, r.top * BS, r.width * BS, r.height * BS, r.height * BS / 2); else g.rect(r.left * BS, r.top * BS, r.width * BS, r.height * BS);
          g.fill(); g.stroke();
        }
      },
    });
    if (!screen) return noop;
    // The card's own wet surface: drops that land on the card stay on it, tilting and floating with it.
    const card = cardCanvas && face ? Glass(cardCanvas, {
      friction: { slide: 7.5, start: 0.05, accel: 90, snag: 3.2, vmax: 55 },
      onEdge: (d) => drip(d),
      size: () => [face.offsetWidth, face.offsetHeight, Math.min(1.5, window.devicePixelRatio || 1)],
      bgScale: 1,
      drawBg(g, bw, bh, BS, cw, ch) { g.drawImage(replica.draw(cw, ch, BS), 0, 0, bw, bh); },
    }) : null;
    addEventListener('resize', () => { measure(); screen.resize(); if (card) card.resize(); });
    if (card && window.ResizeObserver) new ResizeObserver(() => card.resize()).observe(face);

    // Drips: water that runs off the card's bottom edge hangs there (pinned to the edge as the card sways),
    // swells as more arrives, then lets go and falls past the window under gravity, stretching as it speeds up.
    // They live in the window's simulation as drops flagged 'drip' and are moved from here.
    let drips = [];
    function drip(d) {
      const near = drips.find((p) => p.hang && Math.abs(p.cx - d.x) < (p.r + d.r) * 1.2);
      if (near) { near.r = Math.sqrt(near.r * near.r + d.r * d.r); near.hold *= 0.5; return; }
      const o = { cx: d.x, r: d.r * 0.9, t: 0, hold: 0.4 + rnd() * 1.4, hang: true, vy: 0, drop: null };
      drips.push(o);
    }
    function stepDrips(dt) {
      const r = rects[0];
      for (const p of drips) {
        if (!p.drop) {
          const nd = { x: 0, y: 0, r: p.r, v: 0, vx: 0, grow: 0.3, droplet: false, drip: true, seed: rnd() * 100,
            sx: 1, rot: 0, irr: 0.15, lobes: [], dead: false, dry: 0 };
          screen.sim.drops.push(nd);
          p.drop = nd;
        }
        const d = p.drop;
        p.t += dt;
        if (p.hang) {
          if (!r || !face) { p.hang = false; continue; }
          // Pinned under the edge: the bulge grows as it hangs.
          const sx = r.left + (p.cx / face.offsetWidth) * r.width;
          const swell = Math.min(1, p.t / p.hold);
          d.x = sx; d.r = p.r * (0.75 + 0.35 * swell);
          d.y = r.bottom + d.r * (0.1 + 0.55 * swell);
          d.grow = Math.min(1, d.grow + dt * 3);
          if (p.t > p.hold) { p.hang = false; p.vy = 20; }
        } else {
          p.vy = Math.min(1400, p.vy + dt * 1500);
          d.y += p.vy * dt;
          d.v = p.vy;                                   // stretches it in the splat
          d.r *= Math.exp(-dt * 0.4);
          if (d.y - d.r * 4 > vh) { d.dead = true; p.done = true; }
        }
      }
      if (drips.some((p) => p.done)) drips = drips.filter((p) => !p.done);
    }

    // Wind: a steady slant with slow gusts.
    const windAt = (t) => 0.13 + 0.06 * Math.sin(t * 0.23) + 0.03 * Math.sin(t * 0.91 + 1.7) + 0.012 * Math.sin(t * 2.9);

    let incoming = [], spawnAcc = 0, cardAcc = 0;
    function spawn(x, y) { incoming.push({ x, y, r: 1.6 + 8.5 * Math.pow(rnd(), 1.8), t: 0, dur: 0.05 + 0.05 * rnd() }); }
    function onCard(x, y) {
      const r = rects[0];
      if (!r || x < r.left + 3 || x > r.right - 3 || y < r.top + 3 || y > r.bottom - 3) return null;
      const sx = face.offsetWidth / r.width, sy = face.offsetHeight / r.height;
      return [(x - r.left) * sx, (y - r.top) * sy, sx];
    }
    function stepRain(dt, rainA, still) {
      if (rainA > 0) {
        spawnAcc += dt * vw * vh * RATE * rainA;
        while (spawnAcc > 1) { spawnAcc--; spawn(rnd() * vw, rnd() * (vh + 20) - 20); }
        // The card is out in the rain: it catches extra drops of its own.
        const r = rects[0];
        if (r && card) {
          cardAcc += dt * r.width * r.height * RATE * 0.9 * rainA;
          while (cardAcc > 1) { cardAcc--; spawn(r.left + rnd() * r.width, r.top + rnd() * r.height); }
        }
      }
      for (const f of incoming) {
        f.t += dt;
        if (f.t < f.dur && !still) continue;
        f.done = true;
        const c = card && onCard(f.x, f.y);
        if (c) card.sim.land(c[0], c[1], f.r * c[2]);
        else screen.sim.land(f.x, f.y, f.r);
      }
      if (incoming.some((f) => f.done)) incoming = incoming.filter((f) => !f.done);
    }

    let enabled = false, rainA = 0, last = -1, frameNo = 0;
    const tStart = performance.now();
    function frame(now) {
      const dt = last < 0 ? 0 : Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      // Rain eases in over ~2 s and stops over ~1 s; the glass then dries on its own.
      rainA = enabled ? Math.min(1, rainA + dt / 2) : Math.max(0, rainA - dt);
      const idle = rainA === 0 && !incoming.length && !drips.length && !screen.sim.drops.length && !(card && card.sim.drops.length);
      if (idle && !enabled) { screen.render(now, 0, 0, 0, masks, null); if (card) card.render(now, 0, 0, 0, null, null); return; }
      if (frameNo++ % 6 === 0) measure();
      const t = reduced ? 41 : (now - tStart) / 1000;
      const wind = windAt(t);
      const ra = reduced ? 0 : rainA;
      stepRain(dt, ra, reduced);
      const drying = enabled ? 0 : 0.6;
      stepDrips(dt);
      screen.sim.step(dt, drying, reduced);
      if (card) card.sim.step(dt, drying, reduced);
      const eased = ra * ra * (3 - 2 * ra);
      screen.render(now, t, eased, wind, masks, reduced ? null : incoming);
      if (card) card.render(now, t, 0, wind, null, null);
    }

    return {
      ok: true,
      frame,
      setEnabled(on) {
        on = !!on;
        if (on === enabled) return;
        enabled = on;
        if (enabled) {
          measure(); screen.resize(); if (card) card.resize();
          if (reduced) {   // no falling rain: just a still, wet pane
            for (let i = 0; i < 900; i++) { stepRain(1 / 30, 1, true); spawnAcc += 1 / 30 * vw * vh * RATE; }
            stepRain(0, 1, true);
          }
        } else if (reduced) { screen.sim.clear(); if (card) card.sim.clear(); }
      },
      get enabled() { return enabled; },
      _debug: { screen, card, get incoming() { return incoming; }, get drips() { return drips; } },
      stats() {
        const count = (g) => g ? { drops: g.sim.drops.filter((d) => !d.droplet).length, droplets: g.sim.drops.filter((d) => d.droplet).length, sliding: g.sim.drops.filter((d) => d.v > 0).length, } : null;
        return { rain: +rainA.toFixed(3), float: screen.floatOk, bgMs: +screen.bgMs.toFixed(2), incoming: incoming.length, screen: count(screen), card: count(card) };
      },
    };
  }

  return { create };
})();
