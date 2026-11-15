/* Tags — dependency-free metadata reader.
 * Supports ID3v2.2–2.4 (+ ID3v1 fallback), FLAC, Ogg Vorbis/Opus, MP4/M4A and WAV/AIFF (RIFF INFO / id3 chunk).
 * Tags.read(file) -> Promise<{ title?, artist?, album?, albumArtist?, picture?: Blob } | null>
 * Never throws; resolves null when nothing useful is found.
 */
window.Tags = (() => {
  'use strict';

  const decoder = (label) => { try { return new TextDecoder(label); } catch { return new TextDecoder('utf-8'); } };
  const D = { latin1: decoder('iso-8859-1'), utf8: decoder('utf-8'), le: decoder('utf-16le'), be: decoder('utf-16be') };

  const clean = (s) => s.replace(/^\u{FEFF}/u, '').replace(/\u{0}+$/gu, '').replace(/\u{0}/gu, ' / ').trim();
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
  const ascii = (b, o, n) => String.fromCharCode.apply(null, b.subarray(o, o + n));
  const bytes = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());

  function decodeText(b, enc) {
    if (!b.length) return '';
    switch (enc) {
      case 0: return clean(D.latin1.decode(b));
      case 1:
        if (b[0] === 0xFE && b[1] === 0xFF) return clean(D.be.decode(b.subarray(2)));
        return clean(D.le.decode(b));
      case 2: return clean(D.be.decode(b));
      default: return clean(D.utf8.decode(b));
    }
  }

  function unsync(b) {
    const out = new Uint8Array(b.length);
    let j = 0;
    for (let i = 0; i < b.length; i++) {
      out[j++] = b[i];
      if (b[i] === 0xFF && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }

  // Index just past a string terminator (1 or 2 null bytes depending on encoding).
  function afterTerminator(b, start, enc) {
    if (enc === 1 || enc === 2) {
      for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
      return b.length;
    }
    for (let i = start; i < b.length; i++) if (b[i] === 0) return i + 1;
    return b.length;
  }

  function sniffMime(b) {
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
    return 'image/jpeg';
  }
  function fixMime(mime, data) {
    mime = (mime || '').toLowerCase().trim();
    if (mime === 'image/jpg') return 'image/jpeg';
    return mime.includes('/') ? mime : sniffMime(data);
  }
  const picRank = (type) => (type === 3 ? 0 : type === 0 ? 1 : 2); // prefer "front cover"

  /* ------------------------------------------------------------- ID3v2 */
  async function readID3v2(file, base = 0) {
    const head = await bytes(file, base, base + 10);
    if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return null;
    const ver = head[3];
    const flags = head[5];
    if (ver < 2 || ver > 4) return null;
    let b = await bytes(file, base + 10, base + 10 + syncsafe(head, 6));
    if ((flags & 0x80) && ver < 4) b = unsync(b);

    let pos = 0;
    if ((flags & 0x40) && ver >= 3) pos = ver === 3 ? 4 + be32(b, 0) : syncsafe(b, 0);

    const out = {};
    let bestPic = 9;
    const hdr = ver === 2 ? 6 : 10;

    while (pos + hdr <= b.length) {
      const id = ascii(b, pos, ver === 2 ? 3 : 4);
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding reached
      let size, fflags = 0;
      if (ver === 2) size = be24(b, pos + 3);
      else {
        // Some v2.4 writers (old iTunes) store plain 32-bit sizes: fall back when the bytes aren't syncsafe.
        const plain = (b[pos + 4] | b[pos + 5] | b[pos + 6] | b[pos + 7]) & 0x80;
        size = ver === 4 && !plain ? syncsafe(b, pos + 4) : be32(b, pos + 4);
        fflags = (b[pos + 8] << 8) | b[pos + 9];
      }
      pos += hdr;
      if (size <= 0 || pos + size > b.length) break;
      let f = b.subarray(pos, pos + size);
      pos += size;

      if (ver === 3 && (fflags & 0x00C0)) continue; // compressed / encrypted
      if (ver === 4) {
        if (fflags & 0x000C) continue;
        if (fflags & 0x0002) f = unsync(f);
        if (fflags & 0x0001) f = f.subarray(4);
      }

      switch (id) {
        case 'TIT2': case 'TT2': out.title = decodeText(f.subarray(1), f[0]); break;
        case 'TPE1': case 'TP1': out.artist = decodeText(f.subarray(1), f[0]); break;
        case 'TPE2': case 'TP2': out.albumArtist = decodeText(f.subarray(1), f[0]); break;
        case 'TALB': case 'TAL': out.album = decodeText(f.subarray(1), f[0]); break;
        case 'APIC': {
          const enc = f[0];
          const mimeEnd = afterTerminator(f, 1, 0);
          const mime = D.latin1.decode(f.subarray(1, mimeEnd - 1));
          const type = f[mimeEnd];
          const data = f.subarray(afterTerminator(f, mimeEnd + 1, enc));
          const rank = picRank(type);
          if (data.length > 16 && rank < bestPic) {
            bestPic = rank;
            out.picture = new Blob([data], { type: fixMime(mime, data) });
          }
          break;
        }
        case 'PIC': {
          const enc = f[0];
          const type = f[4];
          const data = f.subarray(afterTerminator(f, 5, enc));
          const rank = picRank(type);
          if (data.length > 16 && rank < bestPic) {
            bestPic = rank;
            out.picture = new Blob([data], { type: sniffMime(data) });
          }
          break;
        }
      }
    }
    return out;
  }

  async function readID3v1(file) {
    if (file.size < 128) return null;
    const b = await bytes(file, file.size - 128, file.size);
    if (ascii(b, 0, 3) !== 'TAG') return null;
    const s = (o, n) => clean(D.latin1.decode(b.subarray(o, o + n)));
    return { title: s(3, 30), artist: s(33, 30), album: s(63, 30) };
  }

  /* ------------------------------------------------------------- Vorbis comments (FLAC / Ogg) */
  function flacPicture(b, o) {
    const type = be32(b, o); o += 4;
    const mimeLen = be32(b, o); o += 4;
    const mime = D.latin1.decode(b.subarray(o, o + mimeLen)); o += mimeLen;
    const descLen = be32(b, o); o += 4 + descLen;
    o += 16; // width, height, depth, colours
    const len = be32(b, o); o += 4;
    if (len < 16 || o + len > b.length) return null; // truncated or bogus
    const data = b.subarray(o, o + len);
    return { type, blob: new Blob([data], { type: fixMime(mime, data) }) };
  }

  function vorbisComments(b, o) {
    const res = {};
    const vendorLen = le32(b, o); o += 4 + vendorLen;
    const count = le32(b, o); o += 4;
    for (let i = 0; i < count && o + 4 <= b.length; i++) {
      const len = le32(b, o); o += 4;
      if (o + len > b.length) break; // truncated
      const s = D.utf8.decode(b.subarray(o, o + len)); o += len;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const key = s.slice(0, eq).toUpperCase();
      const val = s.slice(eq + 1).trim();
      if (!val) continue;
      if (key === 'TITLE' && !res.title) res.title = val;
      else if (key === 'ARTIST') res.artist = res.artist ? res.artist + ', ' + val : val;
      else if (key === 'ALBUM' && !res.album) res.album = val;
      else if (key === 'ALBUMARTIST' && !res.albumArtist) res.albumArtist = val;
      else if (key === 'METADATA_BLOCK_PICTURE' && !res.picture) {
        try {
          const bin = Uint8Array.from(atob(val), (c) => c.charCodeAt(0));
          const p = flacPicture(bin, 0);
          if (p) res.picture = p.blob;
        } catch { /* ignore malformed picture */ }
      }
    }
    return res;
  }

  async function readFLAC(file, base = 0) {
    let pos = base + 4;
    const out = {};
    let bestPic = 9;
    for (let guard = 0; guard < 128; guard++) {
      const h = await bytes(file, pos, pos + 4);
      if (h.length < 4) break;
      const last = h[0] & 0x80;
      const type = h[0] & 0x7f;
      const len = be24(h, 1);
      if (type === 4) {
        const c = vorbisComments(await bytes(file, pos + 4, pos + 4 + len), 0);
        for (const k in c) if (!out[k]) out[k] = c[k];
      } else if (type === 6) {
        const p = flacPicture(await bytes(file, pos + 4, pos + 4 + len), 0);
        if (p && picRank(p.type) < bestPic) { bestPic = picRank(p.type); out.picture = p.blob; }
      }
      pos += 4 + len;
      if (last) break;
    }
    return out;
  }

  async function readOgg(file, base = 0) {
    const b = await bytes(file, base, Math.min(file.size, base + 6 * 1024 * 1024));
    const packets = [];
    let cur = [];
    let o = 0;
    pages:
    while (o + 27 <= b.length) {
      if (ascii(b, o, 4) !== 'OggS') break;
      const n = b[o + 26];
      const lacing = b.subarray(o + 27, o + 27 + n);
      let p = o + 27 + n;
      let total = 0;
      for (const s of lacing) total += s;
      const pageEnd = p + total;
      for (const s of lacing) {
        cur.push(b.subarray(p, p + s));
        p += s;
        if (s < 255) {
          const len = cur.reduce((a, c) => a + c.length, 0);
          const pk = new Uint8Array(len);
          let k = 0;
          for (const c of cur) { pk.set(c, k); k += c.length; }
          packets.push(pk);
          cur = [];
          if (packets.length >= 2) break pages;
        }
      }
      o = pageEnd;
    }
    const pk = packets[1];
    if (!pk) return null;
    if (ascii(pk, 0, 8) === 'OpusTags') return vorbisComments(pk, 8);
    if (pk[0] === 3 && ascii(pk, 1, 6) === 'vorbis') return vorbisComments(pk, 7);
    return null;
  }

  /* ------------------------------------------------------------- MP4 / M4A */
  function boxes(b, start, end, fn) {
    let o = start;
    while (o + 8 <= end) {
      let size = be32(b, o);
      const type = ascii(b, o + 4, 4);
      let hl = 8;
      if (size === 1) { size = be32(b, o + 12); hl = 16; } else if (size === 0) size = end - o;
      if (size < hl || o + size > end) break;
      fn(type, o + hl, o + size);
      o += size;
    }
  }

  const COPY = String.fromCharCode(0xA9); // "©" prefix used by iTunes-style atoms

  function parseMoov(b) {
    const out = {};
    const item = (key, s, e) => boxes(b, s, e, (t, ds, de) => {
      if (t !== 'data') return;
      const kind = be32(b, ds) & 0xffffff;
      const v = b.subarray(ds + 8, de);
      if (key === 'covr') {
        if (!out.picture && v.length > 16) out.picture = new Blob([v], { type: kind === 14 ? 'image/png' : sniffMime(v) });
        return;
      }
      const str = D.utf8.decode(v).trim();
      if (!str) return;
      if (key === COPY + 'nam' && !out.title) out.title = str;
      else if (key === COPY + 'ART' && !out.artist) out.artist = str;
      else if (key === 'aART' && !out.albumArtist) out.albumArtist = str;
      else if (key === COPY + 'alb' && !out.album) out.album = str;
    });
    const walk = (s, e, inIlst) => boxes(b, s, e, (t, cs, ce) => {
      if (inIlst) item(t, cs, ce);
      else if (t === 'udta') walk(cs, ce, false);
      else if (t === 'meta') walk(cs + 4, ce, false); // full box: skip version/flags
      else if (t === 'ilst') walk(cs, ce, true);
    });
    walk(0, b.length, false);
    return out;
  }

  async function readMP4(file, base = 0) {
    let pos = base;
    for (let guard = 0; guard < 64 && pos + 8 <= file.size; guard++) {
      const h = await bytes(file, pos, pos + 16);
      let size = be32(h, 0);
      const type = ascii(h, 4, 4);
      let hl = 8;
      if (size === 1) { size = be32(h, 8) * 4294967296 + be32(h, 12); hl = 16; } else if (size === 0) size = file.size - pos;
      if (size < 8) break;
      if (type === 'moov') return parseMoov(await bytes(file, pos + hl, pos + size));
      pos += size;
    }
    return null;
  }

  /* ------------------------------------------------------------- Entry point */
  /* ------------------------------------------------------------- WAV (RIFF) / AIFF */
  async function readRIFF(file, aiff) {
    const out = {};
    const num = aiff ? be32 : le32;
    let pos = 12;
    for (let guard = 0; guard < 256 && pos + 8 <= file.size; guard++) {
      const h = await bytes(file, pos, pos + 12);
      if (h.length < 8) break;
      const id = ascii(h, 0, 4);
      const size = num(h, 4);
      const body = pos + 8;
      if (id === 'id3 ' || id === 'ID3 ') {
        const t = await readID3v2(file, body);
        if (t) for (const k in t) if (!out[k]) out[k] = t[k];
      } else if (!aiff && id === 'LIST' && ascii(h, 8, 4) === 'INFO') {
        const b = await bytes(file, body + 4, body + Math.min(size, 1 << 20));
        let o = 0;
        while (o + 8 <= b.length) {
          const k = ascii(b, o, 4);
          const n = le32(b, o + 4);
          if (o + 8 + n > b.length) break;
          const v = clean(D.utf8.decode(b.subarray(o + 8, o + 8 + n)));
          if (v) {
            if (k === 'INAM' && !out.title) out.title = v;
            else if (k === 'IART' && !out.artist) out.artist = v;
            else if (k === 'IPRD' && !out.album) out.album = v;
          }
          o += 8 + n + (n & 1);
        }
      } else if (aiff && (id === 'NAME' || id === 'AUTH')) {
        const v = clean(D.latin1.decode(await bytes(file, body, body + Math.min(size, 4096))));
        const k = id === 'NAME' ? 'title' : 'artist';
        if (v && !out[k]) out[k] = v;
      }
      if (size > file.size) break;
      pos = body + size + (size & 1);
    }
    return out;
  }

  // Dispatch on the container signature at `base` (lets an ID3v2 tag prefix FLAC/MP4 etc.).
  async function readContainer(file, base) {
    const h = await bytes(file, base, base + 12);
    const sig = ascii(h, 0, 4);
    if (sig === 'fLaC') return readFLAC(file, base);
    if (sig === 'OggS') return readOgg(file, base);
    if (ascii(h, 4, 4) === 'ftyp') return readMP4(file, base);
    if (base === 0 && sig === 'RIFF' && ascii(h, 8, 4) === 'WAVE') return readRIFF(file, false);
    if (base === 0 && sig === 'FORM' && /^AIF[FC]$/.test(ascii(h, 8, 4))) return readRIFF(file, true);
    return null;
  }

  const hasData = (r) => !!(r && (r.title || r.artist || r.album || r.albumArtist || r.picture));

  async function read(file) {
    try {
      const h = await bytes(file, 0, 10);
      let res = null;
      if (h.length >= 10 && ascii(h, 0, 3) === 'ID3') {
        res = await readID3v2(file);
        if (!hasData(res)) { // ID3v2 prepended to another container (e.g. FLAC)
          const end = 10 + syncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0);
          if (end < file.size) res = await readContainer(file, end) || res;
        }
      } else {
        res = await readContainer(file, 0);
      }

      if (!res || !res.title) {
        const v1 = await readID3v1(file);
        if (v1) res = Object.assign({}, v1, res || {}, { title: (res && res.title) || v1.title });
      }
      if (res && !res.artist && res.albumArtist) res.artist = res.albumArtist;
      if (res) for (const k in res) if (res[k] === '' || res[k] == null) delete res[k];
      return hasData(res) ? res : null;
    } catch (err) {
      console.warn('[tags] could not read', file.name, err);
      return null;
    }
  }

  return { read };
})();
