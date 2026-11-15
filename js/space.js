/* Space — ray-traced, monochrome Schwarzschild black hole rendered with WebGL.
 * Photons are integrated with the classic  a = -1.5 h^2 p / r^5  approximation, so the
 * accretion disk is gravitationally lensed over and under the shadow.
 *
 *   const space = Space.create(canvas);
 *   space.frame(nowMs);          // call once per animation frame
 *   space.setEnergy(0..1);       // bass level, brightens the disk
 *   space.setLook(x, y);         // -1..1 pointer parallax
 *   space.setRain(0..1);         // fogs/blurs the image like a wet window (eased over ~1 s)
 *   space.setScene(id);          // 'horizon' (the black hole), 'mountain', 'sea', 'nebula'; see Space.SCENES
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

  // ---------------------------------------------------------------- other backgrounds
  // Each writes the same format as the black hole (R: tone-mapped value, G: linear luminance / 5), so the post
  // chain (bloom, lens softness, grain, rain fog) and the rain overlay work unchanged. Compiled on first use.
  const SCENE_SRC = {
    mountain: `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2  uRes;
uniform float uTime;
uniform float uEnergy;
uniform vec2  uLook;
uniform float uDetail;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n + 3.1)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7; a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7; a *= 0.5; }
  return s;
}
// 1D terrain noise along x
float n1(float x, float seed) { return vnoise(vec2(x, seed)); }
float ridge1(float x, float seed) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * (1.0 - abs(2.0 * n1(x, seed) - 1.0)); x = x * 2.07 + 3.1; a *= 0.5; }
  return s;
}
// Point stars, one per cell, a few bright, most faint; sharp to a pixel; gentle twinkle.
float starLayer(vec2 uv, float scale, float seed, float keep) {
  vec2 g = uv * scale + seed;
  vec2 id = floor(g);
  vec2 o = h22(id) - 0.5;
  float b = h21(id + 11.3);
  vec2 d = (fract(g) - 0.5 - o * 0.8) / scale * uRes.y;     // pixels
  float tw = 0.75 + 0.25 * sin(uTime * (1.5 + 3.0 * b) + b * 40.0);
  float s = (b - (1.0 - keep)) / keep;                     // only a fraction 'keep' of cells holds a star
  return step(0.0, s) * (0.15 + 0.85 * pow(max(s, 0.0), 3.0)) * exp(-dot(d, d) * 1.7) * 2.2 * tw;
}
float stars(vec2 uv) {
  return starLayer(uv, 30.0, 0.0, 0.16) + starLayer(uv, 64.0, 5.3, 0.07) * 0.7 + starLayer(uv, 130.0, 9.1, 0.03) * 0.5 * uDetail;
}
// Same output format as the black hole: R display value, G linear luminance / 5 for bloom.
vec4 outLum(float L) {
  float c = L * 1.15;
  float tm = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return vec4(clamp(tm, 0.0, 1.0), clamp(c * 0.2, 0.0, 1.0), 0.0, 1.0);
}

// Lonely Mountain: a ray-marched, moonlit, snow-covered peak.
// Terrain: eroded fBm (value noise with analytic derivatives; steep areas get less fine detail, which carves
// ridges and gullies) on top of one tall summit. Lit by the moon in the sky, with soft self-shadowing, slope-based
// snow, distance haze and drifting valley mist.
const mat2 M2 = mat2(0.8, -0.6, 0.6, 0.8);
const vec3 MOON = vec3(-0.3378, 0.2969, 0.8929);   // where the moon is drawn: low, upper left of the view
// Where the light comes from: the side (a painter's cheat; true backlight would leave every face we see dark).
const vec3 LIGHT = vec3(-0.8697, 0.4246, -0.2516);  // normalize(-0.85, 0.415, -0.246)
const vec2 PEAK = vec2(4.3, 11.0);

vec3 noised(vec2 x) {
  vec2 p = floor(x), f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = h21(p), b = h21(p + vec2(1.0, 0.0)), c = h21(p + vec2(0.0, 1.0)), d = h21(p + vec2(1.0, 1.0));
  return vec3(a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y,
              du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx));
}
float eroded(vec2 x, int oct) {
  vec2 p = x * 0.42;
  float a = 0.0, b = 1.0;
  vec2 d = vec2(0.0);
  for (int i = 0; i < 11; i++) {
    if (i >= oct) break;
    vec3 n = noised(p);
    n = vec3(n.x * 2.0 - 1.0, n.yz * 2.0);
    d += n.yz;
    a += b * n.x / (1.0 + dot(d, d));
    b *= 0.5;
    p = M2 * p * 2.0;
  }
  return a;
}
float terrain(vec2 x, int oct) {
  float r = length((x - PEAK) * vec2(1.0, 0.8));
  // one tall, sharp summit with a long shoulder; a quiet valley floor in front; low ranges far behind
  float summit = 4.6 * pow(max(0.0, 1.0 - r / 5.2), 2.1) + 1.2 * exp(-r * r / 30.0)
               + 1.0 * pow(max(0.0, 1.0 - length(x - PEAK - vec2(-3.2, 1.5)) / 3.5), 2.0);
  float ranges = 0.75 * smoothstep(16.0, 34.0, x.y) * (0.6 + 0.4 * sin(x.x * 0.15 + 1.0));
  float nearCalm = 0.12 + 0.88 * smoothstep(3.0, 11.0, x.y);           // gentle snowfield close to us
  float detail = eroded(x, oct) * nearCalm * (0.45 + 0.75 * exp(-r * r / 14.0) + 0.5 * smoothstep(16.0, 34.0, x.y));
  return summit + ranges + detail - 0.55 - 0.25 * (1.0 - smoothstep(2.0, 9.0, x.y));
}
vec3 calcNormal(vec3 p, float t) {
  vec2 e = vec2(0.0015 * t + 0.002, 0.0);
  int oct = int(mix(10.0, 5.0, clamp(t / 40.0, 0.0, 1.0)));
  return normalize(vec3(terrain(p.xz - e.xy, oct) - terrain(p.xz + e.xy, oct), 2.0 * e.x,
                        terrain(p.xz - e.yx, oct) - terrain(p.xz + e.yx, oct)));
}
float march(vec3 ro, vec3 rd) {
  float t = 0.3;
  for (int i = 0; i < 160; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - terrain(p.xz, 6);
    if (abs(h) < 0.0015 * t || t > 60.0) break;
    t += 0.45 * h;
  }
  return t;
}
float shadow(vec3 p) {
  float res = 1.0, t = 0.08;
  for (int i = 0; i < 28; i++) {
    vec3 q = p + LIGHT * t;
    float h = q.y - terrain(q.xz, 4);
    res = min(res, 10.0 * h / t);
    t += clamp(h, 0.06, 0.6);
    if (res < 0.0 || t > 14.0) break;
  }
  return clamp(res, 0.0, 1.0);
}
float sky(vec3 rd, vec2 uv) {
  float up = rd.y;
  float L = 0.008 + 0.05 * exp(-max(up, 0.0) * 9.0);
  float m = dot(rd, MOON);
  L += 0.05 * pow(max(m, 0.0), 12.0) * (1.0 + 0.3 * uEnergy) + 0.35 * pow(max(m, 0.0), 400.0);
  // Milky Way and stars on a direction-fixed sky
  vec2 su = vec2(atan(rd.x, rd.z), up) * 1.4;
  vec2 bd = normalize(vec2(0.5, 1.0));
  float band = exp(-pow(dot(su - vec2(0.35, 0.1), vec2(bd.y, -bd.x)) / 0.22, 2.0));
  L += band * (0.03 * smoothstep(0.4, 0.8, fbm(su * 4.0 + 2.0)) + 0.008);
  float st = stars(su) + band * starLayer(su, 160.0, 3.7, 0.08) * 0.7 * uDetail;
  L += st * smoothstep(0.0, 0.12, up) * (1.0 - smoothstep(0.996, 0.9995, m)) * (1.0 + 0.5 * uEnergy);
  // the moon: a slightly mottled disc
  float disc = smoothstep(0.99955, 0.99965, m);
  L = mix(L, 2.2 * (0.82 + 0.18 * fbm(su * 160.0)), disc);
  // a meteor now and then: thin, sharp head, tapering trail, about half a second
  float period = 23.0;
  float slot = floor(uTime / period), ph = fract(uTime / period) * period;
  if (ph < 0.7 && h21(vec2(slot, 4.0)) > 0.35) {
    float u = ph / 0.7;
    vec2 a = vec2(mix(-0.6, 0.6, h21(vec2(slot, 1.0))), 0.28 + 0.15 * h21(vec2(slot, 2.0)));
    vec2 dir = normalize(vec2(mix(-1.0, 1.0, step(0.5, h21(vec2(slot, 3.0)))) * 0.85, -0.42));
    vec2 head = a + dir * u * 0.3;
    vec2 rel = uv - head;
    float along = dot(rel, -dir), across = abs(dot(rel, vec2(-dir.y, dir.x))) * uRes.y;   // px
    float len = 0.12 * sin(u * 3.14159);
    float trail = step(0.0, along) * (1.0 - smoothstep(0.0, len, along)) * pow(1.0 - along / max(len, 1e-3), 2.0);
    float core = exp(-across * across * 1.2);
    float headGlow = exp(-dot(rel, rel) * uRes.y * uRes.y * 0.4);
    L += (trail * core * 0.6 + headGlow * 1.2) * sin(u * 3.14159) * smoothstep(0.0, 0.1, up);
  }
  return L;
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float asp = uRes.x / uRes.y;
  bool wide = asp > 1.15;
  // camera: low in the valley, looking up the glacier at the peak (right of the card on wide screens)
  vec3 ro = vec3(uLook.x * 0.25, 1.15 + uLook.y * 0.06, -2.0);
  vec3 ta = wide ? vec3(0.4, 1.75, 8.0) : vec3(3.6, 2.6, 8.0);
  vec3 ww = normalize(ta - ro), uu = normalize(cross(vec3(0.0, 1.0, 0.0), ww)), vv = cross(ww, uu);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.7 * ww);

  float t = march(ro, rd);
  float L;
  if (t > 60.0) {
    L = sky(rd, uv);
  } else {
    vec3 p = ro + rd * t;
    vec3 n = calcNormal(p, t);
    float sh = shadow(p + n * 0.01);
    float dif = max(dot(n, LIGHT), 0.0) * sh;
    // snow settles where the slope lets it, and more of it higher up; steep faces stay dark rock
    float slope = n.y;
    float hgt = p.y;
    float snowN = fbm3(p.xz * 3.0);
    float snow = smoothstep(0.68, 0.9, slope + 0.07 * hgt - 0.12 + 0.3 * (snowN - 0.5));
    float alb = mix(0.045, 0.8, snow);
    float amb = 0.028 * (0.4 + 0.6 * n.y);
    float bounce = 0.02 * max(-n.y, 0.0);
    L = alb * (dif * 0.62 + amb + bounce);
    // the valley floor close by sits in the mountain's shadow and the night
    L *= mix(0.35, 1.0, smoothstep(3.0, 14.0, t));
    // sparkle on lit snow (fine ice catching the moon)
    L += snow * dif * 0.25 * pow(max(dot(reflect(rd, n), LIGHT), 0.0), 40.0);
    // haze with distance, a little brighter towards the moon
    float m = max(dot(rd, MOON), 0.0);
    vec3 fogCol = vec3(0.03 + 0.05 * pow(m, 6.0));
    L = mix(L, fogCol.x, 1.0 - exp(-t * 0.028));
  }
  // valley mist: dense low down, drifting, lit by the moon
  float fogH = 0.7;
  float yd = max(rd.y, 0.001);
  float tm = min(t, 60.0);
  float mist = 0.3 * exp(-max(ro.y - fogH, 0.0) * 1.6) * (1.0 - exp(-tm * yd * 1.6)) / (yd * 1.6);
  mist *= 0.55 + 0.45 * fbm3(vec2(rd.x * 6.0 + uTime * 0.01, rd.y * 18.0 - uTime * 0.004));
  L += clamp(mist, 0.0, 1.0) * (0.035 + 0.05 * pow(max(dot(rd, MOON), 0.0), 5.0));
  gl_FragColor = outLum(L);
}`,
    sea: `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2  uRes;
uniform float uTime;
uniform float uEnergy;
uniform vec2  uLook;
uniform float uDetail;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n + 3.1)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7; a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7; a *= 0.5; }
  return s;
}
// 1D terrain noise along x
float n1(float x, float seed) { return vnoise(vec2(x, seed)); }
float ridge1(float x, float seed) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * (1.0 - abs(2.0 * n1(x, seed) - 1.0)); x = x * 2.07 + 3.1; a *= 0.5; }
  return s;
}
// Point stars, one per cell, a few bright, most faint; sharp to a pixel; gentle twinkle.
float starLayer(vec2 uv, float scale, float seed, float keep) {
  vec2 g = uv * scale + seed;
  vec2 id = floor(g);
  vec2 o = h22(id) - 0.5;
  float b = h21(id + 11.3);
  vec2 d = (fract(g) - 0.5 - o * 0.8) / scale * uRes.y;     // pixels
  float tw = 0.75 + 0.25 * sin(uTime * (1.5 + 3.0 * b) + b * 40.0);
  float s = (b - (1.0 - keep)) / keep;                     // only a fraction 'keep' of cells holds a star
  return step(0.0, s) * (0.15 + 0.85 * pow(max(s, 0.0), 3.0)) * exp(-dot(d, d) * 1.7) * 2.2 * tw;
}
float stars(vec2 uv) {
  return starLayer(uv, 30.0, 0.0, 0.16) + starLayer(uv, 64.0, 5.3, 0.07) * 0.7 + starLayer(uv, 130.0, 9.1, 0.03) * 0.5 * uDetail;
}
// Same output format as the black hole: R display value, G linear luminance / 5 for bloom.
vec4 outLum(float L) {
  float c = L * 1.15;
  float tm = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return vec4(clamp(tm, 0.0, 1.0), clamp(c * 0.2, 0.0, 1.0), 0.0, 1.0);
}

// Moonlit Sea: a calm ocean, a low moon and its broken road of light.
float clouds(vec2 p, float t) { return smoothstep(0.42, 0.78, fbm(p * vec2(1.3, 4.0) + vec2(t * 0.006, 0.0))); }
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float asp = uRes.x / uRes.y;
  bool wide = asp > 1.15;
  float hz = (wide ? -0.07 : 0.02) + uLook.y * 0.004;
  vec2 moon = wide ? vec2(0.33 * asp, 0.20) : vec2(0.18, 0.36);
  float t = uTime;
  float L;
  if (uv.y > hz) {
    vec2 su = uv;
    float dm = length(su - moon);
    L = 0.012 + 0.07 * exp(-(uv.y - hz) * 7.0) + 0.14 * exp(-dm * 6.0) * (1.0 + 0.25 * uEnergy) + 0.3 * exp(-dm * 28.0);
    L += stars(su) * smoothstep(0.05, 0.25, dm) * smoothstep(hz, hz + 0.1, uv.y) * (1.0 + 0.5 * uEnergy);
    float c = clouds(su, t);
    // dense cores dark, thin edges near the moon lit silver
    float edge = c * (1.0 - c) * 4.0;
    float cl = 0.015 + 0.6 * exp(-dm * 4.5) * (0.35 + edge);
    L = mix(L, cl, c * 0.92);
    float mr = 0.036;
    float disc = smoothstep(mr, mr - 0.0025, dm) * (1.0 - c * 0.85);
    L = mix(L, 2.4 * (0.84 + 0.16 * fbm(su * 80.0)), disc);
    // haze sitting on the horizon
    L += 0.05 * exp(-(uv.y - hz) * 40.0);
  } else {
    float depth = hz - uv.y;                                  // 0 at the horizon
    float z = 0.12 / max(depth, 0.002);                      // distance
    vec2 w = vec2((uv.x - moon.x) * z, z);
    // waves: two wind directions, moving
    vec2 p1 = w * vec2(2.6, 7.0) + vec2(t * 0.15, t * 0.45);
    vec2 p2 = w * vec2(6.5, 15.0) + vec2(-t * 0.2, t * 0.7);
    float e = 0.05;
    float hgt = fbm3(p1) + 0.5 * fbm3(p2);
    float hx = fbm3(p1 + vec2(e, 0.0)) + 0.5 * fbm3(p2 + vec2(e, 0.0)) - hgt;
    float hy = fbm3(p1 + vec2(0.0, e)) + 0.5 * fbm3(p2 + vec2(0.0, e)) - hgt;
    // reflected sky: brighter towards the horizon (fresnel), darker close by
    float fres = exp(-depth * 9.0);
    L = 0.006 + 0.07 * fres;
    // the moon's road: wider close to us, broken into glints by the wave slopes
    float wdt = 0.012 + 0.55 * depth;
    float road = exp(-pow((uv.x - moon.x + hx * 0.35 * depth * 4.0) / wdt, 2.0));
    float glint = smoothstep(0.004, 0.03, -hy * (1.0 + depth * 6.0)) ;
    float sparkle = pow(clamp(hgt - 0.35, 0.0, 1.0) * 2.0, 3.0);
    L += road * (0.08 * fres + glint * (0.6 + 1.6 * sparkle) * (1.0 + 0.5 * uEnergy)) * (1.0 - 0.6 * smoothstep(0.0, 0.45, depth));
    L += road * 0.25 * exp(-depth * 60.0);                    // the bright band right under the horizon
    // a faint swell structure everywhere
    L += 0.012 * smoothstep(0.0, 0.05, -hy) * (1.0 - smoothstep(0.0, 0.3, depth));
  }
  gl_FragColor = outLum(L);
}`,
    nebula: `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2  uRes;
uniform float uTime;
uniform float uEnergy;
uniform vec2  uLook;
uniform float uDetail;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 h22(vec2 p) { float n = h21(p); return vec2(n, h21(p + n + 3.1)); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7; a *= 0.5; }
  return s;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.7; a *= 0.5; }
  return s;
}
// 1D terrain noise along x
float n1(float x, float seed) { return vnoise(vec2(x, seed)); }
float ridge1(float x, float seed) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * (1.0 - abs(2.0 * n1(x, seed) - 1.0)); x = x * 2.07 + 3.1; a *= 0.5; }
  return s;
}
// Point stars, one per cell, a few bright, most faint; sharp to a pixel; gentle twinkle.
float starLayer(vec2 uv, float scale, float seed, float keep) {
  vec2 g = uv * scale + seed;
  vec2 id = floor(g);
  vec2 o = h22(id) - 0.5;
  float b = h21(id + 11.3);
  vec2 d = (fract(g) - 0.5 - o * 0.8) / scale * uRes.y;     // pixels
  float tw = 0.75 + 0.25 * sin(uTime * (1.5 + 3.0 * b) + b * 40.0);
  float s = (b - (1.0 - keep)) / keep;                     // only a fraction 'keep' of cells holds a star
  return step(0.0, s) * (0.15 + 0.85 * pow(max(s, 0.0), 3.0)) * exp(-dot(d, d) * 1.7) * 2.2 * tw;
}
float stars(vec2 uv) {
  return starLayer(uv, 30.0, 0.0, 0.16) + starLayer(uv, 64.0, 5.3, 0.07) * 0.7 + starLayer(uv, 130.0, 9.1, 0.03) * 0.5 * uDetail;
}
// Same output format as the black hole: R display value, G linear luminance / 5 for bloom.
vec4 outLum(float L) {
  float c = L * 1.15;
  float tm = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  return vec4(clamp(tm, 0.0, 1.0), clamp(c * 0.2, 0.0, 1.0), 0.0, 1.0);
}

// Deep Field: slow gas and dust lit by one bright young star.
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float asp = uRes.x / uRes.y;
  bool wide = asp > 1.15;
  vec2 core = wide ? vec2(0.3 * asp, 0.05) : vec2(0.1, 0.3);
  float t = uTime * 0.012;
  vec2 p = uv + uLook * 0.006;
  // domain-warped gas, drifting
  vec2 q = vec2(fbm(p * 1.6 + vec2(0.0, t)), fbm(p * 1.6 + vec2(5.2, 1.3 - t)));
  vec2 r = vec2(fbm(p * 1.6 + 3.5 * q + vec2(1.7, 9.2) + t * 0.6), fbm(p * 1.6 + 3.5 * q + vec2(8.3, 2.8)));
  float gas = fbm(p * 2.0 + 3.0 * r);
  float dc = length(p - core);
  float light = 0.45 + 1.5 * exp(-dc * 2.0) * (1.0 + 0.35 * uEnergy);
  float L = pow(smoothstep(0.25, 0.85, gas), 2.0) * 0.55 * light + 0.02 * fbm(p * 6.0) * light;
  // dark dust lanes in front of the gas
  float dust = smoothstep(0.5, 0.75, fbm(p * 3.2 + 2.0 * q + 11.0));
  L *= 1.0 - 0.85 * dust;
  // rim-lit gas edges facing the star
  L += 0.08 * smoothstep(0.55, 0.65, gas) * (1.0 - smoothstep(0.65, 0.8, gas)) * exp(-dc * 2.0);
  L += stars(p) * (1.0 - 0.8 * dust);
  // the star itself, with diffraction spikes
  vec2 d = (p - core) * uRes.y;
  float spikes = (exp(-abs(d.x) * 0.9) * exp(-abs(d.y) * 0.012) + exp(-abs(d.y) * 0.9) * exp(-abs(d.x) * 0.012)) * 0.9;
  L += 3.0 * exp(-dot(d, d) * 0.02) + spikes * (1.0 + 0.5 * uEnergy) + 0.25 * exp(-dc * 9.0);
  gl_FragColor = outLum(L);
}`,
  };
  const SCENES = [
    { id: 'horizon', name: 'Event Horizon' },
    { id: 'mountain', name: 'Lonely Mountain' },
    { id: 'sea', name: 'Moonlit Sea' },
    { id: 'nebula', name: 'Deep Field' },
  ];

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

  // The size of the "view": the window, or the recording frame when the body is framed (see styles.css).
  const viewSize = () => (document.body && document.body.classList.contains('framed')
    ? [document.body.clientWidth, document.body.clientHeight] : [innerWidth, innerHeight]);

  const noop = { frame() {}, setEnergy() {}, setLook() {}, setRain() {}, setScene() {}, stats() { return null; }, ok: false };
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
      G = { scene, scenes: { horizon: scene }, pending: {}, down, up, comp, targets: null, tw: 0, th: 0 };
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
      const [vw, vh] = viewSize();
      w = Math.max(2, Math.round(vw * scale));
      h = Math.max(2, Math.round(vh * scale));
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
    let sceneId = 'horizon', shownId = 'horizon';
    // Background programs compile on first use. Compiling one blocks for a few hundred ms, so where the browser
    // can compile in the background (KHR_parallel_shader_compile) the old scene keeps drawing until the new one is
    // ready, and the others are pre-compiled shortly after start-up. Falls back to the black hole on failure.
    const par = gl.getExtension('KHR_parallel_shader_compile');
    const SCENE_U = ['uRes', 'uTime', 'uEnergy', 'uLook', 'uDetail'];
    function startScene(id) {
      if (!G || G.scenes[id] || G.pending[id] || !SCENE_SRC[id]) return;
      const p = gl.createProgram();
      [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, SCENE_SRC[id]]].forEach(([type, src]) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        gl.attachShader(p, s);
      });
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      G.pending[id] = p;
    }
    function sceneProgram() {
      if (!G.scenes[sceneId]) {
        startScene(sceneId);
        const p = G.pending[sceneId];
        if (p && par && !gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR)) return G.scenes[shownId] ? [shownId, G.scenes[shownId]] : ['horizon', G.scenes.horizon];
        delete G.pending[sceneId];
        if (p && gl.getProgramParameter(p, gl.LINK_STATUS)) {
          const u = {};
          SCENE_U.forEach((n) => { u[n] = gl.getUniformLocation(p, n); });
          G.scenes[sceneId] = { p, u };
        } else {
          console.warn('[space] scene failed: ' + sceneId, p && gl.getProgramInfoLog(p));
          sceneId = 'horizon';
        }
      }
      shownId = sceneId;
      return [sceneId, G.scenes[sceneId]];
    }

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
      // Lens focus for the other backgrounds: where the eye goes (the peak, the moon, the star).
      const wide = aspect > 1.15;
      const [drawId, prog] = sceneProgram();
      const focus = { mountain: wide ? [0.31 * aspect, 0.2] : [0.12, 0.3], sea: wide ? [0.33 * aspect, 0.2] : [0.18, 0.36], nebula: wide ? [0.3 * aspect, 0.05] : [0.1, 0.3] }[drawId];
      if (focus) hole = { x: w * 0.5 + focus[0] * h, y: h * 0.5 + focus[1] * h };

      const t = (now - t0) / 1000 * (reduced ? 0.25 : 1);
      const su = prog.u;
      bindTarget(G.targets.scene);
      gl.useProgram(prog.p);
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

      if (firstFrame) {
        firstFrame = false;
        canvas.classList.add('ready');
        if (par) setTimeout(() => Object.keys(SCENE_SRC).forEach(startScene), 4000);
      }
    }

    return {
      ok: true,
      frame,
      setEnergy(e) { energy = e; },
      setLook(x, y) { look.tx = x; look.ty = y; },
      setRain(level) { rainTarget = Math.min(1, Math.max(0, +level || 0)); },
      setScene(id) { if (id === 'horizon' || SCENE_SRC[id]) sceneId = id; },
      get scene() { return sceneId; },
      get shownScene() { return shownId; },   // what is actually on screen (lags while a scene compiles)
      stats() { return { scale: +scale.toFixed(3), skip, w, h, adjustments, refresh: +refresh.toFixed(1), ceiling: isFinite(ceiling) ? +ceiling.toFixed(3) : null, rain: +rain.toFixed(3), lost }; },
    };
  }

  return { create, SCENES };
})();
