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

## Ideas for later
- [ ] Render the rain inside space.js's GL context (removes the Gecko canvas-upload cost)
- [ ] Crossfade/gapless playback, EQ, lyrics (.lrc), playlists, PWA/offline install
- [ ] Ogg comment headers > 6 MB (huge embedded covers) are not read

## Test assets
Generated in the session scratchpad (`media/`): orbit.mp3 (ID3v2.3 + PNG cover), lensing.flac (Vorbis + picture),
photon.m4a (ilst + covr), "03 - Hawking Radiation - Night Drive.wav" (no tags → filename parsing).
Headless note: Edge renders WebGL with SwiftShader (CPU), so the shader is very slow there. That is test-only.
