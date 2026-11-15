# Event Horizon — build plan

Web-based music player inspired by `inspiration/1.mp4`: a monochrome deep-space scene with a
ray-traced black hole on the right, and a floating, 3D-tilted glass "now playing" card
(cover + gothic artist logo, two-line title, progress bar, elapsed/remaining time, prev / play-in-ring / next,
live oscilloscope line with tapered ends).

## Architecture (done)
- [x] `index.html` — markup, SVG icon sprite, card, dock, queue panel, drop overlay
- [x] `css/styles.css` — monochrome glass design, 3D card slabs, responsive and reduced-motion styles
- [x] `js/tags.js` — metadata + cover art: ID3v2.2–2.4/ID3v1, FLAC, Ogg Vorbis/Opus, MP4/M4A
- [x] `js/library.js` — IndexedDB persistence (audio blobs survive reloads)
- [x] `js/space.js` — WebGL Schwarzschild ray tracer (lensed disk, starfield, bass-reactive, adaptive resolution)
- [x] `js/app.js` — playback, Web Audio analyser, queue (reorder/remove/clear), shuffle/repeat,
      drag & drop (files + folders), keyboard shortcuts, Media Session, card tilt and waveform

## Fixed during verification
- [x] Import bug: `fileInput.value = ''` emptied the live FileList before the async import read it → copy to array first
- [x] Stars rendered as streaks (correlated hash) → better hash + per-star jitter
- [x] Disk too dim/thin vs reference → brighter, fuller disk
- [x] Slow GPUs starve the main thread → faster adaptive scaling (min 0.22) + frame skipping

## Completed by subagents
- [x] **Verifier** (app.js / css / html): fixed import stall (media can't load in hidden tabs, so durations are now read lazily
      in the background; tags read 6 at a time with timeouts; 200 files import in about 1.6 s), fixed the invisible card (negative
      frame dt blew up tilt smoothing), fixed stale track info when animations stall, made long artist names fit, and improved the mobile layout.
      Full flow verified: import → autoplay → pause/next/prev → queue remove/reorder → shuffle/repeat → reload persistence → mobile.
- [x] **Shader artist** (space.js): detailed Gargantua-style disk (filaments, dust lanes, Doppler asymmetry), photon rings,
      textured lensed arcs, glow, varied starfield with glints; 4.6–6.9 ms/frame on a GTX 1660 Super.
- [x] **Tag-parser tester** (tags.js): 49 fixtures + 3,000-run fuzz pass; fixed truncated-picture/comment bugs, null on garbage,
      added WAV/AIFF tags and ID3-prefixed containers.
- [x] Main agent: artist glow clipping fix, one-line title balance, fitArtist padding, CLAUDE.md

## Round 3 — realism + rain (done)
- [x] **Realism** (space.js): render-to-texture + bloom/halation chain, lens softness, film grain, faint highlight streak,
      `setRain()` fog, context-loss handling; stills re-rendered. About +10% GPU cost.
- [x] **Rain** (rain.js + UI): refractive drops (5 bead layers, sliding drops with trails), card/dock-aware masking, W toggle,
      persisted, fade in/out, reduced-motion static. Gecko canvas upload is slow, so drop images refresh every 50–100 ms there.
- [x] Fixes: no-WebGL fallback is now a real shader still + notice; adaptive resolution with hysteresis and vsync awareness;
      the play button ring no longer clips in Gecko (hover effects stay inside the box); mobile dock overflow.
- [x] GitHub repo (all rights reserved), README, GitHub Pages.

## Round 4 — realistic rain (done)
- [x] Tried rain on the card only, then reverted: drops land anywhere on the screen again (`#rain` full-screen overlay).
- [x] Drops no longer appear out of nowhere. The rain itself is simulated:
      - falling rain: motion-blurred, wind-slanted streaks in four depth layers, lit by what is behind them (bright in
        front of the disk, faint against black space), hidden behind the card and dock;
      - impacts: each drop flies in as a soft out-of-focus raindrop, hits the glass, spreads flat, pulls back into a
        bead and throws a few spray droplets (spray and trails are the only source of small droplets);
      - on the glass: drops merge, heavy ones break loose and slide in stick-slip steps, swallow what they meet and leave
        sparse trails that dry fast; when the rain stops (W) the streaks fade and the glass dries.
- [x] Rendering: CPU drop simulation (spatial grid) → half-float metaball water field (touching drops flow together)
      → lens shading that refracts a half-res snapshot of what is behind the glass (scene canvas + vignette + canvas-2D
      replica of the card face and dock), inverted and minified, with dark rim, caustic and glint.
- [x] Switching rain on starts from dry glass (no pre-filled drops); reduced motion gets a still, wet pane with no falling rain.
- [x] Scene is no longer fogged by rain (`space.setRain` kept but unused).
- [ ] Check by eye on a real GPU in Chromium and Firefox (motion was checked frame by frame headless, not live).
- [ ] Tune if needed: rain rate (`RATE`), streak density/brightness, wind (`SLANT`), slide threshold (`SLIDE`).

## Round 5 — rain that belongs in the scene (done)
- [x] Less linear motion: every rain column falls at its own speed and sways; gusting wind (`windAt`) shears the
      field over time and sets the slant of incoming drops. Sliding drops steer towards water ahead of them, jog
      sideways when they swallow a drop, and get random lateral kicks, so paths zigzag.
- [x] Rain sticks to the player: the card has its own wet surface (`#rainCard` inside `.face`, own sim + GL context).
      Impacts inside the card land on it (plus extra rain the card catches itself), so its drops tilt and float with
      the card, run down it, and hang from its bottom edge until heavy enough to drip off.
- [x] No more "translucent PNG" look: streaks are falling lenses that refract and brighten the light behind them
      (bright over the disk, nearly invisible on black space); drifting mist sheets lit only by nearby light; drop rims
      reflect the brightest surrounding light instead of a fixed lamp; caustics take their brightness from below;
      the scene gets a light wet-glass haze again (`space.setRain(0.35)`).
- [ ] Check live on a real GPU (Chromium + Firefox): motion, card drops during tilt, the hanging-edge row, the haze level.
- [ ] Possible next steps: drips falling off the card's edge as visible drops; mist density tied to the music energy.

## Round 6 — fixes, rougher drops, backgrounds (done)
- [x] Cover no longer flashes colour on track change: the swap animation's `filter: blur()` replaced the CSS grayscale
      while it ran, then the 0.8 s filter transition crawled back to grey. The keyframes now include the grayscale.
- [x] Play ring glow cut off flat at top and bottom (Gecko clips layers inside the tilted card to their box): the
      controls row is padded to hold the glow, with negative margins and pointer-events so layout and seeking are unchanged.
- [x] Drop outlines are no longer perfect curves: per-drop 2nd/3rd angular harmonics (seeded, stronger for bigger drops)
      plus a static glass micro-texture that pins the waterline into a ragged edge.
- [x] Card friction: drops on the card need more weight to move, accelerate less, snag more and creep (max 55 px/s), and
      run off the bottom edge instead of collecting in a row there.
- [x] Backgrounds (B / dock button, Shift+B backwards, persisted): Event Horizon (black hole), Lonely Mountain (moonlit peak,
      layered ranges with valley mist, Milky Way, pine ridge, shooting stars), Moonlit Sea (waves, moon road, silver-edged
      clouds), Deep Field (domain-warped gas, dust lanes, a star with diffraction spikes). Same output format as the black
      hole, so bloom, grain, rain fog and the rain overlay work on all of them. Programs compile in the background
      (KHR_parallel_shader_compile; old scene stays up until ready, others pre-compiled 4 s after start), and the canvas
      dips to black during the switch. Measured on a GTX 1660 Super: no main-thread frame over 1 ms while switching.
- [ ] Check by eye: the play ring in Firefox/LibreWolf; the wet-glass haze level (`space.setRain(0.35)`) on the lighter scenes.
- [ ] No-WebGL fallback still shows the black-hole still for every scene (the B button is hidden there).
- [ ] Ideas: more scenes (desert dunes, aurora over ice), per-scene rain tint/density.

## Round 7 — drop shapes, drips, a real mountain (done)
- [x] Less uniform drops: each drop has its own irregularity (near-round beads to lumpy blobs), aspect and tilt;
      outlines use angular harmonics 2–5; resting water sags wider at the bottom; impacts and coalescing next to a resting
      drop leave lobes (up to 3) that slowly pull in, and a drop that starts to run gathers its lobes.
- [x] Drips: water reaching the card's bottom edge no longer vanishes into it. It moves to the window layer, hangs under
      the edge (following the card as it sways) and swells for 0.4–1.8 s (others arriving join it and make it let go
      sooner), then falls under gravity, stretching as it speeds up, and leaves the screen.
- [x] Lonely Mountain rewritten as a ray-marched 3D heightfield: eroded fBm (analytic-derivative value noise) on one tall,
      sharp summit with a shoulder, a calm valley floor and low far ranges; side moonlight with soft self-shadows (the
      moon is drawn upper-left, lit from the side so the faces we see aren't all backlit), slope/height-based snow on
      dark rock, ice sparkle, distance haze and height mist.
- [x] Meteors redone: rare (a ~0.7 s event in some 23 s windows), a thin anti-aliased trail tapering behind a small bright
      head, fading in and out.
- [ ] Check live: drip hang/fall look (verified by numbers, not seen in a frame), mountain GPU cost on weaker GPUs
      (the adaptive resolution should absorb it), meteor frequency.

## Round 8 — recording (done)
- [x] Record button in the dock (V; Shift+V = this song from the start) opens a picker: 16:9, 9:16, 1:1, 4:5, 21:9 or
      Window. Choosing a shape previews it live: the whole site re-lays itself out inside a frame of that shape.
- [x] Frame mode: `body` is the size container (`container: view / size`); media queries became container queries and
      vw/vh became cq units/percentages; `body.framed` is fixed to the frame with `contain: layout paint` so every fixed
      layer sizes to it; space.js and rain.js size themselves from the body when framed (rain rects are frame-relative).
- [x] Capture: getDisplayMedia of this tab (preferCurrentTab), each captured frame cropped to the frame and scaled on a
      canvas to the shape's size (1920×1080, 1080×1920, 1080×1080, 1080×1350, 2560×1080; Window = as captured),
      audio from the Web Audio graph before the volume (clean, unaffected by volume/mute). MP4 (H.264/AAC) where
      MediaRecorder supports it, otherwise WebM. 20 Mb/s video, 256 kb/s audio. Saved as "Artist - Title 9x16 (date).mp4".
- [x] While recording: dock, toasts, picker and cursor hidden instantly; the tab title shows a red dot. Stops with V,
      the song's end (song mode), or the browser's "Stop sharing".
- [x] Verified headless (GPU, muted): a 9:16 recording came out 1080×1920 @ 60 fps H.264 + AAC with audible audio.
- [ ] Check in a real browser: the tab-picker dialog flow, Firefox (no preferCurrentTab: pick the tab manually; WebM),
      sharpness when the window is small (the frame is upscaled to the output size; fullscreen helps).

## Ideas for later
- [ ] Crossfade/gapless playback, EQ, lyrics (.lrc), playlists, PWA/offline install
- [ ] Ogg comment headers > 6 MB (huge embedded covers) are not read

## Test assets
Generated in the session scratchpad (`media/`): orbit.mp3 (ID3v2.3 + PNG cover), lensing.flac (Vorbis + picture),
photon.m4a (ilst + covr), "03 - Hawking Radiation - Night Drive.wav" (no tags → filename parsing).
Headless note: Edge renders WebGL with SwiftShader (CPU), so the shader is very slow there. That is test-only.
