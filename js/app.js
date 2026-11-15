/* Event Horizon — app controller.
 * Wires the <audio> element, Web Audio analyser, queue, persistence, UI and the
 * WebGL backdrop together. Plain script (no modules) so index.html works from file://.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ DOM */
  const $ = (s, r = document) => r.querySelector(s);
  const body = document.body;
  const root = document.documentElement;
  const audio = $('#audio');
  const el = {
    card: $('#card'), face: $('#face'), cover: $('#cover'), coverImg: $('#coverImg'),
    artist: $('#artist'), title: $('#title'), album: $('#album'), badge: $('#badgeText'),
    progress: $('#progress'), rail: $('#rail'), tip: $('#tip'),
    elapsed: $('#elapsed'), remaining: $('#remaining'),
    play: $('#play'), prev: $('#prev'), next: $('#next'), wave: $('#wave'),
    addBtn: $('#addBtn'), folderBtn: $('#folderBtn'), shuffle: $('#shuffle'), repeat: $('#repeat'),
    mute: $('#mute'), volume: $('#volume'), mono: $('#mono'), queueBtn: $('#queueBtn'),
    queue: $('#queue'), qList: $('#qList'), qMeta: $('#qMeta'), qAdd: $('#qAdd'), qClear: $('#qClear'), qClose: $('#qClose'),
    toast: $('#toast'), rain: $('#rain'), rainBtn: $('#rainBtn'), sceneBtn: $('#sceneBtn'), recBtn: $('#recBtn'), recMenu: $('#recMenu'), recNow: $('#recNow'), recSong: $('#recSong'), dock: $('.dock'), fileInput: $('#fileInput'), folderInput: $('#folderInput'), space: $('#space'),
  };

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|weba|webm|mp4|aif|aiff|caf)$/i;
  const MINUS = '−';
  const SESSION_KEY = 'eventHorizon.session';

  /* ------------------------------------------------------------------ State */
  const session = readSession();
  const state = {
    tracks: [],
    index: -1,
    shuffle: !!session.shuffle,
    shuffleOrder: [],
    repeat: ['off', 'all', 'one'].includes(session.repeat) ? session.repeat : 'off',
    volume: typeof session.volume === 'number' ? session.volume : 0.85,
    muted: !!session.muted,
    mono: session.mono !== false,
    rain: !!session.rain,
    scene: typeof session.scene === 'string' ? session.scene : 'horizon',
  };

  /* ------------------------------------------------------------------ Utils */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const current = () => state.tracks[state.index] || null;
  const hasTrack = () => !!current();

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }
  function fmtLong(s) {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? h + ' h ' + m + ' min' : m + ' min';
  }
  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || {}; } catch { return {}; }
  }
  function saveSession() {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        id: current() ? current().id : null,
        time: audio.currentTime || 0,
        volume: state.volume, muted: state.muted,
        shuffle: state.shuffle, repeat: state.repeat, mono: state.mono, rain: state.rain, scene: state.scene, recShape: state.recShape,
      }));
    } catch { /* storage full or blocked */ }
  }

  let toastTimer = 0;
  function toast(msg, ms = 2400) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  /* ------------------------------------------------------------------ Generated artwork
   * Tracks without embedded art get a deterministic little black hole of their own. */
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const coverCache = new Map();
  function genCover(seed) {
    if (coverCache.has(seed)) return coverCache.get(seed);
    const S = 480;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const r = rng(hashStr(seed));
    g.fillStyle = '#040404';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 160; i++) {
      g.fillStyle = 'rgba(255,255,255,' + (r() * 0.75).toFixed(3) + ')';
      const s = r() < 0.9 ? 1 : 2;
      g.fillRect(r() * S, r() * S, s, s);
    }
    const cx = S * (0.36 + r() * 0.28), cy = S * (0.4 + r() * 0.2), R = S * (0.1 + r() * 0.07);
    const tilt = (r() - 0.5) * 1.1, squash = 0.16 + r() * 0.22;
    const rings = [];
    for (let i = 0; i < 170; i++) {
      const rr = R * (1.3 + Math.pow(r(), 1.7) * 2.6);
      rings.push({ rr, a: (0.025 + r() * 0.08) * (R * 1.6 / rr + 0.25), w: r() * 1.8 + 0.4 });
    }
    g.save();
    g.translate(cx, cy);
    g.rotate(tilt);
    g.globalCompositeOperation = 'lighter';
    const drawDisk = () => rings.forEach((k) => {
      g.strokeStyle = 'rgba(255,255,255,' + k.a.toFixed(3) + ')';
      g.lineWidth = k.w;
      g.beginPath();
      g.ellipse(0, 0, k.rr, k.rr * squash, 0, 0, Math.PI * 2);
      g.stroke();
    });
    drawDisk();
    for (let i = 0; i < 70; i++) { // lensed halo
      const rr = R * (1.04 + Math.pow(r(), 2) * 0.55);
      g.strokeStyle = 'rgba(255,255,255,' + (0.03 + r() * 0.09).toFixed(3) + ')';
      g.lineWidth = r() * 1.6 + 0.3;
      g.beginPath();
      g.ellipse(0, 0, rr, rr * (0.9 + r() * 0.1), 0, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.beginPath();
    g.arc(0, 0, R, 0, Math.PI * 2);
    g.fill();
    g.beginPath(); // the near side of the disk passes in front of the shadow
    g.rect(-S * 2, 0, S * 4, S * 2);
    g.clip();
    g.globalCompositeOperation = 'lighter';
    drawDisk();
    g.restore();
    const url = c.toDataURL('image/jpeg', 0.88);
    coverCache.set(seed, url);
    return url;
  }
  const DEFAULT_COVER = genCover('event-horizon');

  /* ------------------------------------------------------------------ Audio graph */
  let actx = null, analyser = null, gain = null, timeBuf = null, freqBuf = null, recTap = null;
  let rec = null;   // the running recording (see Recording below)
  function ensureGraph() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      actx = new AC();
      const src = actx.createMediaElementSource(audio);
      analyser = actx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.78;
      gain = actx.createGain();
      src.connect(analyser);
      analyser.connect(gain);
      gain.connect(actx.destination);
      // Tap for the recorder: the signal before the volume control, so recordings are clean and full level
      // whatever the volume or mute state.
      if (actx.createMediaStreamDestination) { recTap = actx.createMediaStreamDestination(); analyser.connect(recTap); }
      timeBuf = new Float32Array(analyser.fftSize);
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
      audio.volume = 1;
      applyVolume();
    } catch (err) {
      console.warn('[audio] Web Audio unavailable, visualiser disabled', err);
      actx = null; analyser = null; gain = null;
    }
  }

  function applyVolume() {
    const v = state.muted ? 0 : state.volume;
    const perceptual = v * v;
    if (gain && actx) gain.gain.setTargetAtTime(perceptual, actx.currentTime, 0.015);
    else audio.volume = perceptual;
    el.volume.value = state.volume;
    el.volume.style.setProperty('--v', state.muted ? 0 : state.volume);
    el.mute.querySelector('use').setAttribute('href', v === 0 ? '#i-mute' : '#i-volume');
    el.mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
  }
  function setVolume(v) {
    state.volume = clamp(Math.round(v * 100) / 100, 0, 1);
    state.muted = state.volume === 0;
    applyVolume();
    saveSession();
  }
  function toggleMute() {
    if (state.muted && state.volume === 0) state.volume = 0.6;
    state.muted = !state.muted;
    applyVolume();
    saveSession();
  }

  /* ------------------------------------------------------------------ Importing */
  function guessFromName(name) {
    let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    base = base.replace(/^\d{1,3}\s*[-.)]\s*/, '');
    const parts = base.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
    return { artist: '', title: base };
  }

  const MIME_BY_EXT = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac',
    flac: 'audio/flac', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    opus: 'audio/ogg; codecs=opus', weba: 'audio/webm', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf',
  };
  // Cheap, synchronous support check. Decoding failures are still caught at playback time.
  function playable(f) {
    const m = f.name.match(/\.([^.]+)$/);
    const types = [f.type, m && MIME_BY_EXT[m[1].toLowerCase()]].filter(Boolean);
    return !types.length || types.some((t) => audio.canPlayType(t) !== '');
  }
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

  /* Durations are probed in the background, a couple at a time, with a hard timeout, so a slow or
   * stuck file never blocks the import. Browsers defer media loading in hidden tabs, so probing
   * pauses while the page is hidden and resumes when it becomes visible again. */
  function probeDuration(blob, ms = 10000) {
    return new Promise((resolve) => {
      const a = new Audio();
      const url = URL.createObjectURL(blob);
      let done = false, timer = 0;
      const finish = (d) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        a.onloadedmetadata = a.ontimeupdate = a.ondurationchange = a.onerror = null;
        a.removeAttribute('src');
        a.load();
        resolve(d);
      };
      a.preload = 'metadata';
      a.onloadedmetadata = () => {
        if (a.duration === Infinity) { // some webm/ogg files: force a seek to learn the length
          a.ondurationchange = a.ontimeupdate = () => { if (isFinite(a.duration)) finish(a.duration); };
          a.currentTime = 1e7;
        } else finish(a.duration);
      };
      a.onerror = () => finish(-1);
      timer = setTimeout(() => finish(NaN), ms);
      a.src = url;
    });
  }

  const durationQueue = [];
  const probeTries = new WeakMap();
  let probing = 0;
  function queueDuration(t) {
    if (t.duration > 0) return;
    durationQueue.push(t);
    pumpDurations();
  }
  function pumpDurations() {
    while (probing < 2 && durationQueue.length && document.visibilityState !== 'hidden') {
      const t = durationQueue.shift();
      if (t.duration > 0 || !state.tracks.includes(t)) continue;
      probing++;
      probeTries.set(t, (probeTries.get(t) || 0) + 1);
      probeDuration(t.file).then((d) => {
        probing--;
        if (d > 0 && isFinite(d)) setDuration(t, d);
        else if (Number.isNaN(d) && probeTries.get(t) < 3) durationQueue.push(t); // timed out: retry later
        pumpDurations();
      });
    }
  }
  document.addEventListener('visibilitychange', pumpDurations);

  let metaTimer = 0;
  function setDuration(t, d) {
    if (!(d > 0) || !isFinite(d) || Math.abs((t.duration || 0) - d) < 0.5) return;
    t.duration = d;
    const row = el.qList.querySelector('.q-item[data-id="' + t.id + '"] .q-dur');
    if (row) row.textContent = fmt(d);
    clearTimeout(metaTimer);
    metaTimer = setTimeout(renderQueueMeta, 150);
    if (t === current()) el.badge.textContent = badgeText(t);
    if (state.tracks.includes(t)) Library.put(record(t)).catch(persistFail);
  }

  function hydrate(t) {
    t.coverURL = t.cover ? URL.createObjectURL(t.cover) : genCover(t.title + '|' + t.artist);
    return t;
  }
  function record(t) {
    const { coverURL, ...rec } = t;
    return rec;
  }
  let persistWarned = false;
  function persistFail(err) {
    console.warn('[library] persistence failed', err);
    if (!persistWarned) {
      persistWarned = true;
      toast('Browser storage is full or blocked: new tracks will only last this session', 4200);
    }
  }

  let importing = Promise.resolve();
  function addFiles(list) {
    // Copy now: a live FileList is emptied as soon as its <input> is reset.
    const files = Array.from(list || []);
    importing = importing.then(() => importFiles(files)).catch((err) => console.error(err));
    return importing;
  }

  async function importFiles(list) {
    const files = [...list]
      .filter((f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name))
      .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
    if (!files.length) { toast('No audio files found there'); return; }

    const startEmpty = !hasTrack();
    const seen = new Set(state.tracks.map((t) => t.name + '|' + t.size));
    let added = 0, dupes = 0, failed = 0, done = 0;
    const maxOrder = state.tracks.reduce((m, t) => Math.max(m, t.order || 0), 0);
    const progress = () => { if (files.length > 1) toast('Pulling in ' + files.length + ' tracks… ' + done + '/' + files.length, 60000); };
    progress();

    // Tags are read a few files at a time; each read has its own timeout so one bad file can't stall the rest.
    const CHUNK = 6;
    for (let i = 0; i < files.length; i += CHUNK) {
      const chunk = files.slice(i, i + CHUNK).filter((f) => {
        const key = f.name + '|' + f.size;
        if (seen.has(key)) { dupes++; return false; }
        if (!playable(f)) { failed++; return false; }
        seen.add(key);
        return true;
      });
      const metas = await Promise.all(chunk.map((f) => withTimeout(Tags.read(f).catch(() => null), 8000, null)));
      const batch = chunk.map((f, j) => {
        const meta = metas[j];
        const guess = guessFromName(f.name);
        return hydrate({
          id: uid(),
          name: f.name,
          size: f.size,
          type: f.type || '',
          file: f,
          title: (meta && meta.title) || guess.title || f.name,
          artist: (meta && meta.artist) || guess.artist || 'Unknown artist',
          album: (meta && meta.album) || '',
          cover: (meta && meta.picture) || null,
          duration: 0, // filled in by the background prober (or by playback)
          order: maxOrder + added + j + 1,
          addedAt: Date.now(),
        });
      });
      done = Math.min(files.length, i + CHUNK);
      if (batch.length) {
        for (const t of batch) {
          state.tracks.push(t);
          if (state.shuffle) state.shuffleOrder.splice(1 + Math.floor(Math.random() * state.shuffleOrder.length), 0, t.id);
        }
        added += batch.length;
        Library.putMany(batch.map(record)).catch(persistFail);
        renderQueue();
        if (startEmpty && !hasTrack()) load(state.tracks.indexOf(batch[0]), { autoplay: true });
        else if (current()) el.next.disabled = state.tracks.length < 2 && state.repeat === 'off';
        batch.forEach(queueDuration);
      }
      if (done < files.length) progress();
    }

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    const bits = [];
    if (added) bits.push('Added ' + added + ' track' + (added > 1 ? 's' : ''));
    if (dupes) bits.push(dupes + ' already in queue');
    if (failed) bits.push(failed + ' unsupported');
    toast(bits.join(' · ') || 'Nothing new to add', failed ? 4200 : 2400);
  }

  async function filesFromDrop(dt) {
    // Grab entries synchronously: DataTransfer is emptied once the event returns.
    const entries = [...(dt.items || [])]
      .map((i) => (i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!entries.length) return [...dt.files];
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e).catch((err) => console.warn(err));
    return out;
  }

  const openPicker = () => el.fileInput.click();
  const openFolder = () => el.folderInput.click();

  /* ------------------------------------------------------------------ Playback */
  let objectURL = null;
  let errorStreak = 0;

  function load(i, { autoplay = true, at = 0, dir = 1 } = {}) {
    const t = state.tracks[i];
    if (!t) return;
    state.index = i;
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = URL.createObjectURL(t.file);
    audio.src = objectURL;
    if (at > 0) {
      audio.addEventListener('loadedmetadata', () => {
        if (at < audio.duration - 1) audio.currentTime = at;
      }, { once: true });
    }
    showTrack(t, dir);
    markCurrent();
    if (autoplay) play();
    else setPlaying(false);
    saveSession();
  }

  async function play() {
    if (!hasTrack()) { openPicker(); return; }
    ensureGraph();
    try {
      if (actx && actx.state === 'suspended') await actx.resume();
      await audio.play();
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('[audio] play failed', err);
    }
  }
  function togglePlay() {
    if (!hasTrack()) return openPicker();
    if (audio.paused) play(); else audio.pause();
  }

  function sequence() {
    return state.shuffle ? state.shuffleOrder : state.tracks.map((t) => t.id);
  }
  function buildShuffle() {
    const ids = state.tracks.map((t) => t.id).filter((id) => !current() || id !== current().id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    state.shuffleOrder = current() ? [current().id, ...ids] : ids;
  }

  function step(dir, auto = false) {
    if (!state.tracks.length) return;
    const seq = sequence();
    const pos = current() ? seq.indexOf(current().id) : -1;
    let np = pos + dir;
    if (np >= seq.length) {
      if (auto && state.repeat === 'off') {
        audio.pause();
        const first = state.tracks.findIndex((t) => t.id === seq[0]);
        load(first, { autoplay: false });
        return;
      }
      if (state.shuffle && auto) { buildShuffle(); np = 1 % Math.max(1, state.shuffleOrder.length); }
      else np = 0;
    }
    if (np < 0) np = seq.length - 1;
    const id = sequence()[np];
    load(state.tracks.findIndex((t) => t.id === id), { autoplay: true, dir });
  }
  function prev() {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    step(-1);
  }
  function seekBy(sec) {
    if (!hasTrack() || !isFinite(audio.duration)) return;
    audio.currentTime = clamp(audio.currentTime + sec, 0, audio.duration - 0.05);
  }

  function setPlaying(on) {
    body.classList.toggle('playing', on);
    el.play.setAttribute('aria-label', on ? 'Pause (Space)' : 'Play (Space)');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
    const t = current();
    document.title = t ? (on ? '▶ ' : '') + t.title + ' · ' + t.artist : 'Event Horizon';
    if (rec) { rec.title = document.title; updateRecTitle(); }
    wake();
  }

  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => { setPlaying(false); saveSession(); });
  audio.addEventListener('playing', () => { errorStreak = 0; });
  audio.addEventListener('ended', () => {
    if (rec && rec.song) stopRecording();   // "record this song" ends with the song
    if (state.repeat === 'one') { audio.currentTime = 0; play(); return; }
    step(1, true);
  });
  audio.addEventListener('error', () => {
    const t = current();
    if (!t || !audio.getAttribute('src')) return;
    errorStreak++;
    toast('Can’t play “' + t.title + '” in this browser', 3600);
    if (errorStreak < state.tracks.length) setTimeout(() => step(1, true), 900);
  });
  audio.addEventListener('loadedmetadata', () => {
    if (current() && isFinite(audio.duration)) setDuration(current(), audio.duration);
    el.progress.setAttribute('aria-valuemax', String(Math.round(audio.duration || 0)));
    updatePositionState();
  });
  audio.addEventListener('seeked', updatePositionState);
  audio.addEventListener('ratechange', updatePositionState);

  /* ------------------------------------------------------------------ Now-playing UI */
  let swapToken = 0;
  let firstShow = true;
  function badgeText(t) {
    const m = t.name.match(/\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toUpperCase() : 'AUDIO';
    const kbps = t.duration > 0 ? Math.round((t.size * 8) / t.duration / 1000) : 0;
    return kbps ? ext + ' · ' + kbps + ' kbps' : ext;
  }

  function applyTrack(t) {
    el.coverImg.src = t.coverURL;
    el.title.textContent = t.title;
    el.title.title = t.title;
    el.artist.textContent = t.artist;
    el.album.textContent = t.album || ' ';
    el.badge.textContent = badgeText(t);
    el.prev.disabled = false;
    el.next.disabled = state.tracks.length < 2 && state.repeat === 'off';
    el.cover.setAttribute('aria-label', 'Add music');
    fitArtist();
  }

  function showTrack(t, dir = 1) {
    body.classList.remove('empty');
    const token = ++swapToken;
    updateMediaSession(t); // OS media controls must update even if the swap animation is delayed
    // Hidden tabs don't advance animations, so swap instantly there (and on first show / reduced motion).
    if (firstShow || reduced || document.hidden) { firstShow = false; applyTrack(t); return; }
    const targets = [el.coverImg, el.title, el.artist, el.album];
    const dx = 16 * dir;
    // The animated filter replaces the cover's CSS grayscale while it runs; keep it in the keyframes, or the new
    // cover shows in colour and then crawls to grey through the CSS filter transition.
    const base = (n) => (n === el.coverImg && !body.classList.contains('color-art') ? 'grayscale(1) contrast(1.12) ' : '');
    const fadeOut = Promise.all(targets.map((n) => n.animate(
      [{ opacity: 1, filter: base(n) + 'blur(0px)', transform: 'none' }, { opacity: 0, filter: base(n) + 'blur(8px)', transform: 'translateX(' + -dx + 'px)' }],
      { duration: 200, easing: 'cubic-bezier(.7,0,.84,0)', fill: 'forwards' }).finished.catch(() => {})
    ));
    // Never let a stalled animation keep stale track info on screen.
    Promise.race([fadeOut, new Promise((r) => setTimeout(r, 320))]).then(() => {
      if (token !== swapToken) return;
      applyTrack(t);
      targets.forEach((n, i) => {
        n.getAnimations().forEach((a) => a.cancel());
        n.animate(
          [{ opacity: 0, filter: base(n) + 'blur(8px)', transform: 'translateX(' + dx + 'px)' }, { opacity: 1, filter: base(n) + 'blur(0px)', transform: 'none' }],
          { duration: 520, delay: i * 45, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards' });
      });
    });
  }

  function showEmpty() {
    body.classList.add('empty');
    el.coverImg.src = DEFAULT_COVER;
    el.title.textContent = 'Drop music into the void';
    el.title.title = '';
    el.artist.textContent = 'Event Horizon';
    el.album.textContent = 'MP3 · FLAC · M4A · WAV · OGG';
    el.badge.textContent = 'No signal';
    el.prev.disabled = true;
    el.next.disabled = true;
    el.progress.style.setProperty('--p', 0);
    el.elapsed.textContent = '0:00';
    el.remaining.textContent = '0:00';
    document.title = 'Event Horizon';
    fitArtist();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }

  // Shrink the gothic artist logo to fit on one line (scrollWidth is rounded, so keep a 2px margin
  // or the ellipsis kicks in on sub-pixel overflow). Very long names wrap onto two lines instead.
  function fitArtist() {
    const a = el.artist;
    const cs = getComputedStyle(a);
    const avail = a.parentElement.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    a.classList.remove('wrap');
    a.style.fontSize = '';
    if (avail <= 0) return;
    const range = document.createRange();
    range.selectNodeContents(a);
    const over = () => {
      if (a.classList.contains('wrap')) return a.scrollHeight > a.clientHeight + 2;
      // Measure the real text width (scrollWidth is rounded and never below clientWidth); undo the card's 3D scale.
      const scale = a.offsetWidth ? a.getBoundingClientRect().width / a.offsetWidth : 1;
      return range.getBoundingClientRect().width / (scale || 1) > avail - 1;
    };
    a.classList.remove('wrap');
    a.style.fontSize = '';
    const base = parseFloat(getComputedStyle(a).fontSize);
    let size = base;
    while (over() && size > Math.max(17, base * 0.66)) { size -= 1; a.style.fontSize = size + 'px'; }
    if (!over()) return;
    a.classList.add('wrap');
    size = Math.round(base * 0.8);
    a.style.fontSize = size + 'px';
    while (over() && size > 15) { size -= 1; a.style.fontSize = size + 'px'; }
  }

  function resetToEmpty() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (objectURL) { URL.revokeObjectURL(objectURL); objectURL = null; }
    state.index = -1;
    setPlaying(false);
    showEmpty();
    saveSession();
  }

  /* ------------------------------------------------------------------ Media Session (OS media keys) */
  function updateMediaSession(t) {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album || 'Event Horizon',
        artwork: [{ src: t.coverURL, sizes: '512x512', type: (t.cover && t.cover.type) || 'image/jpeg' }],
      });
    } catch { /* ignore */ }
  }
  function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: clamp(audio.currentTime, 0, audio.duration),
      });
    } catch { /* ignore */ }
  }
  if ('mediaSession' in navigator) {
    const h = {
      play: () => play(),
      pause: () => audio.pause(),
      previoustrack: () => prev(),
      nexttrack: () => step(1),
      seekbackward: (d) => seekBy(-(d.seekOffset || 10)),
      seekforward: (d) => seekBy(d.seekOffset || 10),
      seekto: (d) => { if (isFinite(d.seekTime)) audio.currentTime = d.seekTime; },
    };
    for (const k in h) { try { navigator.mediaSession.setActionHandler(k, h[k]); } catch { /* unsupported */ } }
  }

  /* ------------------------------------------------------------------ Queue */
  function renderQueueMeta() {
    const n = state.tracks.length;
    const total = state.tracks.reduce((s, t) => s + (t.duration > 0 && isFinite(t.duration) ? t.duration : 0), 0);
    el.qMeta.textContent = n ? n + ' track' + (n > 1 ? 's' : '') + (total ? ' · ' + fmtLong(total) : '') : 'Empty';
  }
  function renderQueue() {
    const n = state.tracks.length;
    renderQueueMeta();
    el.queueBtn.dataset.count = n > 99 ? '99+' : String(n);
    if (!n) {
      el.qList.innerHTML = '<li class="q-empty"><strong>Nothing in orbit yet</strong>Drag audio files or folders anywhere on the page, or use the + button.</li>';
      return;
    }
    el.qList.innerHTML = state.tracks.map((t, i) => `
      <li class="q-item${i === state.index ? ' is-current' : ''}" data-id="${t.id}" draggable="true">
        <span class="q-idx"><span class="q-num">${String(i + 1).padStart(2, '0')}</span><span class="eq"><i></i><i></i><i></i></span></span>
        <img class="q-thumb" src="${t.coverURL}" alt="" loading="lazy" draggable="false">
        <span class="q-text"><span class="q-title">${esc(t.title)}</span><span class="q-artist">${esc(t.artist)}</span></span>
        <span class="q-dur">${t.duration > 0 ? fmt(t.duration) : '–:––'}</span>
        <button class="q-remove" type="button" aria-label="Remove ${esc(t.title)}"><svg class="i"><use href="#i-x"/></svg></button>
      </li>`).join('');
  }
  function markCurrent() {
    const id = current() ? current().id : null;
    el.qList.querySelectorAll('.q-item').forEach((li) => li.classList.toggle('is-current', li.dataset.id === id));
    const cur = el.qList.querySelector('.is-current');
    if (cur && body.classList.contains('queue-open')) cur.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }

  function removeTrack(id) {
    const i = state.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = state.tracks.splice(i, 1);
    if (t.cover && t.coverURL) URL.revokeObjectURL(t.coverURL);
    state.shuffleOrder = state.shuffleOrder.filter((x) => x !== id);
    Library.remove(id).catch(() => {});
    if (i === state.index) {
      const wasPlaying = !audio.paused;
      state.index = -1;
      if (state.tracks.length) load(Math.min(i, state.tracks.length - 1), { autoplay: wasPlaying });
      else resetToEmpty();
    } else if (i < state.index) state.index--;
    renderQueue();
    if (current()) el.next.disabled = state.tracks.length < 2 && state.repeat === 'off';
  }

  let clearArmed = 0;
  function clearQueue() {
    if (!state.tracks.length) return;
    if (!clearArmed) {
      el.qClear.classList.add('armed');
      toast('Press again to clear the whole queue');
      clearArmed = setTimeout(() => { clearArmed = 0; el.qClear.classList.remove('armed'); }, 2600);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = 0;
    el.qClear.classList.remove('armed');
    state.tracks.forEach((t) => { if (t.cover && t.coverURL) URL.revokeObjectURL(t.coverURL); });
    state.tracks = [];
    state.shuffleOrder = [];
    Library.clear().catch(() => {});
    resetToEmpty();
    renderQueue();
    toast('Queue cleared');
  }

  function persistOrder() {
    state.tracks.forEach((t, i) => { t.order = i + 1; });
    Library.putMany(state.tracks.map(record)).catch(persistFail);
  }

  function toggleQueue(force) {
    const open = typeof force === 'boolean' ? force : !body.classList.contains('queue-open');
    body.classList.toggle('queue-open', open);
    el.queue.inert = !open;
    el.queueBtn.setAttribute('aria-pressed', String(open));
    if (open) { markCurrent(); wake(); }
  }

  el.qList.addEventListener('click', (e) => {
    const li = e.target.closest('.q-item');
    if (!li) return;
    if (e.target.closest('.q-remove')) { removeTrack(li.dataset.id); return; }
    const i = state.tracks.findIndex((t) => t.id === li.dataset.id);
    if (i === state.index) togglePlay();
    else load(i, { autoplay: true, dir: i > state.index ? 1 : -1 });
  });

  // Drag to reorder
  let dragId = null;
  const clearDropMarks = () => el.qList.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  el.qList.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.q-item');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-event-horizon', dragId);
  });
  el.qList.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const li = e.target.closest('.q-item');
    clearDropMarks();
    if (!li || li.dataset.id === dragId) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  el.qList.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const li = el.qList.querySelector('.drop-before, .drop-after');
    if (li) {
      const curId = current() ? current().id : null;
      const from = state.tracks.findIndex((t) => t.id === dragId);
      const [moved] = state.tracks.splice(from, 1);
      let to = state.tracks.findIndex((t) => t.id === li.dataset.id);
      if (li.classList.contains('drop-after')) to++;
      state.tracks.splice(to, 0, moved);
      state.index = state.tracks.findIndex((t) => t.id === curId);
      persistOrder();
      renderQueue();
    }
    clearDropMarks();
  });
  el.qList.addEventListener('dragend', () => {
    dragId = null;
    clearDropMarks();
    el.qList.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));
  });

  /* ------------------------------------------------------------------ Toggles */
  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    if (state.shuffle) buildShuffle();
    el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
    toast(state.shuffle ? 'Shuffle on' : 'Shuffle off', 1400);
    saveSession();
  }
  function applyRepeat() {
    el.repeat.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    el.repeat.setAttribute('aria-label', 'Repeat: ' + state.repeat);
    el.repeat.querySelector('use').setAttribute('href', state.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
    if (current()) el.next.disabled = state.tracks.length < 2 && state.repeat === 'off';
  }
  function cycleRepeat() {
    state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat];
    applyRepeat();
    toast({ off: 'Repeat off', all: 'Repeat queue', one: 'Repeat this track' }[state.repeat], 1400);
    saveSession();
  }
  function applyMono() {
    body.classList.toggle('color-art', !state.mono);
    el.mono.setAttribute('aria-pressed', String(state.mono));
  }
  function toggleMono() {
    state.mono = !state.mono;
    applyMono();
    toast(state.mono ? 'Monochrome artwork' : 'Full-colour artwork', 1400);
    saveSession();
  }

  /* ------------------------------------------------------------------ Progress / scrubbing */
  const scrub = { active: false, time: 0 };
  const trackDuration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (current() ? current().duration : 0)) || 0;
  function fracAt(clientX) {
    const r = el.rail.getBoundingClientRect();
    return clamp((clientX - r.left) / r.width, 0, 1);
  }
  el.progress.addEventListener('pointerdown', (e) => {
    if (!hasTrack() || e.button !== 0) return;
    scrub.active = true;
    el.progress.classList.add('scrubbing');
    el.progress.setPointerCapture(e.pointerId);
    scrub.time = fracAt(e.clientX) * trackDuration();
  });
  el.progress.addEventListener('pointermove', (e) => {
    const f = fracAt(e.clientX);
    el.progress.style.setProperty('--x', f);
    el.tip.textContent = fmt(f * trackDuration());
    el.progress.classList.add('hovering');
    if (scrub.active) scrub.time = f * trackDuration();
  });
  el.progress.addEventListener('pointerleave', () => el.progress.classList.remove('hovering'));
  const endScrub = () => {
    if (!scrub.active) return;
    scrub.active = false;
    el.progress.classList.remove('scrubbing');
    if (isFinite(scrub.time)) audio.currentTime = scrub.time;
  };
  el.progress.addEventListener('pointerup', endScrub);
  el.progress.addEventListener('pointercancel', endScrub);

  let lastP = -1, lastEl = '', lastRem = '';
  function updateProgress() {
    if (!hasTrack()) return;
    const d = trackDuration();
    const c = scrub.active ? scrub.time : audio.currentTime;
    const p = d > 0 ? clamp(c / d, 0, 1) : 0;
    if (Math.abs(p - lastP) > 0.0003) { el.progress.style.setProperty('--p', p.toFixed(5)); lastP = p; }
    const e = fmt(c), r = (d > 0 ? MINUS : '') + fmt(Math.max(0, d - c));
    if (e !== lastEl) { el.elapsed.textContent = e; lastEl = e; el.progress.setAttribute('aria-valuenow', String(Math.floor(c))); }
    if (r !== lastRem) { el.remaining.textContent = r; lastRem = r; }
  }

  /* ------------------------------------------------------------------ Waveform */
  const wctx = el.wave.getContext('2d');
  const WAVE_N = 240;
  const wavePts = new Float32Array(WAVE_N);
  let waveGrad = null, dpr = 1;
  function sizeWave() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(el.wave.clientWidth * dpr), h = Math.round(el.wave.clientHeight * dpr);
    if (!w || !h) return;
    el.wave.width = w;
    el.wave.height = h;
    waveGrad = wctx.createLinearGradient(0, 0, w, 0);
    waveGrad.addColorStop(0, 'rgba(255,255,255,0)');
    waveGrad.addColorStop(0.18, 'rgba(255,255,255,.95)');
    waveGrad.addColorStop(0.82, 'rgba(255,255,255,.95)');
    waveGrad.addColorStop(1, 'rgba(255,255,255,0)');
  }
  new ResizeObserver(sizeWave).observe(el.wave);

  function drawWave(t) {
    const w = el.wave.width, h = el.wave.height;
    if (!w || !waveGrad) return;
    const live = !!analyser && !audio.paused;
    let start = 0;
    if (live) {
      analyser.getFloatTimeDomainData(timeBuf);
      for (let i = 1; i < 600; i++) { if (timeBuf[i - 1] < 0 && timeBuf[i] >= 0) { start = i; break; } }
    }
    const span = 1100;
    const idleAmp = hasTrack() ? 0.06 : 0.035;
    for (let i = 0; i < WAVE_N; i++) {
      const x = i / (WAVE_N - 1);
      const target = live
        ? timeBuf[start + Math.floor(x * (span - 1))] * 1.7
        : (Math.sin(x * 23 + t * 2.1) * 0.55 + Math.sin(x * 61 - t * 3.4) * 0.3 + Math.sin(x * 140 + t * 5) * 0.15) * idleAmp;
      wavePts[i] += (target - wavePts[i]) * (live ? 0.5 : 0.08);
    }
    wctx.clearRect(0, 0, w, h);
    const mid = h / 2, amp = h * 0.46;
    wctx.beginPath();
    for (let i = 0; i < WAVE_N; i++) {
      const x = i / (WAVE_N - 1);
      const taper = Math.pow(Math.sin(Math.PI * x), 1.5);
      const y = mid + clamp(wavePts[i], -1, 1) * taper * amp;
      if (i) wctx.lineTo(x * w, y); else wctx.moveTo(x * w, y);
    }
    wctx.lineJoin = 'round';
    wctx.lineCap = 'round';
    wctx.strokeStyle = waveGrad;
    wctx.shadowColor = 'rgba(255,255,255,.9)';
    wctx.shadowBlur = 10 * dpr;
    wctx.globalAlpha = 0.35;
    wctx.lineWidth = 3.2 * dpr;
    wctx.stroke();
    wctx.shadowBlur = 0;
    wctx.globalAlpha = 1;
    wctx.lineWidth = 1.35 * dpr;
    wctx.stroke();
  }

  /* ------------------------------------------------------------------ Energy, tilt & frame loop */
  let energy = 0, lastEnergy = -1;
  function readEnergy() {
    let e = 0;
    if (analyser && !audio.paused) {
      analyser.getByteFrequencyData(freqBuf);
      let s = 0;
      for (let i = 1; i < 14; i++) s += freqBuf[i];
      e = clamp((s / (13 * 255) - 0.3) / 0.7, 0, 1);
      e = e * e;
    }
    energy += (e - energy) * (e > energy ? 0.35 : 0.07);
    if (Math.abs(energy - lastEnergy) > 0.008) {
      root.style.setProperty('--energy', energy.toFixed(3));
      lastEnergy = energy;
    }
  }

  const pointer = { x: 0.5, y: 0.5, over: false };
  const tilt = { rx: 4, ry: -6, y: 0 };
  addEventListener('pointermove', (e) => {
    pointer.x = e.clientX / innerWidth;
    pointer.y = e.clientY / innerHeight;
    wake();
  }, { passive: true });
  el.card.addEventListener('pointerenter', () => { pointer.over = true; });
  el.card.addEventListener('pointerleave', () => { pointer.over = false; });

  function updateTilt(t, dt) {
    if (reduced) return;
    if (!scrub.active) {
      const amp = pointer.over ? 0.3 : 1;
      const trx = 3.5 + (0.5 - pointer.y) * 9 * amp + Math.sin(t * 0.63) * 1.6;
      const try_ = -6 + (pointer.x - 0.5) * 16 * amp + Math.sin(t * 0.41) * 3.2;
      const ty = Math.sin(t * 0.9) * 5 - energy * 4;
      const k = 1 - Math.pow(0.002, dt);
      tilt.rx += (trx - tilt.rx) * k;
      tilt.ry += (try_ - tilt.ry) * k;
      tilt.y += (ty - tilt.y) * k;
    }
    el.card.style.transform = 'translate3d(0,' + tilt.y.toFixed(2) + 'px,0) rotateX(' + tilt.rx.toFixed(3) + 'deg) rotateY(' + tilt.ry.toFixed(3) + 'deg)';
    el.face.style.setProperty('--gx', (35 - tilt.ry * 5).toFixed(1) + '%');
    el.face.style.setProperty('--gy', (tilt.rx * 4 - 10).toFixed(1) + '%');
    el.face.style.setProperty('--edge', (125 + tilt.ry * 5).toFixed(1) + 'deg');
  }

  const space = Space.create(el.space);
  if (!space.ok) {
    console.info('[space] WebGL unavailable: showing a still black hole. Enable WebGL (LibreWolf: Settings → LibreWolf → Enable WebGL, or webgl.disabled=false in about:config) for the animated one.');
    try {
      if (!sessionStorage.getItem('eh.webglNotice')) {
        sessionStorage.setItem('eh.webglNotice', '1');
        setTimeout(() => toast('WebGL is off in this browser: showing a still black hole', 5200), 2500);
      }
    } catch { /* storage blocked */ }
  }
  // Rain falling past the window and running down the glass. It refracts the live scene, so it needs the WebGL renderer too.
  const rain = space.ok && window.Rain
    ? Rain.create(el.rain, {
      scene: el.space, face: el.face, dock: el.dock, card: $('#rainCard'),
      quality: () => (space.stats ? space.stats().scale / 0.75 : 1),
    })
    : { ok: false, enabled: false, frame() {}, setEnabled() {} };
  if (!rain.ok) el.rainBtn.hidden = true;
  function applyRain() {
    const on = state.rain && rain.ok;
    rain.setEnabled(on);
    if (space.setRain) space.setRain(on ? 0.35 : 0);   // the scene seen through wet glass: softer, with more halation
    el.rainBtn.setAttribute('aria-pressed', String(on));
  }
  function toggleRain() {
    if (!rain.ok) return;
    state.rain = !state.rain;
    applyRain();
    toast(state.rain ? 'Rain on' : 'Rain off', 1400);
    saveSession();
  }

  // Backgrounds. The canvas dips to black and comes back on the new scene (a new scene compiles on first use,
  // which can take a moment; the dip hides it).
  const SCENES = (window.Space && Space.SCENES) || [{ id: 'horizon', name: 'Event Horizon' }];
  if (!space.ok || SCENES.length < 2) el.sceneBtn.hidden = true;
  if (!SCENES.some((s) => s.id === state.scene)) state.scene = 'horizon';
  if (space.setScene) space.setScene(state.scene);
  let sceneTimer = 0;
  function cycleScene(dir = 1) {
    if (!space.ok) return;
    const i = SCENES.findIndex((s) => s.id === state.scene);
    const next = SCENES[(i + dir + SCENES.length) % SCENES.length];
    state.scene = next.id;
    toast(next.name, 1600);
    saveSession();
    clearTimeout(sceneTimer);
    if (reduced) { space.setScene(next.id); return; }
    el.space.classList.add('scened', 'swap');
    sceneTimer = setTimeout(() => {
      space.setScene(state.scene);
      // Come back once the new scene is actually drawn (it may still be compiling), but never wait forever.
      const t0 = performance.now();
      (function wait() {
        if (space.shownScene === state.scene || performance.now() - t0 > 3000) {
          requestAnimationFrame(() => el.space.classList.remove('swap'));
        } else requestAnimationFrame(wait);
      })();
    }, 420);
  }

  /* ------------------------------------------------------------------ Recording */
  // Records the site as a video in an aspect ratio of choice.
  // The whole site is laid out inside a frame of that shape (body.framed: the body becomes the view that layout,
  // container queries, the scene and the rain size themselves to), the browser captures this tab, and each captured
  // frame is cropped to the frame and scaled to a standard size on a canvas. The audio comes straight from the
  // player's Web Audio graph, before the volume control. The dock button opens a picker (choosing a shape previews
  // it); V starts/stops with the last shape, Shift+V records the current song from the start and stops at its end.
  // While recording the dock, toasts and cursor are hidden and the tab title shows a red dot.
  const SHAPES = {
    window: { label: 'Window', size: null },
    '16:9': { label: '16:9', size: [1920, 1080] },
    '9:16': { label: '9:16', size: [1080, 1920] },
    '1:1': { label: '1:1', size: [1080, 1080] },
    '4:5': { label: '4:5', size: [1080, 1350] },
    '21:9': { label: '21:9', size: [2560, 1080] },
  };
  state.recShape = SHAPES[session.recShape] ? session.recShape : '16:9';
  const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  if (!canRecord) el.recBtn.hidden = true;

  function applyFrame(shape) {
    const s = SHAPES[shape];
    if (!s || !s.size) { clearFrame(); return; }
    const a = s.size[0] / s.size[1];
    const W = innerWidth, H = innerHeight;
    const fw = Math.round(W / H > a ? H * a : W), fh = Math.round(W / H > a ? H : W / a);
    const st = document.body.style;
    st.setProperty('--fw', fw + 'px'); st.setProperty('--fh', fh + 'px');
    st.setProperty('--fx', Math.round((W - fw) / 2) + 'px'); st.setProperty('--fy', Math.round((H - fh) / 2) + 'px');
    body.classList.add('framed');
    dispatchEvent(new Event('resize'));
  }
  function clearFrame() {
    if (!body.classList.contains('framed')) return;
    body.classList.remove('framed');
    dispatchEvent(new Event('resize'));
  }
  // Keep the frame fitted when the window changes size (a real resize, not the ones we dispatch).
  addEventListener('resize', (e) => { if (e.isTrusted && body.classList.contains('framed')) applyFrame(rec ? rec.shape : state.recShape); });

  // ---- picker
  const menu = el.recMenu;
  function renderMenu() {
    menu.querySelectorAll('[data-shape]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.shape === state.recShape)));
    el.recSong.disabled = !hasTrack();
  }
  function openMenu() {
    renderMenu();
    menu.hidden = false;
    const b = el.recBtn.getBoundingClientRect(), v = document.body.getBoundingClientRect();
    const half = Math.min(150, v.width / 2 - 8);      // keep the panel inside the (possibly narrow) frame
    menu.style.width = half * 2 + 'px';
    menu.style.left = Math.round(Math.min(Math.max(b.left + b.width / 2 - v.left, half + 8), v.width - half - 8)) + 'px';
    menu.style.bottom = Math.round(v.bottom - b.top + 12) + 'px';
    applyFrame(state.recShape);                          // preview the composition
    menu.querySelector('[aria-checked="true"]').focus();
  }
  function closeMenu(keepFrame = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (!keepFrame && !rec) clearFrame();
  }
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-shape]');
    if (!b) return;
    state.recShape = b.dataset.shape;
    saveSession();
    renderMenu();
    applyFrame(state.recShape);
    // the menu sits on the dock, which moved with the frame
    openMenu();
  });
  el.recNow.addEventListener('click', () => startRecording(false));
  el.recSong.addEventListener('click', () => startRecording(true));
  addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !el.recBtn.contains(e.target)) closeMenu();
  });

  // ---- recording
  function pickMime() {
    const types = ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4',
      'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }
  function fileName(ext, shape) {
    const t = current();
    const base = t ? (t.artist ? t.artist + ' - ' : '') + t.title : 'Event Horizon';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const tag = shape === 'window' ? '' : ' ' + shape.replace(':', 'x');
    return (base.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'Event Horizon') + tag + ' (' + stamp + ').' + ext;
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  async function startRecording(song = false) {
    if (rec || !canRecord) return;
    if (song && !hasTrack()) { openPicker(); return; }
    const shape = state.recShape;
    closeMenu(true);
    applyFrame(shape);
    await nextFrame(); await nextFrame();                // let the layout, scene and rain settle in the frame
    toast('Choose this tab in the next dialog', 3000);
    let screen;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 }, width: { ideal: 3840 }, height: { ideal: 2160 }, displaySurface: 'browser', cursor: 'never' },
        audio: false,
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', systemAudio: 'exclude',
      });
    } catch (err) {
      clearFrame();
      toast(err && err.name === 'NotAllowedError' ? 'Recording cancelled' : 'Could not start recording', 2400);
      return;
    }
    ensureGraph();
    if (actx && actx.state === 'suspended') { try { await actx.resume(); } catch { /* ignore */ } }

    // Video: the captured tab, cropped to the frame and scaled to the shape's size.
    let video = screen.getVideoTracks()[0], stopDraw = () => {};
    const size = SHAPES[shape].size;
    if (size) {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = screen;
      try { await v.play(); } catch { /* starts on the first frame anyway */ }
      const out = document.createElement('canvas');
      out.width = size[0]; out.height = size[1];
      const g = out.getContext('2d', { alpha: false });
      g.imageSmoothingQuality = 'high';
      let live = true;
      const draw = () => {
        if (!live) return;
        if (v.videoWidth) {
          const f = document.body.getBoundingClientRect();
          const sx = v.videoWidth / innerWidth, sy = v.videoHeight / innerHeight;
          g.drawImage(v, f.left * sx, f.top * sy, f.width * sx, f.height * sy, 0, 0, out.width, out.height);
        }
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(draw); else requestAnimationFrame(draw);
      };
      draw();
      video = out.captureStream(60).getVideoTracks()[0];
      stopDraw = () => { live = false; v.srcObject = null; video.stop(); };
    }
    const tracks = [video];
    if (recTap) tracks.push(...recTap.stream.getAudioTracks());
    const mimeType = pickMime();
    let recorder;
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), { mimeType, videoBitsPerSecond: 20e6, audioBitsPerSecond: 256000 });
    } catch (err) {
      stopDraw();
      screen.getTracks().forEach((t) => t.stop());
      clearFrame();
      toast('This browser can’t record video', 3000);
      return;
    }
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stopDraw();
      screen.getTracks().forEach((t) => t.stop());
      const type = recorder.mimeType || mimeType || 'video/webm';
      const blob = new Blob(chunks, { type });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName(/mp4/.test(type) ? 'mp4' : 'webm', shape);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast('Saved ' + a.download + ' (' + (blob.size / 1048576).toFixed(1) + ' MB)', 4200);
    };
    // "Stop sharing" in the browser's bar ends the recording too.
    screen.getVideoTracks()[0].addEventListener('ended', () => stopRecording());
    rec = { recorder, song, shape, title: document.title };
    body.classList.add('recording');
    el.recBtn.setAttribute('aria-pressed', 'true');
    if (song) {
      // From the very start of the track, after a short beat so the video opens cleanly.
      audio.pause();
      audio.currentTime = 0;
      recorder.start(1000);
      setTimeout(() => { if (rec) play(); }, 700);
    } else recorder.start(1000);
    updateRecTitle();
  }
  function stopRecording() {
    if (!rec) return;
    const r = rec;
    rec = null;
    body.classList.remove('recording');
    el.recBtn.setAttribute('aria-pressed', 'false');
    document.title = r.title;
    if (r.recorder.state !== 'inactive') r.recorder.stop();
    clearFrame();
  }
  function toggleRecording(song = false) { if (rec) stopRecording(); else startRecording(song); }
  function updateRecTitle() {
    if (!rec) return;
    const t = current();
    document.title = '\u{1F534} REC · ' + (t ? t.title : 'Event Horizon');
  }
  el.recBtn.addEventListener('click', () => { if (rec) stopRecording(); else if (menu.hidden) openMenu(); else closeMenu(); });

  let lastNow = performance.now();
  const t0 = lastNow;
  function frame(now) {
    // rAF timestamps can be older than the performance.now() taken at boot: never let dt go negative,
    // or the exponential smoothing in updateTilt() overshoots by orders of magnitude.
    const dt = clamp((now - lastNow) / 1000, 0, 0.05) || 0;
    lastNow = Math.max(lastNow, now);
    const t = (now - t0) / 1000;
    updateProgress();
    readEnergy();
    drawWave(t);
    updateTilt(t, dt);
    space.setEnergy(energy);
    space.setLook((pointer.x - 0.5) * 2, (pointer.y - 0.5) * 2);
    space.frame(now);
    rain.frame(now);   // right after space.frame: the scene canvas is only readable in this task
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ Idle dock */
  let idleTimer = 0;
  function wake() {
    body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!audio.paused && !body.classList.contains('queue-open')) body.classList.add('idle');
    }, 3500);
  }

  /* ------------------------------------------------------------------ Events */
  el.play.addEventListener('click', togglePlay);
  el.prev.addEventListener('click', prev);
  el.next.addEventListener('click', () => step(1));
  el.cover.addEventListener('click', openPicker);
  el.addBtn.addEventListener('click', openPicker);
  el.qAdd.addEventListener('click', openPicker);
  el.folderBtn.addEventListener('click', openFolder);
  el.shuffle.addEventListener('click', toggleShuffle);
  el.repeat.addEventListener('click', cycleRepeat);
  el.mute.addEventListener('click', toggleMute);
  el.mono.addEventListener('click', toggleMono);
  el.rainBtn.addEventListener('click', toggleRain);
  el.sceneBtn.addEventListener('click', (e) => cycleScene(e.shiftKey ? -1 : 1));
  el.queueBtn.addEventListener('click', () => toggleQueue());
  el.qClose.addEventListener('click', () => toggleQueue(false));
  el.qClear.addEventListener('click', clearQueue);
  el.volume.addEventListener('input', () => setVolume(parseFloat(el.volume.value)));

  el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });
  el.folderInput.addEventListener('change', () => { addFiles(el.folderInput.files); el.folderInput.value = ''; });

  // Drag & drop anywhere
  let dragDepth = 0;
  const isFileDrag = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    body.classList.add('dropping');
  });
  addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) body.classList.remove('dropping');
  });
  addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    body.classList.remove('dropping');
    filesFromDrop(e.dataTransfer).then(addFiles);
  });

  // Keyboard
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tgt = e.target;
    if (tgt.closest && tgt.closest('textarea, [contenteditable], input:not([type=range])')) return;
    if (tgt.type === 'range' && /^Arrow/.test(e.key)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (k) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); if (e.shiftKey) step(1); else seekBy(5); break;
      case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) prev(); else seekBy(-5); break;
      case 'ArrowUp': e.preventDefault(); setVolume(state.volume + 0.05); toast('Volume ' + Math.round(state.volume * 100) + '%', 900); break;
      case 'ArrowDown': e.preventDefault(); setVolume(state.volume - 0.05); toast('Volume ' + Math.round(state.volume * 100) + '%', 900); break;
      case 'm': toggleMute(); break;
      case 's': toggleShuffle(); break;
      case 'r': cycleRepeat(); break;
      case 'c': toggleMono(); break;
      case 'w': toggleRain(); break;
      case 'b': cycleScene(e.shiftKey ? -1 : 1); break;
      case 'v': toggleRecording(e.shiftKey); break;
      case 'q': toggleQueue(); break;
      case 'o': openPicker(); break;
      case 'n': step(1); break;
      case 'p': prev(); break;
      case 'Escape': if (!el.recMenu.hidden) closeMenu(); else toggleQueue(false); break;
      default:
        if (/^[0-9]$/.test(k) && hasTrack()) audio.currentTime = trackDuration() * (parseInt(k, 10) / 10);
        else return;
    }
    wake();
  });

  addEventListener('pagehide', saveSession);
  setInterval(() => { if (!audio.paused) saveSession(); }, 5000);
  setInterval(() => { if (!audio.paused) updatePositionState(); }, 4000);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitArtist);
  addEventListener('resize', fitArtist);

  /* ------------------------------------------------------------------ Boot */
  async function boot() {
    applyVolume();
    applyRepeat();
    applyMono();
    applyRain();
    el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
    showEmpty();
    renderQueue();
    requestAnimationFrame(frame);

    try {
      const recs = await Library.all();
      recs.sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const r of recs) if (r.file) state.tracks.push(hydrate(r));
    } catch (err) {
      console.warn('[library] could not restore', err);
    }
    renderQueue();
    state.tracks.forEach(queueDuration);
    if (state.tracks.length) {
      let i = state.tracks.findIndex((t) => t.id === session.id);
      if (i < 0) i = 0;
      load(i, { autoplay: false, at: i === state.tracks.findIndex((t) => t.id === session.id) ? session.time || 0 : 0 });
      if (state.shuffle) buildShuffle();
    }
  }
  boot();

  // Small debugging handle for the console.
  window.EventHorizon = { state, audio, addFiles, load, step, toggleQueue, space, rain, toggleRain };
})();
