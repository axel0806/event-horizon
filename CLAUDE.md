# CLAUDE.md

## Project
**Event Horizon**: a dependency-free, browser-only music player. Users import local audio
(MP3, FLAC, M4A/AAC, WAV, OGG/Opus, WebM) by file picker, folder picker or drag-and-drop. The visual
direction comes from `inspiration/1.mp4`: a pure monochrome deep-space scene with a lensed black hole and a floating,
gently swaying 3D glass "now playing" card. `plan.md` tracks status and open work.

## Running
No build step and no dependencies. Open `index.html` directly (file:// works), or serve the folder:
```
npx serve .        # or: python -m http.server
```
Scripts are classic `<script>` tags, **not ES modules**, so that file:// keeps working. Keep it that way.
Each file exposes one global: `Tags`, `Library`, `Space`, `Rain`, and `EventHorizon` (a debug handle).

## Layout
| File | Role |
|---|---|
| `index.html` | Markup, inline SVG icon sprite (`#i-*` symbols), hidden file inputs, `<audio>` |
| `css/styles.css` | All styling. Design tokens in `:root`; `--energy` (0–1 bass level) is set from JS each frame |
| `js/app.js` | Controller: state, playback, queue, import, Web Audio graph, waveform, card tilt, keyboard, Media Session |
| `js/space.js` | WebGL black-hole ray tracer (GLSL in template strings), traced into an RGBA8 texture, then a post chain (bloom/halation pyramid, lens softness, grain, rain fog) draws to the canvas inside `frame()`. Backgrounds: the black hole plus `SCENE_SRC` scenes (`mountain`, `sea`, `nebula`; list in `Space.SCENES`), all writing the same R/G format into the post chain; compiled in the background with `KHR_parallel_shader_compile`. API: `create(canvas, opts) → {ok, frame, setEnergy, setLook, setRain, setScene, scene, shownScene, stats}` |
| `js/rain.js` | Rain, on two WebGL surfaces: the window (`#rain`, full screen, above the stage, below queue/drop/toasts) with falling streaks (refracting, wind-gusted, hidden behind card/dock) and incoming drops, and the card (`#rainCard` inside `.face`, tilts with it; rougher glass, more friction). Water running off the card's bottom edge becomes a window-layer drip that hangs, swells and falls. Each surface: CPU drop sim (merge, steering slides, trails, drying) → half-float metaball field → lens shading refracting a snapshot of what is behind it (scene + vignette + card/dock replica, or the card replica). `rain.frame(now)` must run right after `space.frame(now)`. API: `create(canvas, {scene, face, dock, card, quality}) → {ok, frame, setEnabled, stats}` |
| `js/tags.js` | Metadata/cover parser: ID3v2/v1, FLAC, Ogg, MP4, WAV/AIFF. `Tags.read(file) → {title, artist, album, picture} | null`, never throws |
| `js/library.js` | IndexedDB store `event-horizon/tracks`; records hold the audio `File` blob itself |

## Key behaviours and gotchas
- **FileList is live**: copy `input.files` to an array *before* resetting `input.value` (this caused a real bug).
- **Durations are read lazily**: media elements don't load in hidden tabs, so import never waits on them. Tracks are added straight
  from their tags, and a background queue fills in the durations (shown as `–:––` until then).
- Clamp the frame-loop `dt` to 0–0.05 s. The first rAF timestamp can be earlier than `performance.now()`, and a negative dt
  once sent the card millions of px off-screen.
- Drag-drop folder traversal must call `webkitGetAsEntry()` synchronously inside the drop handler.
- `createMediaElementSource` can be called only once per `<audio>`. The graph is created lazily on the first play (a user gesture).
  Volume is a GainNode (v² curve), so the analyser and visuals don't depend on volume.
- Track records persisted to IndexedDB must not include `coverURL` (object URLs are per-session). Use `record(t)`.
- Tracks without art get a deterministic generated "mini black hole" cover (`genCover`, seeded by title|artist).
- Covers are shown grayscale by default to keep the monochrome look. `C` / the dock button toggles colour.
- `space.js` adapts resolution (45%–100% of device pixels, starting at 75%) with hysteresis. Frame times are judged
  against the measured display refresh, because vsync caps them, plus absolute bounds (slow above 25 ms, fast below 18.5 ms).
  Windows containing a hitch over 120 ms or a hidden page are discarded, and a scale that proved too slow becomes a ceiling.
  Below 45% it drops frames instead of resolution. Fine filaments fade with `uDetail` at low resolutions to avoid
  shimmering. `EventHorizon.space.stats()` shows the current state. Headless Edge throttles rAF to 1 fps, so test this logic
  by calling `frame(now)` with synthetic timestamps. The disk texture uses two
  time-offset layers that cross-fade every 24 s, so differential rotation never winds it into noise.
- **No-WebGL fallback**: `#space.fallback` shows `assets/blackhole-{wide,tall}.jpg`, stills rendered from the real shader
  via `Space.create(canvas, {scale: 1})` in headless Edge. Re-render them if the shader's look changes. LibreWolf and other
  hardened Firefox builds disable WebGL by default (`webgl.disabled`).
- Session state (current track, position, volume, shuffle, repeat, mono, rain, scene, recShape) lives in `localStorage['eventHorizon.session']`.

- **The view is the body, not the window.** `body` is a size container: use container queries (`@container view`) and
  cq units/percentages, never media queries on width/height or vw/vh. Recording lays the site out in a frame
  (`body.framed`); JS that needs the view size must read the body when framed (see `viewSize()` in space.js/rain.js).
- Recording (`V`): tab capture cropped to the frame on a canvas + Web Audio tap (`recTap`, before the volume gain).

## Design rules
- Monochrome only: white on black, with no accent colours. Glass surfaces, thin bright edges, soft glow.
- Fonts: Outfit (UI), Pirata One (artist/brand), JetBrains Mono (labels). They load from Google Fonts with system fallbacks.
- Motion uses `cubic-bezier(.16,1,.3,1)`. Respect `prefers-reduced-motion` (tilt and float are disabled, the shader slows down).
- Don't use third-party brand marks (the reference shows a Spotify logo; we use a format/bitrate badge instead).

## Shortcuts
Space/K play · ←/→ seek 5 s · Shift+←/→ prev/next · ↑/↓ volume · M mute · S shuffle · R repeat ·
C colour art · W rain · B background (Shift+B back) · V record (Shift+V this song) · Q queue · O open files · 0–9 jump to 0–90 % · Esc close queue

## Testing
There is no test suite. Verify by driving headless Edge over the DevTools protocol: set files on `#fileInput` with
`DOM.setFileInputFiles` (use an objectId), then inspect `window.EventHorizon.state` and take screenshots. Call
`Page.bringToFront` and emulate focus, otherwise the page can stay `hidden`: no rAF, and media never loads.
Always launch headless Edge with `--mute-audio` (test tones otherwise play through the user's speakers) and `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist` so WebGL runs on the real GPU (without it, it falls back to SwiftShader on the CPU, and the black hole pins the CPU). To check the rain, load the page without `space.js`/`app.js`, draw `assets/blackhole-wide.jpg` into `#space` as a stand-in scene, and call `frame()` with synthetic timestamps. Generate test media with ffmpeg (`aevalsrc` audio + `-disposition:v attached_pic` for covers).
