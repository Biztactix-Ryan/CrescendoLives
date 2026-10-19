/*!
 * Crescendo \u2014 JS Edition
 * A tribute to LiveUpdate's Crescendo MIDI plug-in for Netscape Navigator (c. 1996).
 * Not affiliated with LiveUpdate. Pure JavaScript, no dependencies, no build step.
 *
 * Put it on a page:
 *   <script src="crescendo/crescendo.js" data-soundfont="soundfonts/GeneralUser-GS.sf2"></script>
 *
 * \u2026and these all just work, like it's 1997:
 *   <EMBED SRC="song.mid" AUTOSTART=TRUE LOOP=TRUE WIDTH=200 HEIGHT=55>
 *   <BGSOUND SRC="song.mid" LOOP=INFINITE>
 *   <crescendo-player src="song.mid" autostart loop></crescendo-player>
 *   <a href="song.mid">a plain link to a MIDI file</a>   (opens the pop-up player)
 *
 * Without data-soundfont the built-in OPL-style FM synth is used (zero downloads).
 */
(function (root) {
  'use strict';

  const VERSION = '1.0';
  const MIDI_RE = /\.(mid|midi|kar|rmi|smf)([?#].*)?$/i;

  // ===========================================================================
  // Standard MIDI File parser
  // ===========================================================================

  /**
   * Parses an SMF (type 0/1/2, also RIFF-wrapped .rmi and karaoke .kar) into a
   * flat, time-sorted event list. Channel messages are packed as
   * status | data1 << 8 | data2 << 16; sysex events use status 0xF0 and keep
   * their bytes in `sysex` keyed by event index.
   */
  function parseMidi(input) {
    let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (tag(0) === 'RIFF') {
      for (let i = 12; i + 8 <= bytes.length; i++) {
        if (tag(i) === 'MThd') { bytes = bytes.subarray(i); break; }
      }
    }
    if (bytes.length < 14 || tag(0) !== 'MThd') throw new Error('Not a MIDI file');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const format = dv.getUint16(8);
    const ntrks = dv.getUint16(10);
    const division = dv.getUint16(12);
    let ppq = division, ticksPerSec = 0;
    if (division & 0x8000) ticksPerSec = (256 - (division >> 8)) * (division & 0xff);

    const raw = [];
    const texts = [];
    let title = '', copyright = '', karTitle = '';
    let isKar = false, seq = 0, track = 0;
    let p = 8 + dv.getUint32(4);
    const latin1 = (a, b) => {
      let s = '';
      for (let i = a; i < b; i++) s += String.fromCharCode(bytes[i]);
      return s.replace(/\0+$/, '');
    };

    while (p + 8 <= bytes.length && track < ntrks) {
      const id = tag(p), len = dv.getUint32(p + 4);
      p += 8;
      const end = Math.min(p + len, bytes.length);
      if (id !== 'MTrk') { p = end; continue; }
      let tick = 0, running = 0;
      const vlq = () => {
        let v = 0, c;
        do { c = bytes[p++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && p < end);
        return v;
      };
      while (p < end) {
        tick += vlq();
        let st = bytes[p];
        if (st & 0x80) { p++; if (st < 0xf0) running = st; }
        else if (running) st = running;
        else { p++; continue; } // garbage byte without running status
        if (st === 0xff) {
          const type = bytes[p++], l = vlq(), a = p;
          p += l;
          if (type === 0x51 && l >= 3) {
            raw.push({ tick, prio: 0, seq: seq++, tempo: (bytes[a] << 16) | (bytes[a + 1] << 8) | bytes[a + 2] });
          } else if (type === 0x03 && !title && (track === 0 || format === 0)) {
            title = latin1(a, p).trim();
          } else if (type === 0x02 && !copyright) {
            copyright = latin1(a, p).trim();
          } else if (type === 0x01 || type === 0x05) {
            const text = latin1(a, p);
            if (type === 0x01 && text.startsWith('@')) {
              isKar = true;
              if (text.startsWith('@T') && !karTitle) karTitle = text.slice(2).trim();
            } else {
              texts.push({ tick, seq: seq++, type, text });
            }
          } else if (type === 0x2f) {
            break;
          }
        } else if (st === 0xf0 || st === 0xf7) {
          const l = vlq();
          if (st === 0xf0) raw.push({ tick, prio: 2, seq: seq++, sysex: bytes.slice(p, p + l) });
          p += l;
        } else {
          const kind = st & 0xf0;
          const a = bytes[p++] & 0x7f;
          const b = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[p++] & 0x7f;
          const prio = kind === 0x80 || (kind === 0x90 && b === 0) ? 1 : kind === 0x90 ? 3 : 2;
          raw.push({ tick, prio, seq: seq++, msg: st | (a << 8) | (b << 16) });
        }
      }
      p = end;
      track++;
    }

    // Same tick: tempo, then note-offs, then controllers, then note-ons.
    raw.sort((x, y) => x.tick - y.tick || x.prio - y.prio || x.seq - y.seq);

    // Tick -> seconds through the tempo map.
    const tempoPts = [];
    let tempo = 500000, lastTick = 0, sec = 0;
    const toSec = (t) => (ticksPerSec ? t / ticksPerSec : (t * tempo) / 1e6 / ppq);
    const events = [];
    for (const e of raw) {
      sec += toSec(e.tick - lastTick);
      lastTick = e.tick;
      if (e.tempo) { tempo = e.tempo; tempoPts.push({ tick: e.tick, sec, tempo }); continue; }
      events.push({ t: sec, e });
    }
    const tickToSec = (tick) => {
      let s = 0, tp = 500000, lt = 0;
      for (const pt of tempoPts) {
        if (pt.tick > tick) break;
        s = pt.sec; tp = pt.tempo; lt = pt.tick;
      }
      return s + (ticksPerSec ? (tick - lt) / ticksPerSec : ((tick - lt) * tp) / 1e6 / ppq);
    };

    const n = events.length;
    const times = new Float64Array(n);
    const msgs = new Int32Array(n);
    const sysex = [];
    let duration = 0, notes = 0;
    for (let i = 0; i < n; i++) {
      const { t, e } = events[i];
      times[i] = t;
      if (e.sysex) { msgs[i] = 0xf0; sysex.push([i, e.sysex]); }
      else {
        msgs[i] = e.msg;
        if ((e.msg & 0xf0) === 0x90 && e.msg >> 16) notes++;
      }
      duration = t;
    }

    // Lyrics: proper lyric events, or text events in karaoke files.
    const lyricType = isKar || !texts.some((x) => x.type === 5) ? 1 : 5;
    const lyrics = (isKar || lyricType === 5 ? texts.filter((x) => x.type === lyricType) : [])
      .sort((a, b) => a.tick - b.tick || a.seq - b.seq)
      .map((x) => ({ t: tickToSec(x.tick), text: x.text }));

    return { format, ppq, title: karTitle || title, copyright, duration, times, msgs, sysex, notes, lyrics };
  }

  /** Splits lyric syllables into display lines: [{t, line, upto}] + lines[]. */
  function layoutLyrics(lyrics) {
    const lines = [], marks = [];
    let cur = '';
    const flush = () => { if (cur.trim()) lines.push(cur.trim()); cur = ''; };
    for (const { t, text } of lyrics) {
      let s = text.replace(/\r\n?/g, '\n');
      if (/^[\\/\n]/.test(s) || cur.length > 34) { flush(); s = s.replace(/^[\\/\n]+/, ''); }
      const nl = /[\n]$/.test(s);
      cur += s.replace(/[\\/\n]/g, ' ');
      marks.push({ t, line: lines.length, upto: cur.trimStart().length });
      if (nl) flush();
    }
    flush();
    return { lines, marks };
  }

  // ===========================================================================
  // SoundFont 2 parser (runs on the main thread; the bank is handed to the synth)
  // ===========================================================================

  const SF_DEFAULTS = new Float64Array(61);
  for (const g of [21, 23, 25, 26, 27, 28, 30, 33, 34, 35, 36, 38]) SF_DEFAULTS[g] = -12000;
  SF_DEFAULTS[8] = 13500;
  SF_DEFAULTS[56] = 100;
  SF_DEFAULTS[46] = SF_DEFAULTS[47] = SF_DEFAULTS[58] = -1;

  function parseSF2(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'sfbk') throw new Error('Not a SoundFont 2 file');
    const chunks = {};
    (function walk(start, end) {
      let p = start;
      while (p + 8 <= end) {
        const id = tag(p), len = dv.getUint32(p + 4, true), body = p + 8;
        if (id === 'LIST') walk(body + 4, Math.min(body + len, end));
        else chunks[id] = { off: body, len };
        p = body + len + (len & 1);
      }
    })(12, Math.min(u8.length, 8 + dv.getUint32(4, true)));
    for (const need of ['smpl', 'phdr', 'pbag', 'pgen', 'inst', 'ibag', 'igen', 'shdr']) {
      if (!chunks[need]) throw new Error('SoundFont is missing its ' + need + ' chunk');
    }
    const str = (o, l) => {
      let s = '';
      for (let i = 0; i < l && u8[o + i]; i++) s += String.fromCharCode(u8[o + i]);
      return s.trim();
    };
    const count = (id, size) => Math.floor(chunks[id].len / size);

    const sm = chunks.smpl;
    const data = new Int16Array(buffer.slice(sm.off, sm.off + (sm.len & ~1)));

    const samples = [];
    for (let i = 0, n = count('shdr', 46) - 1; i < n; i++) {
      const o = chunks.shdr.off + i * 46;
      samples.push({
        name: str(o, 20),
        start: dv.getUint32(o + 20, true), end: dv.getUint32(o + 24, true),
        ls: dv.getUint32(o + 28, true), le: dv.getUint32(o + 32, true),
        rate: dv.getUint32(o + 36, true) || 44100,
        pitch: u8[o + 40], corr: dv.getInt8(o + 41), type: dv.getUint16(o + 44, true),
      });
    }

    // Reads the zones (bags) of one preset/instrument. `term` is the generator
    // that ends a non-global zone (41 instrument / 53 sampleID).
    function zones(bagId, genId, bagFrom, bagTo, term) {
      const bagOff = chunks[bagId].off, genOff = chunks[genId].off;
      const genIdx = (b) => dv.getUint16(bagOff + b * 4, true);
      const out = [];
      let global = null;
      for (let b = bagFrom; b < bagTo; b++) {
        const z = { kl: 0, kh: 127, vl: 0, vh: 127, gens: new Float64Array(61).fill(NaN), link: -1 };
        for (let g = genIdx(b), ge = genIdx(b + 1); g < ge; g++) {
          const o = genOff + g * 4, op = dv.getUint16(o, true);
          if (op === 43) { z.kl = u8[o + 2]; z.kh = u8[o + 3]; }
          else if (op === 44) { z.vl = u8[o + 2]; z.vh = u8[o + 3]; }
          else if (op === term) z.link = dv.getUint16(o + 2, true);
          else if (op < 61) z.gens[op] = dv.getInt16(o + 2, true);
        }
        if (z.link >= 0) out.push(z);
        else if (b === bagFrom) global = z;
      }
      return { global, zones: out };
    }

    const instruments = [];
    for (let i = 0, n = count('inst', 22) - 1; i < n; i++) {
      const o = chunks.inst.off + i * 22;
      const from = dv.getUint16(o + 20, true), to = dv.getUint16(o + 42, true);
      const { global, zones: zs } = zones('ibag', 'igen', from, to, 53);
      instruments.push({
        name: str(o, 20),
        zones: zs.filter((z) => samples[z.link] && !(samples[z.link].type & 0x8000)).map((z) => {
          const g = Float64Array.from(SF_DEFAULTS);
          for (let k = 0; k < 61; k++) {
            if (global && !Number.isNaN(global.gens[k])) g[k] = global.gens[k];
            if (!Number.isNaN(z.gens[k])) g[k] = z.gens[k];
          }
          return { kl: z.kl, kh: z.kh, vl: z.vl, vh: z.vh, gens: g, sample: z.link };
        }),
      });
    }

    const presets = [];
    for (let i = 0, n = count('phdr', 38) - 1; i < n; i++) {
      const o = chunks.phdr.off + i * 38;
      const from = dv.getUint16(o + 24, true), to = dv.getUint16(o + 62, true);
      const { global, zones: zs } = zones('pbag', 'pgen', from, to, 41);
      presets.push({
        name: str(o, 20), prog: dv.getUint16(o + 20, true), bank: dv.getUint16(o + 22, true),
        zones: zs.map((z) => {
          const g = new Float64Array(61);
          for (let k = 0; k < 61; k++) {
            if (!Number.isNaN(z.gens[k])) g[k] = z.gens[k];
            else if (global && !Number.isNaN(global.gens[k])) g[k] = global.gens[k];
          }
          return { kl: z.kl, kh: z.kh, vl: z.vl, vh: z.vh, gens: g, inst: z.link };
        }),
      });
    }

    let name = '';
    if (chunks.INAM) name = str(chunks.INAM.off, chunks.INAM.len);
    return { name, presets, instruments, samples, data };
  }

  // ===========================================================================
  // The synthesizer. This function's source runs inside an AudioWorklet, so it
  // must be self-contained. It also sequences the song, sample-accurately, so
  // playback keeps perfect time even when the tab is in the background.
  // ===========================================================================

  function crescendoWorklet() {
    const SR = sampleRate;
    const BLOCK = 128;
    const TAU = Math.PI * 2;
    const TBL = 4096, TMASK = TBL - 1;
    const MAX_VOICES = 96;
    const POS_EVERY = 12; // post position/levels every 12 blocks (~30 Hz)

    // OPL-style waveforms: sine, half-sine, abs-sine, quarter-sine pulses.
    const WAVES = [0, 1, 2, 3].map((w) => {
      const t = new Float32Array(TBL);
      for (let i = 0; i < TBL; i++) {
        const s = Math.sin((TAU * i) / TBL);
        t[i] = w === 0 ? s : w === 1 ? Math.max(0, s) : w === 2 ? Math.abs(s) : i % (TBL / 2) < TBL / 4 ? Math.abs(s) : 0;
      }
      return t;
    });
    const SINE = WAVES[0];

    let seed = 0x2545f491;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed / 2147483648; };
    const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
    const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
    const tc2s = (tc) => Math.pow(2, tc / 1200);
    const cb2amp = (cb) => Math.pow(10, -cb / 200);
    const tri = (ph) => { const x = ph - Math.floor(ph); return x < 0.5 ? 4 * x - 1 : 3 - 4 * x; };
    const blep = (t, dt) => {
      if (t < dt) { t /= dt; return t + t - t * t - 1; }
      if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
      return 0;
    };

    class Biquad {
      constructor() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = this.z1 = this.z2 = 0; }
      set(type, f, q) {
        const w = (TAU * clamp(f, 10, SR * 0.45)) / SR;
        const c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
        if (type === 'lp') { this.b0 = (1 - c) / 2 / a0; this.b1 = (1 - c) / a0; this.b2 = this.b0; }
        else if (type === 'hp') { this.b0 = (1 + c) / 2 / a0; this.b1 = -(1 + c) / a0; this.b2 = this.b0; }
        else { this.b0 = alpha / a0; this.b1 = 0; this.b2 = -alpha / a0; }
        this.a1 = (-2 * c) / a0; this.a2 = (1 - alpha) / a0;
        return this;
      }
      run(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
      }
    }

    /** Classic ADSR in the amplitude domain, stepped once per block. */
    class Env {
      constructor(a, d, s, r) {
        this.ainc = BLOCK / (Math.max(a, 0.001) * SR);
        this.dk = Math.exp((-6.9 * BLOCK) / (Math.max(d, 0.005) * SR));
        this.rk = Math.exp((-6.9 * BLOCK) / (Math.max(r, 0.008) * SR));
        this.s = s; this.v = 0; this.stage = 0; this.done = false;
      }
      step() {
        switch (this.stage) {
          case 0: this.v += this.ainc; if (this.v >= 1) { this.v = 1; this.stage = 1; } break;
          case 1:
            this.v = this.s + (this.v - this.s) * this.dk;
            if (this.v - this.s < 1e-4) { this.v = this.s; this.stage = 2; if (this.s < 1e-4) this.done = true; }
            break;
          case 3: this.v *= this.rk; if (this.v < 1e-4) { this.v = 0; this.done = true; } break;
        }
        return this.v;
      }
      release() { if (this.stage < 3) this.stage = 3; }
      kill() { this.rk = Math.exp((-6.9 * BLOCK) / (0.006 * SR)); this.stage = 3; }
    }

    /** SoundFont volume envelope: linear attack, decay/release linear in dB. */
    class SFEnv {
      constructor(delay, attack, hold, decay, susCb, release) {
        this.delay = delay; this.attack = Math.max(attack, 0.001); this.hold = hold;
        this.dRate = ((1000 / Math.max(decay, 0.001)) * BLOCK) / SR;
        this.rRate = ((1000 / Math.max(release, 0.006)) * BLOCK) / SR;
        this.sus = clamp(susCb, 0, 1440);
        this.stage = 0; this.t = 0; this.v = 0; this.att = 0; this.done = false;
      }
      step() {
        const dt = BLOCK / SR;
        switch (this.stage) {
          case 0: this.t += dt; if (this.t >= this.delay) { this.stage = 1; this.t = 0; } break;
          case 1: this.t += dt; this.v = this.t / this.attack; if (this.v >= 1) { this.v = 1; this.stage = 2; this.t = 0; } break;
          case 2: this.t += dt; if (this.t >= this.hold) this.stage = 3; break;
          case 3:
            this.att += this.dRate;
            if (this.att >= this.sus) { this.att = this.sus; this.stage = 4; }
            this.v = cb2amp(this.att);
            if (this.att >= 960) this.done = true;
            break;
          case 5:
            this.att += this.rRate; this.v = cb2amp(this.att);
            if (this.att >= 960) { this.v = 0; this.done = true; }
            break;
        }
        return this.v;
      }
      release() {
        if (this.stage === 5) return;
        if (this.stage <= 2) this.att = this.v > 1e-5 ? -200 * Math.log10(this.v) : 960;
        this.stage = 5;
      }
      kill() { this.rRate = (1000 * BLOCK) / (0.006 * SR); this.release(); }
    }

    /** SoundFont modulation envelope: 0..1, linear segments. */
    class ModEnv {
      constructor(delay, attack, hold, decay, sus, release) {
        this.delay = delay; this.attack = Math.max(attack, 0.001); this.hold = hold;
        this.dRate = BLOCK / (Math.max(decay, 0.001) * SR);
        this.rRate = BLOCK / (Math.max(release, 0.001) * SR);
        this.sus = clamp(sus, 0, 1); this.stage = 0; this.t = 0; this.v = 0;
      }
      step() {
        const dt = BLOCK / SR;
        switch (this.stage) {
          case 0: this.t += dt; if (this.t >= this.delay) { this.stage = 1; this.t = 0; } break;
          case 1: this.t += dt; this.v = Math.min(1, this.t / this.attack); if (this.v >= 1) { this.stage = 2; this.t = 0; } break;
          case 2: this.t += dt; if (this.t >= this.hold) this.stage = 3; break;
          case 3: this.v -= this.dRate; if (this.v <= this.sus) { this.v = this.sus; this.stage = 4; } break;
          case 5: this.v = Math.max(0, this.v - this.rRate); break;
        }
        return this.v;
      }
      release() { this.stage = 5; }
    }

    const chanCents = (c) => (c.bend / 8192) * c.bendRange * 100 + c.coarse * 100 + c.fine;

    class Voice {
      constructor(ch, key, vel) {
        this.ch = ch; this.key = key; this.vel = vel;
        this.released = false; this.held = false; this.done = false; this.killed = false;
        this.drum = false; this.oneShot = false; this.choke = 0; this.excl = 0;
        this.pan = 0; this.rev = 0; this.cho = 0; this.gl = -1; this.gr = 0; this.lvl = 0; this.t = 0;
      }
      release() { this.released = true; this.env.release(); }
      kill() { this.released = this.killed = true; this.env.kill(); }
    }

    // ---- GM instrument patches for the FM / analog engine -------------------
    // k: fm | sub (subtractive) | noise.  FM: carrier/mod ratio cr/mr, waves cw/mw,
    // index i0 -> i1 over id seconds, feedback fb, envelope a/d/s/r, detuned layer
    // `lay` cents, vibrato vib cents after vd s, tremolo trem at tr Hz, level lvl,
    // key-scaled decay kd, breath noise nz, index follows loudness `follow`,
    // pitch drop pd semitones over pdt. Sub: wave w (1 saw, 2 square), detune det,
    // cutoff fc\u00d7f + fe\u00d7f\u00d7filter-env (fa attack, fd decay), resonance fq.
    function P(o) {
      return Object.assign({
        k: 'fm', cr: 1, mr: 1, cw: 0, mw: 0, i0: 2, i1: 0.5, id: 0.4, fb: 0, a: 0.004, d: 1.5, s: 0, r: 0.25,
        lay: 0, vib: 0, vd: 0.35, vr: 5.5, trem: 0, tr: 5, lvl: 0.5, kd: 1, nz: 0, follow: 0, pd: 0, pdt: 0.05,
        w: 1, det: 0, fc: 2, fe: 4, fq: 1, fa: 0.005, fd: 0.4, nf: 'bp', f: 1000, q: 1,
      }, o);
    }
    const ORG = { a: 0.01, s: 1, kd: 0, r: 0.08 };
    const STR = { a: 0.08, d: 1, s: 1, r: 0.25, kd: 0, fb: 0.25, vib: 16, vd: 0.25 };
    const BRS = { a: 0.04, d: 1, s: 0.85, r: 0.15, kd: 0, follow: 1, fb: 0.3, vib: 10, vd: 0.4 };
    const RED = { a: 0.03, d: 1, s: 0.9, r: 0.12, kd: 0, follow: 1, vib: 12, vd: 0.3, nz: 0.03 };
    const PIP = { a: 0.05, d: 1, s: 0.9, r: 0.15, kd: 0, vib: 12, vd: 0.3 };
    const LED = { d: 0.5, s: 1, r: 0.1, kd: 0 };
    const PAD = { a: 0.3, d: 2, s: 0.8, r: 1, kd: 0 };
    const PATCHES = [
      // Piano
      P({ i0: 3.2, i1: 0.4, id: 0.35, d: 3.5, r: 0.35, fb: 0.05, lay: 4, lvl: 0.309 }),
      P({ i0: 4, i1: 0.8, id: 0.3, d: 3, r: 0.3, fb: 0.1, lay: 4, lvl: 0.309 }),
      P({ i0: 3, i1: 0.6, id: 0.4, d: 3, r: 0.3, lay: 7, lvl: 0.309 }),
      P({ i0: 3, i1: 0.6, id: 0.4, d: 3, r: 0.3, lay: 16, lvl: 0.315 }),
      P({ i0: 1.8, i1: 0.2, id: 0.5, d: 3.5, r: 0.3, lay: 3, lvl: 0.239 }),
      P({ i0: 3.5, i1: 0.3, id: 0.25, d: 3, r: 0.3, lay: 8, lvl: 0.309 }),
      P({ i0: 5, i1: 2, id: 0.6, d: 2, r: 0.15, fb: 0.3, lvl: 0.225 }),
      P({ i0: 6, i1: 3, id: 0.3, d: 1.2, r: 0.08, fb: 0.4, lvl: 0.4 }),
      // Chromatic percussion
      P({ mr: 4, i0: 1.5, i1: 0, id: 0.2, d: 1.5, lvl: 0.45 }),
      P({ mr: 3.5, i0: 2, i1: 0, id: 0.1, d: 1.8, kd: 0.5, lvl: 0.4 }),
      P({ mr: 4, i0: 2.5, i1: 0, id: 0.15, d: 1.6, lvl: 0.4 }),
      P({ mr: 4, i0: 1.2, i1: 0, id: 0.1, d: 3, trem: 0.3, tr: 5, lvl: 0.45 }),
      P({ mr: 4, i0: 3, i1: 0, id: 0.05, d: 0.5, lvl: 0.55 }),
      P({ mr: 3.5, i0: 3, i1: 0, id: 0.05, d: 0.35, lvl: 0.5 }),
      P({ mr: 3.5, i0: 4, i1: 0.8, id: 1, d: 4, kd: 0, lvl: 0.4 }),
      P({ i0: 4, i1: 0.5, id: 0.3, d: 2, lay: 10, lvl: 0.45 }),
      // Organ
      P({ ...ORG, mr: 2, i0: 1.4, i1: 1.4, lay: 2, lvl: 0.4 }),
      P({ ...ORG, mr: 3, i0: 2, i1: 1, id: 0.2, lay: 2, lvl: 0.4 }),
      P({ ...ORG, i0: 1.5, i1: 1.5, fb: 0.35, lay: 5, vib: 6, vd: 0, lvl: 0.38 }),
      P({ ...ORG, mr: 2, i0: 1.1, i1: 1.1, lay: 3, a: 0.06, r: 0.5, lvl: 0.252 }),
      P({ ...ORG, mr: 2, i0: 1.8, i1: 1.8, fb: 0.2, lvl: 0.38 }),
      P({ ...ORG, i0: 2.2, i1: 2.2, fb: 0.3, lay: 12, a: 0.03, lvl: 0.18 }),
      P({ ...ORG, i0: 2.5, i1: 2.5, fb: 0.4, a: 0.04, vib: 15, lvl: 0.36 }),
      P({ ...ORG, i0: 2, i1: 2, fb: 0.3, lay: 8, a: 0.03, lvl: 0.36 }),
      // Guitar
      P({ i0: 2.5, i1: 0.3, id: 0.2, d: 1.6, lvl: 0.5 }),
      P({ i0: 3.5, i1: 0.5, id: 0.25, d: 1.8, fb: 0.1, lay: 3, lvl: 0.201 }),
      P({ i0: 1.5, i1: 0.2, id: 0.3, d: 2, lvl: 0.5 }),
      P({ i0: 2.5, i1: 0.6, id: 0.3, d: 2.5, lay: 4, lvl: 0.45 }),
      P({ i0: 3, i1: 0.3, id: 0.05, d: 0.25, lvl: 0.5 }),
      P({ i0: 4, i1: 3, id: 0.5, d: 4, s: 0.5, r: 0.2, fb: 0.6, lay: 8, lvl: 0.32 }),
      P({ i0: 5, i1: 4, id: 0.5, d: 4, s: 0.6, r: 0.2, fb: 0.8, lay: 12, lvl: 0.3 }),
      P({ cr: 2, mr: 2, i0: 0.6, i1: 0.1, id: 0.3, d: 1.5, lvl: 0.45 }),
      // Bass
      P({ i0: 1.5, i1: 0.3, id: 0.2, d: 1.5, kd: 0.5, lvl: 0.7 }),
      P({ i0: 2, i1: 0.6, id: 0.3, d: 2.5, fb: 0.1, kd: 0.5, lvl: 0.496 }),
      P({ i0: 3, i1: 0.6, id: 0.15, d: 2, fb: 0.2, kd: 0.5, lvl: 0.366 }),
      P({ i0: 1.2, i1: 0.8, id: 0.5, d: 3, a: 0.02, kd: 0.5, lvl: 0.7 }),
      P({ i0: 6, i1: 1, id: 0.06, d: 1.5, fb: 0.3, kd: 0.5, lvl: 0.268 }),
      P({ mr: 2, i0: 5, i1: 1, id: 0.06, d: 1.5, fb: 0.2, kd: 0.5, lvl: 0.213 }),
      P({ k: 'sub', w: 1, fc: 1.5, fe: 8, fq: 3, fd: 0.25, d: 0.8, s: 0.5, r: 0.1, kd: 0, lvl: 0.45 }),
      P({ k: 'sub', w: 2, det: 6, fc: 1.2, fe: 6, fq: 2, fd: 0.3, d: 0.8, s: 0.5, r: 0.1, kd: 0, lvl: 0.4 }),
      // Strings
      P({ ...STR, i0: 2, i1: 2, lvl: 0.4 }),
      P({ ...STR, i0: 1.8, i1: 1.8, lvl: 0.4 }),
      P({ ...STR, i0: 1.8, i1: 1.8, lvl: 0.42 }),
      P({ ...STR, i0: 1.6, i1: 1.6, vib: 8, lvl: 0.45 }),
      P({ ...STR, i0: 1.3, i1: 1.3, lay: 8, trem: 0.6, tr: 12, lvl: 0.252 }),
      P({ i0: 1.5, i1: 0, id: 0.05, d: 0.4, lvl: 0.55 }),
      P({ i0: 1.5, i1: 0.1, id: 0.2, d: 2.5, lvl: 0.5 }),
      P({ mr: 1.6, i0: 2, i1: 0, id: 0.08, d: 1.5, kd: 0, pd: 1, pdt: 0.08, lvl: 0.394 }),
      // Ensemble
      P({ ...STR, a: 0.15, r: 0.5, i0: 1.3, i1: 1.3, fb: 0.2, lay: 10, vib: 8, lvl: 0.283 }),
      P({ ...STR, a: 0.4, r: 0.6, i0: 1.1, i1: 1.1, fb: 0.2, lay: 10, vib: 6, lvl: 0.4 }),
      P({ k: 'sub', w: 1, det: 12, fc: 3, fe: 0, a: 0.1, d: 1, s: 1, r: 0.5, kd: 0, vib: 5, lvl: 0.32 }),
      P({ k: 'sub', w: 1, det: 8, fc: 2, fe: 1, fa: 0.5, fd: 2, a: 0.3, d: 1, s: 1, r: 0.6, kd: 0, lvl: 0.32 }),
      P({ a: 0.2, d: 1, s: 1, r: 0.5, kd: 0, i0: 0.8, i1: 0.8, lay: 9, vib: 10, nz: 0.03, lvl: 0.297 }),
      P({ a: 0.15, d: 1, s: 1, r: 0.4, kd: 0, i0: 0.35, i1: 0.35, lay: 7, vib: 8, lvl: 0.45 }),
      P({ a: 0.1, d: 1, s: 1, r: 0.4, kd: 0, i0: 1, i1: 1, lay: 6, vib: 6, mw: 1, lvl: 0.4 }),
      P({ i0: 6, i1: 1, id: 0.1, d: 0.6, fb: 0.5, lay: 15, kd: 0, lvl: 0.5 }),
      // Brass
      P({ ...BRS, i0: 3.2, i1: 3.2, lvl: 0.4 }),
      P({ ...BRS, i0: 2.6, i1: 2.6, lvl: 0.42 }),
      P({ ...BRS, i0: 2, i1: 2, lvl: 0.5 }),
      P({ ...BRS, mr: 3, i0: 2, i1: 2, fb: 0.5, lvl: 0.175 }),
      P({ ...BRS, a: 0.07, i0: 1.5, i1: 1.5, fb: 0.15, lvl: 0.42 }),
      P({ ...BRS, i0: 3, i1: 3, lay: 10, lvl: 0.36 }),
      P({ k: 'sub', w: 1, det: 10, fc: 1.5, fe: 5, fd: 0.5, a: 0.02, d: 0.5, s: 0.7, r: 0.2, kd: 0, lvl: 0.452 }),
      P({ k: 'sub', w: 1, det: 6, fc: 1, fe: 4, fa: 0.08, fd: 0.6, a: 0.08, d: 0.5, s: 0.7, r: 0.25, kd: 0, lvl: 0.507 }),
      // Reed
      P({ ...RED, i0: 2.4, i1: 2.4, fb: 0.45, lvl: 0.38 }),
      P({ ...RED, i0: 2.6, i1: 2.6, fb: 0.45, lvl: 0.38 }),
      P({ ...RED, i0: 2.8, i1: 2.8, fb: 0.45, lvl: 0.38 }),
      P({ ...RED, i0: 3, i1: 3, fb: 0.45, lvl: 0.4 }),
      P({ ...RED, i0: 2.5, i1: 2.5, fb: 0.55, mw: 1, lvl: 0.32 }),
      P({ ...RED, i0: 2.2, i1: 2.2, fb: 0.5, mw: 1, lvl: 0.34 }),
      P({ ...RED, i0: 2, i1: 2, fb: 0.5, lvl: 0.4 }),
      P({ ...RED, mr: 2, i0: 1.6, i1: 1.6, fb: 0.05, lvl: 0.4 }),
      // Pipe
      P({ ...PIP, i0: 0.35, i1: 0.35, nz: 0.06, lvl: 0.42 }),
      P({ ...PIP, i0: 0.4, i1: 0.4, nz: 0.08, lvl: 0.45 }),
      P({ ...PIP, i0: 0.3, i1: 0.3, nz: 0.04, vib: 5, lvl: 0.45 }),
      P({ ...PIP, i0: 0.2, i1: 0.2, nz: 0.15, lvl: 0.45 }),
      P({ ...PIP, i0: 0.1, i1: 0.1, nz: 0.2, lvl: 0.45 }),
      P({ ...PIP, i0: 0.5, i1: 0.5, nz: 0.15, lvl: 0.45 }),
      P({ ...PIP, i0: 0.05, i1: 0.05, vib: 15, lvl: 0.4 }),
      P({ ...PIP, i0: 0.15, i1: 0.15, nz: 0.03, lvl: 0.45 }),
      // Synth lead
      P({ ...LED, k: 'sub', w: 2, fc: 6, fe: 2, fd: 0.3, lvl: 0.28 }),
      P({ ...LED, k: 'sub', w: 1, det: 6, fc: 5, fe: 3, fd: 0.3, lvl: 0.396 }),
      P({ ...LED, i0: 0.6, i1: 0.6, nz: 0.08, vib: 10, lvl: 0.4 }),
      P({ ...LED, k: 'sub', w: 2, fc: 3, fe: 6, fd: 0.15, s: 0.6, d: 0.4, nz: 0.05, lvl: 0.3 }),
      P({ ...LED, i0: 4, i1: 3, fb: 0.8, s: 0.7, d: 1, lvl: 0.3 }),
      P({ ...LED, i0: 0.8, i1: 0.8, lay: 8, vib: 10, a: 0.03, lvl: 0.38 }),
      P({ ...LED, i0: 1.5, i1: 1.2, fb: 0.3, lay: 702, lvl: 0.32 }),
      P({ ...LED, k: 'sub', w: 1, det: 10, fc: 3, fe: 4, fd: 0.4, lvl: 0.885 }),
      // Synth pad
      P({ ...PAD, mr: 2, i0: 1, i1: 0.6, id: 1, lay: 8, lvl: 0.494 }),
      P({ ...PAD, k: 'sub', w: 1, det: 10, fc: 1.5, fe: 0.5, fd: 2, a: 0.4, s: 1, lvl: 0.3 }),
      P({ ...PAD, k: 'sub', w: 1, det: 12, fc: 2, fe: 3, fd: 0.6, a: 0.02, d: 1, s: 0.6, r: 0.5, lvl: 0.28 }),
      P({ ...PAD, i0: 0.6, i1: 0.6, lay: 10, vib: 6, a: 0.4, s: 1, lvl: 0.676 }),
      P({ ...PAD, i0: 1, i1: 1, lay: 5, fb: 0.2, a: 0.5, s: 1, lvl: 0.35 }),
      P({ ...PAD, mr: 3.5, i0: 2, i1: 0.8, id: 1, lay: 6, a: 0.1, d: 3, s: 0.5, lvl: 0.3 }),
      P({ ...PAD, i0: 0.5, i1: 0.5, lay: 12, a: 0.6, s: 1, r: 1.5, vib: 4, lvl: 0.676 }),
      P({ ...PAD, k: 'sub', w: 1, det: 9, fc: 0.8, fe: 6, fa: 1.5, fd: 3, a: 0.3, s: 1, lvl: 0.3 }),
      // Synth effects
      P({ mr: 7.3, i0: 2, i1: 0.2, id: 0.5, d: 2, lay: 9, kd: 0, lvl: 0.35 }),
      P({ ...PAD, i0: 1, i1: 1, lay: 7, a: 0.5, s: 1, lvl: 0.35 }),
      P({ mr: 5.1, i0: 2, i1: 0.3, id: 0.4, d: 3, lay: 5, kd: 0, lvl: 0.35 }),
      P({ i0: 2, i1: 0.5, id: 1, d: 3, s: 0.5, r: 1, lay: 8, kd: 0, lvl: 0.35 }),
      P({ mr: 2, i0: 3, i1: 2, id: 1, a: 0.1, d: 2, s: 0.7, r: 1, lay: 10, kd: 0, lvl: 0.3 }),
      P({ mr: 0.5, i0: 4, i1: 3, a: 1, d: 2, s: 0.8, r: 1, vib: 40, vd: 0, vr: 3, kd: 0, lvl: 0.672 }),
      P({ mr: 3, i0: 2, i1: 0.5, id: 0.8, d: 2, s: 0.3, r: 1.5, lay: 9, kd: 0, lvl: 0.32 }),
      P({ mr: 1.41, i0: 5, i1: 2, id: 1, a: 0.2, d: 2, s: 0.6, r: 1, vib: 50, vd: 0, vr: 2, kd: 0, lvl: 0.3 }),
      // Ethnic
      P({ i0: 4, i1: 1, id: 0.6, d: 2.5, fb: 0.6, lvl: 0.711 }),
      P({ i0: 4, i1: 0.3, id: 0.08, d: 0.8, fb: 0.2, lvl: 0.45 }),
      P({ i0: 5, i1: 0.3, id: 0.05, d: 0.7, lvl: 0.45 }),
      P({ i0: 3, i1: 0.3, id: 0.15, d: 1.5, lvl: 0.45 }),
      P({ mr: 3.5, i0: 1.5, i1: 0, id: 0.05, d: 0.8, lvl: 0.5 }),
      P({ a: 0.05, d: 1, s: 1, r: 0.1, kd: 0, i0: 3, i1: 3, fb: 0.6, lay: 4, lvl: 0.3 }),
      P({ ...STR, i0: 2, i1: 2, fb: 0.35, lvl: 0.4 }),
      P({ ...RED, i0: 2.8, i1: 2.8, fb: 0.6, mw: 1, lvl: 0.3 }),
      // Percussive
      P({ mr: 5.4, i0: 3, i1: 0, id: 0.2, d: 1.5, kd: 0.5, lvl: 0.35 }),
      P({ mr: 2.7, i0: 2, i1: 0, id: 0.1, d: 0.4, kd: 0, lvl: 0.4 }),
      P({ mr: 2.4, i0: 1.5, i1: 0.2, id: 0.2, d: 1, kd: 0.5, lvl: 0.45 }),
      P({ mr: 3.2, i0: 3, i1: 0, id: 0.02, d: 0.08, kd: 0, lvl: 0.55 }),
      P({ mr: 1.6, i0: 3, i1: 0, id: 0.05, d: 0.5, kd: 0, pd: 5, pdt: 0.05, lvl: 0.7 }),
      P({ i0: 1, i1: 0, id: 0.1, d: 0.5, kd: 0, pd: 7, pdt: 0.1, lvl: 0.6 }),
      P({ i0: 0.5, i1: 0, id: 0.1, d: 0.5, kd: 0, pd: 12, pdt: 0.15, lvl: 0.6 }),
      P({ k: 'noise', nf: 'hp', f: 6000, q: 0.7, a: 1.5, d: 0.05, s: 0, r: 0.05, kd: 0, lvl: 0.4 }),
      // Sound effects
      P({ k: 'noise', nf: 'bp', f: 3000, q: 2, a: 0.002, d: 0.1, s: 0, kd: 0, lvl: 1.127 }),
      P({ k: 'noise', nf: 'bp', f: 1200, q: 1, a: 0.1, d: 1, s: 0.7, r: 0.2, kd: 0, lvl: 0.177 }),
      P({ k: 'noise', nf: 'lp', f: 900, q: 0.7, a: 1, d: 1, s: 1, r: 1.5, trem: 0.7, tr: 0.12, kd: 0, lvl: 0.889 }),
      P({ i0: 0.5, i1: 0.5, a: 0.01, d: 1, s: 1, r: 0.1, vib: 400, vd: 0, vr: 14, kd: 0, lvl: 0.3 }),
      P({ mr: 1.5, i0: 1.5, i1: 1.5, a: 0.005, d: 1, s: 1, r: 0.05, trem: 1, tr: 16, kd: 0, lvl: 0.3 }),
      P({ k: 'noise', nf: 'lp', f: 500, q: 2, a: 0.3, d: 1, s: 1, r: 0.5, trem: 1, tr: 11, kd: 0, lvl: 0.6 }),
      P({ k: 'noise', nf: 'bp', f: 2500, q: 0.7, a: 0.3, d: 1, s: 1, r: 1, trem: 0.5, tr: 17, kd: 0, lvl: 0.251 }),
      P({ k: 'noise', nf: 'lp', f: 2000, q: 0.7, a: 0.001, d: 0.4, s: 0, r: 0.1, kd: 0, lvl: 1.423 }),
    ];

    // Common per-block pitch modulation for the built-in voices.
    function blockFreq(v, p, c, n) {
      const t = v.t;
      v.t += n / SR;
      let cents = chanCents(c);
      const vib = (p.vib && t >= p.vd ? p.vib : 0) + (c.mod / 127) * 50;
      if (vib) { v.lfo += (n / SR) * p.vr; cents += vib * Math.sin(TAU * v.lfo); }
      if (p.pd) cents += p.pd * 100 * Math.exp(-t / p.pdt);
      return v.freq * Math.pow(2, cents / 1200);
    }
    function tremolo(v, p, n) {
      if (!p.trem) return 1;
      v.trp += (n / SR) * p.tr;
      return 1 - p.trem * (0.5 - 0.5 * Math.cos(TAU * v.trp));
    }

    class FMVoice extends Voice {
      constructor(p, ch, key, vel) {
        super(ch, key, vel);
        this.p = p;
        const ks = Math.pow(2, ((60 - key) / 24) * p.kd);
        this.env = new Env(p.a, p.d * ks, p.s, p.r);
        this.vg = Math.pow(vel / 127, 1.7) * p.lvl;
        const vs = 0.55 + (0.45 * vel) / 127;
        this.ix = (p.i0 * vs) / TAU; this.ixs = (p.i1 * vs) / TAU;
        this.ixk = Math.exp(-BLOCK / (Math.max(p.id, 0.005) * SR));
        this.freq = mtof(key);
        this.mp = this.cp = this.m1 = this.m2 = 0;
        this.mp2 = 0.25; this.cp2 = 0.5; this.n1 = this.n2 = 0;
        this.lfo = 0; this.trp = 0;
        this.layMul = p.lay ? Math.pow(2, p.lay / 1200) : 0;
        if (p.nz) this.nf = new Biquad().set('bp', clamp(this.freq * 2, 300, 8000), 1.2);
      }
      render(buf, n, c) {
        const p = this.p;
        const f = blockFreq(this, p, c, n);
        const cinc = (f * p.cr) / SR, minc = (f * p.mr) / SR;
        const tm = tremolo(this, p, n);
        const a0 = this.env.v, a1 = this.env.step();
        let ix0 = this.ix;
        this.ix = this.ixs + (this.ix - this.ixs) * this.ixk;
        let ix1 = this.ix;
        if (p.follow) { ix0 *= 0.4 + 0.6 * a0; ix1 *= 0.4 + 0.6 * a1; }
        const g0 = a0 * this.vg * tm, g1 = a1 * this.vg * tm;
        const dg = (g1 - g0) / n, dix = (ix1 - ix0) / n;
        const CW = WAVES[p.cw], MW = WAVES[p.mw], fb = p.fb * 0.25, lay = this.layMul, nf = this.nf, nz = p.nz * 3;
        let mp = this.mp, cp = this.cp, m1 = this.m1, m2 = this.m2, mp2 = this.mp2, cp2 = this.cp2, n1 = this.n1, n2 = this.n2;
        let g = g0, ix = ix0;
        const minc2 = minc * lay, cinc2 = cinc * lay;
        for (let i = 0; i < n; i++) {
          mp += minc; mp -= mp | 0;
          cp += cinc; cp -= cp | 0;
          const mv = MW[((mp + (m1 + m2) * fb) * TBL) & TMASK];
          m2 = m1; m1 = mv;
          let s = CW[((cp + mv * ix) * TBL) & TMASK];
          if (lay) {
            mp2 += minc2; mp2 -= mp2 | 0;
            cp2 += cinc2; cp2 -= cp2 | 0;
            const mv2 = MW[((mp2 + (n1 + n2) * fb) * TBL) & TMASK];
            n2 = n1; n1 = mv2;
            s = (s + CW[((cp2 + mv2 * ix) * TBL) & TMASK]) * 0.6;
          }
          if (nf) s += nf.run(rnd()) * nz;
          buf[i] = s * g;
          g += dg; ix += dix;
        }
        this.mp = mp; this.cp = cp; this.m1 = m1; this.m2 = m2;
        this.mp2 = mp2; this.cp2 = cp2; this.n1 = n1; this.n2 = n2;
        this.lvl = g1;
        this.done = this.env.done;
      }
    }

    class SubVoice extends Voice {
      constructor(p, ch, key, vel) {
        super(ch, key, vel);
        this.p = p;
        this.env = new Env(p.a, p.d, p.s, p.r);
        this.vg = Math.pow(vel / 127, 1.7) * p.lvl;
        this.vf = 0.5 + (0.5 * vel) / 127;
        this.freq = mtof(key);
        this.ph1 = 0; this.ph2 = 0.37; this.lfo = 0; this.trp = 0;
        this.detMul = p.det ? Math.pow(2, p.det / 1200) : 0;
        this.flt = new Biquad();
        if (p.nz) this.nf = new Biquad().set('bp', clamp(this.freq * 2, 300, 8000), 1);
      }
      render(buf, n, c) {
        const p = this.p, t = this.t;
        const f = blockFreq(this, p, c, n);
        const fe = t < p.fa ? t / p.fa : Math.exp(-(t - p.fa) / p.fd);
        this.flt.set('lp', f * (p.fc + p.fe * fe * this.vf), p.fq);
        const tm = tremolo(this, p, n);
        const a0 = this.env.v, a1 = this.env.step();
        const g0 = a0 * this.vg * tm, g1 = a1 * this.vg * tm, dg = (g1 - g0) / n;
        const dt1 = f / SR, dt2 = dt1 * this.detMul, sq = p.w === 2, flt = this.flt, nf = this.nf, nz = p.nz * 3;
        let ph1 = this.ph1, ph2 = this.ph2, g = g0;
        for (let i = 0; i < n; i++) {
          ph1 += dt1; if (ph1 >= 1) ph1 -= 1;
          let s = sq ? (ph1 < 0.5 ? 1 : -1) + blep(ph1, dt1) - blep((ph1 + 0.5) % 1, dt1) : 2 * ph1 - 1 - blep(ph1, dt1);
          if (dt2) {
            ph2 += dt2; if (ph2 >= 1) ph2 -= 1;
            s += sq ? (ph2 < 0.5 ? 1 : -1) + blep(ph2, dt2) - blep((ph2 + 0.5) % 1, dt2) : 2 * ph2 - 1 - blep(ph2, dt2);
            s *= 0.6;
          }
          if (nf) s += nf.run(rnd()) * nz;
          buf[i] = flt.run(s) * g;
          g += dg;
        }
        this.ph1 = ph1; this.ph2 = ph2;
        this.lvl = g1;
        this.done = this.env.done;
      }
    }

    class NoiseVoice extends Voice {
      constructor(p, ch, key, vel) {
        super(ch, key, vel);
        this.p = p;
        this.env = new Env(p.a, p.d, p.s, p.r);
        this.vg = Math.pow(vel / 127, 1.5) * p.lvl;
        this.flt = new Biquad().set(p.nf, p.f * Math.pow(2, (key - 60) / 24), p.q);
        this.trp = 0;
      }
      render(buf, n) {
        const p = this.p;
        this.t += n / SR;
        const tm = tremolo(this, p, n);
        const a0 = this.env.v, a1 = this.env.step();
        const g0 = a0 * this.vg * tm, g1 = a1 * this.vg * tm, dg = (g1 - g0) / n;
        let g = g0;
        for (let i = 0; i < n; i++) { buf[i] = this.flt.run(rnd()) * g; g += dg; }
        this.lvl = g1;
        this.done = this.env.done;
      }
    }

    // ---- Drum kit for the FM engine -----------------------------------------
    // tone: sine sweeping f0 -> f1 (time const sw), decay td, level tl
    // noise: filter nt/nf/nq, decay nd, level nl; metal: square (or sine `ms`)
    // cluster at freqs mf or 808 hat ratios \u00d7 mx, decay md, level ml, filter mt/mh
    const HAT = [205.3, 304.4, 369.6, 522.7, 540, 800];
    function drumRecipe(k, kit) {
      const e = kit >= 24 && kit < 32; // electronic / TR-808 kits
      switch (k) {
        case 35: return { f0: 140, f1: 42, sw: 0.045, td: e ? 0.8 : 0.4, tl: 1, nl: 0.25, nd: 0.012, nt: 'lp', nf: 2500, lvl: 1 };
        case 36: return { f0: e ? 130 : 165, f1: 48, sw: e ? 0.06 : 0.035, td: e ? 0.9 : 0.32, tl: 1, nl: 0.3, nd: 0.01, nt: 'lp', nf: 3000, lvl: 1 };
        case 37: return { f0: 1700, td: 0.02, tl: 0.4, nl: 0.5, nd: 0.03, nt: 'bp', nf: 2500, nq: 1, lvl: 0.6 };
        case 38: return { f0: 260, f1: 180, sw: 0.03, td: e ? 0.15 : 0.1, tl: e ? 0.7 : 0.5, nl: 0.8, nd: e ? 0.22 : 0.18, nt: 'hp', nf: 1500, lvl: 0.85 };
        case 39: return { nl: 1, nd: 0.2, nt: 'bp', nf: 1200, nq: 1.5, clap: 1, lvl: 0.9 };
        case 40: return { f0: 290, f1: 200, sw: 0.02, td: 0.08, tl: 0.5, nl: 0.9, nd: 0.15, nt: 'hp', nf: 2500, lvl: 0.85 };
        case 41: case 43: case 45: case 47: case 48: case 50: {
          const f = { 41: 85, 43: 100, 45: 120, 47: 140, 48: 165, 50: 195 }[k];
          return { f0: f * 1.6, f1: f, sw: 0.06, td: 0.45, tl: 0.9, nl: 0.15, nd: 0.05, nt: 'lp', nf: 900, lvl: 0.85 };
        }
        case 42: return { ml: 0.6, md: 0.05, nl: 0.35, nd: 0.045, nt: 'hp', nf: 7500, choke: 1, lvl: 0.45 };
        case 44: return { ml: 0.5, md: 0.08, nl: 0.25, nd: 0.06, nt: 'hp', nf: 7500, choke: 1, lvl: 0.35 };
        case 46: return { ml: 0.6, md: 0.45, nl: 0.35, nd: 0.4, nt: 'hp', nf: 7000, choke: 1, lvl: 0.42 };
        case 49: case 57: return { ml: 0.45, md: 1.6, mx: k === 57 ? 1.1 : 1, nl: 0.6, nd: 1.8, nt: 'hp', nf: 5000, lvl: 0.5 };
        case 51: case 59: return { ml: 0.5, md: 1.2, mx: 1.6, nl: 0.2, nd: 0.8, nt: 'hp', nf: 8000, f0: 3200, td: 0.6, tl: 0.08, lvl: 0.35 };
        case 52: return { ml: 0.6, md: 1.0, mx: 0.8, nl: 0.6, nd: 1.2, nt: 'bp', nf: 4000, nq: 0.8, lvl: 0.45 };
        case 53: return { ml: 0.4, md: 0.9, mx: 2, f0: 2400, td: 0.9, tl: 0.3, lvl: 0.4 };
        case 54: return { ml: 0.4, md: 0.18, mx: 3, nl: 0.6, nd: 0.15, nt: 'bp', nf: 9000, nq: 1.2, lvl: 0.4 };
        case 55: return { ml: 0.45, md: 0.6, mx: 1.3, nl: 0.5, nd: 0.7, nt: 'hp', nf: 6000, lvl: 0.45 };
        case 56: return { mf: [545, 815], ml: 1, md: 0.3, mt: 'bp', mh: 1000, lvl: 0.5 };
        case 58: return { nl: 0.7, nd: 0.6, nt: 'bp', nf: 3000, nq: 4, trem: 30, lvl: 0.4 };
        case 60: return { f0: 440, f1: 400, sw: 0.01, td: 0.12, tl: 0.8, lvl: 0.6 };
        case 61: return { f0: 320, f1: 290, sw: 0.01, td: 0.15, tl: 0.8, lvl: 0.6 };
        case 62: return { f0: 360, f1: 330, sw: 0.01, td: 0.06, tl: 0.8, nl: 0.2, nd: 0.02, nt: 'bp', nf: 2000, lvl: 0.6 };
        case 63: return { f0: 370, f1: 340, sw: 0.02, td: 0.25, tl: 0.8, lvl: 0.6 };
        case 64: return { f0: 260, f1: 240, sw: 0.02, td: 0.3, tl: 0.8, lvl: 0.6 };
        case 65: return { f0: 560, f1: 520, sw: 0.01, td: 0.2, tl: 0.6, nl: 0.3, nd: 0.08, nt: 'bp', nf: 4000, lvl: 0.55 };
        case 66: return { f0: 420, f1: 390, sw: 0.01, td: 0.25, tl: 0.6, nl: 0.3, nd: 0.08, nt: 'bp', nf: 3000, lvl: 0.55 };
        case 67: return { mf: [1200, 1940], ms: 1, ml: 0.8, md: 0.2, mt: 'bp', mh: 1500, lvl: 0.45 };
        case 68: return { mf: [900, 1450], ms: 1, ml: 0.8, md: 0.22, mt: 'bp', mh: 1100, lvl: 0.45 };
        case 69: return { nl: 0.6, nd: 0.08, nt: 'hp', nf: 9000, lvl: 0.4 };
        case 70: return { nl: 0.6, nd: 0.05, nt: 'hp', nf: 7000, lvl: 0.4 };
        case 71: return { f0: 2500, td: 0.12, tl: 0.4, lvl: 0.4 };
        case 72: return { f0: 2400, td: 0.6, tl: 0.4, lvl: 0.4 };
        case 73: return { nl: 0.6, nd: 0.12, nt: 'bp', nf: 3000, nq: 3, trem: 45, lvl: 0.4 };
        case 74: return { nl: 0.6, nd: 0.35, nt: 'bp', nf: 3000, nq: 3, trem: 30, lvl: 0.4 };
        case 75: return { f0: 2500, td: 0.06, tl: 0.7, lvl: 0.5 };
        case 76: return { f0: 1900, f1: 1750, sw: 0.005, td: 0.05, tl: 0.7, lvl: 0.5 };
        case 77: return { f0: 1350, f1: 1250, sw: 0.005, td: 0.06, tl: 0.7, lvl: 0.5 };
        case 78: return { f0: 600, f1: 850, sw: 0.05, td: 0.12, tl: 0.5, lvl: 0.45 };
        case 79: return { f0: 380, f1: 620, sw: 0.08, td: 0.3, tl: 0.5, lvl: 0.45 };
        case 80: return { mf: [4000, 5600, 7200], ms: 1, ml: 0.6, md: 0.12, mt: 'bp', mh: 5000, lvl: 0.35 };
        case 81: return { mf: [4000, 5600, 7200], ms: 1, ml: 0.6, md: 1.2, mt: 'bp', mh: 5000, lvl: 0.35 };
        case 82: return { nl: 0.6, nd: 0.08, nt: 'hp', nf: 6000, lvl: 0.4 };
        case 85: return { f0: 2200, td: 0.04, tl: 0.6, nl: 0.3, nd: 0.02, nt: 'bp', nf: 3000, lvl: 0.45 };
        case 86: return { f0: 90, f1: 80, sw: 0.02, td: 0.2, tl: 0.9, lvl: 0.7 };
        case 87: return { f0: 85, f1: 75, sw: 0.03, td: 0.6, tl: 0.9, lvl: 0.7 };
        default: return { nl: 0.4, nd: 0.05, nt: 'bp', nf: 3000, f0: 1500, td: 0.03, tl: 0.3, lvl: 0.4 };
      }
    }

    class DrumVoice extends Voice {
      constructor(r, ch, key, vel) {
        super(ch, key, vel);
        this.drum = this.oneShot = true;
        this.choke = r.choke || 0;
        this.r = r;
        this.env = new Env(0.0005, 60, 1, 0.01);
        this.vg = Math.pow(vel / 127, 1.5) * (r.lvl || 0.8);
        const k = (d) => Math.exp(-6.9 / (Math.max(d || 0.01, 0.001) * SR));
        this.ta = r.f0 ? r.tl || 0.5 : 0; this.tk = k(r.td); this.tp = 0;
        this.na = r.nl || 0; this.nk = k(r.nd);
        if (this.na) this.nflt = new Biquad().set(r.nt || 'bp', r.nf || 3000, r.nq || 0.9);
        this.ma = r.ml || 0; this.mk = k(r.md);
        if (this.ma) {
          this.mf = (r.mf || HAT.map((f) => f * 9 * (r.mx || 1))).map((f) => f / SR);
          this.mph = this.mf.map(() => rnd() * 0.5 + 0.5);
          this.mflt = new Biquad().set(r.mt || 'hp', r.mh || 7000, r.mt === 'bp' ? 3 : 0.8);
        }
        this.si = 0;
      }
      render(buf, n) {
        const r = this.r;
        this.t += n / SR;
        const a0 = this.env.v, a1 = this.env.step();
        const g0 = a0 * this.vg, dg = (a1 * this.vg - g0) / n;
        let g = g0;
        let inc = 0;
        if (this.ta > 1e-5) {
          const f = r.f1 ? r.f1 + (r.f0 - r.f1) * Math.exp(-this.t / (r.sw || 0.05)) : r.f0;
          inc = f / SR;
        }
        const mf = this.mf, mph = this.mph, nm = mf ? mf.length : 0, ms = r.ms;
        for (let i = 0; i < n; i++) {
          let s = 0;
          if (this.ta > 1e-5) { this.tp += inc; this.tp -= this.tp | 0; s += SINE[(this.tp * TBL) & TMASK] * this.ta; this.ta *= this.tk; }
          if (this.na > 1e-5) {
            let x = this.nflt.run(rnd()) * this.na;
            const ts = this.si / SR;
            if (r.clap && ts < 0.033) x *= Math.exp(-(ts % 0.011) / 0.0025) * 1.6;
            if (r.trem) x *= 0.5 + 0.5 * Math.sin(TAU * r.trem * ts);
            s += x; this.na *= this.nk;
          }
          if (this.ma > 1e-5) {
            let m = 0;
            for (let k = 0; k < nm; k++) {
              mph[k] += mf[k]; if (mph[k] >= 1) mph[k] -= 1;
              m += ms ? SINE[(mph[k] * TBL) & TMASK] : mph[k] < 0.5 ? 1 : -1;
            }
            s += this.mflt.run(m / nm) * this.ma * 2; this.ma *= this.mk;
          }
          this.si++;
          buf[i] = s * g;
          g += dg;
        }
        this.lvl = a1 * this.vg * Math.max(this.ta, this.na, this.ma);
        if ((this.ta < 1e-5 && this.na < 1e-5 && this.ma < 1e-5) || this.env.done) this.done = true;
      }
    }

    // ---- SoundFont (wavetable) voice ----------------------------------------
    class SampleVoice extends Voice {
      constructor(sf, g, s, ch, key, vel, drum) {
        super(ch, key, vel);
        this.data = sf.data;
        const sk = g[46] >= 0 ? g[46] : key, sv = g[47] >= 0 ? g[47] : vel;
        const len = this.data.length;
        this.start = clamp(s.start + g[0] + 32768 * g[4], 0, len - 1);
        this.end = clamp(s.end + g[1] + 32768 * g[12], this.start + 1, len);
        this.ls = s.ls + g[2] + 32768 * g[45];
        this.le = s.le + g[3] + 32768 * g[50];
        const mode = g[54] & 3;
        this.loopMode = this.ls >= this.start && this.le <= this.end && this.le - this.ls > 2 ? mode : 0;
        this.looping = this.loopMode === 1 || this.loopMode === 3;
        this.drum = drum; this.oneShot = drum && !this.looping;
        const root = g[58] >= 0 ? g[58] : s.pitch === 255 ? 60 : s.pitch;
        this.baseCents = (sk - root) * g[56] + g[51] * 100 + g[52] + s.corr;
        this.rate0 = s.rate / SR;
        this.pos = this.start;
        this.gain = cb2amp(g[48] * 0.4) * (sv / 127) * (sv / 127);
        this.pan = clamp(g[17], -500, 500) / 500;
        this.rev = clamp(g[16], 0, 1000) / 1000;
        this.cho = clamp(g[15], 0, 1000) / 1000;
        this.excl = g[57];
        this.env = new SFEnv(tc2s(g[33]), tc2s(g[34]), tc2s(g[35] + g[39] * (60 - sk)), tc2s(g[36] + g[40] * (60 - sk)), g[37], tc2s(g[38]));
        this.menv = new ModEnv(tc2s(g[25]), tc2s(g[26]), tc2s(g[27] + g[31] * (60 - sk)), tc2s(g[28] + g[32] * (60 - sk)), 1 - g[29] / 1000, tc2s(g[30]));
        this.envPitch = g[7]; this.envFc = g[11];
        this.vibDelay = tc2s(g[23]); this.vibFreq = 8.176 * tc2s(g[24]); this.vibPitch = g[6]; this.vibPh = 0;
        this.modDelay = tc2s(g[21]); this.modFreq = 8.176 * tc2s(g[22]); this.modPh = 0;
        this.modPitch = g[5]; this.modFc = g[10]; this.modVol = g[13];
        this.fc = g[8]; this.q = Math.pow(10, (Math.max(g[9], 0) / 10 - 3.01) / 20);
        this.useFilter = g[8] < 13500 || g[11] || g[10];
        if (this.useFilter) this.flt = new Biquad();
      }
      release() {
        super.release();
        this.menv.release();
        if (this.loopMode === 3) this.looping = false;
      }
      render(buf, n, c) {
        const dt = n / SR;
        this.t += dt;
        let vib = 0, modl = 0;
        if (this.t >= this.vibDelay) { this.vibPh += this.vibFreq * dt; vib = tri(this.vibPh); }
        if (this.t >= this.modDelay) { this.modPh += this.modFreq * dt; modl = tri(this.modPh); }
        const me = this.menv.step();
        const cents = this.baseCents + chanCents(c) + vib * (this.vibPitch + (c.mod / 127) * 50) + modl * this.modPitch + me * this.envPitch;
        const rate = this.rate0 * Math.pow(2, cents / 1200);
        const flt = this.useFilter ? this.flt : null;
        if (flt) flt.set('lp', 8.176 * Math.pow(2, (this.fc + me * this.envFc + modl * this.modFc) / 1200), this.q);
        let gm = this.gain;
        if (this.modVol) gm *= cb2amp(modl * this.modVol);
        const a0 = this.env.v * gm, a1 = this.env.step() * gm, dg = (a1 - a0) / n;
        const D = this.data, ls = this.ls, le = this.le, end = this.end, looping = this.looping;
        let pos = this.pos, g = a0, i = 0;
        for (; i < n; i++) {
          const ip = pos | 0, fr = pos - ip;
          let nx = ip + 1;
          if (looping && nx >= le) nx = ls;
          const s0 = D[ip], s1 = nx < end ? D[nx] : 0;
          let s = (s0 + (s1 - s0) * fr) * 3.0517578125e-5;
          if (flt) s = flt.run(s);
          buf[i] = s * g;
          g += dg;
          pos += rate;
          if (looping) { if (pos >= le) pos -= le - ls; }
          else if (pos >= end - 1) { this.done = true; i++; break; }
        }
        for (; i < n; i++) buf[i] = 0;
        this.pos = pos;
        this.lvl = a1;
        if (this.env.done) this.done = true;
      }
    }

    // ---- Effects ------------------------------------------------------------
    class Comb {
      constructor(size) { this.buf = new Float32Array(size); this.i = 0; this.store = 0; }
    }
    class Reverb { // Freeverb (Jezar at Dreampoint, public domain)
      constructor() {
        const sc = SR / 44100;
        const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        const aps = [556, 441, 341, 225];
        this.cl = combs.map((s) => new Comb(Math.round(s * sc)));
        this.cr = combs.map((s) => new Comb(Math.round((s + 23) * sc)));
        this.al = aps.map((s) => new Comb(Math.round(s * sc)));
        this.ar = aps.map((s) => new Comb(Math.round((s + 23) * sc)));
        this.fb = 0.82; this.damp = 0.3; this.wet = 1.4;
      }
      process(inp, L, R, n) {
        const fb = this.fb, d1 = this.damp, d2 = 1 - this.damp;
        const run = (cs, x) => {
          let out = 0;
          for (let k = 0; k < cs.length; k++) {
            const c = cs[k], y = c.buf[c.i];
            c.store = y * d2 + c.store * d1;
            c.buf[c.i] = x + c.store * fb;
            if (++c.i >= c.buf.length) c.i = 0;
            out += y;
          }
          return out;
        };
        const ap = (as, x) => {
          for (let k = 0; k < as.length; k++) {
            const a = as[k], b = a.buf[a.i];
            a.buf[a.i] = x + b * 0.5;
            if (++a.i >= a.buf.length) a.i = 0;
            x = b - x;
          }
          return x;
        };
        for (let i = 0; i < n; i++) {
          const x = inp[i] * 0.015;
          L[i] += ap(this.al, run(this.cl, x)) * this.wet;
          R[i] += ap(this.ar, run(this.cr, x)) * this.wet;
        }
      }
    }
    class Chorus {
      constructor() { this.size = 4096; this.bl = new Float32Array(this.size); this.w = 0; this.ph = 0; }
      process(inp, L, R, n) {
        const B = this.bl, M = this.size - 1;
        const read = (d) => {
          const p = this.w - d, i = Math.floor(p), f = p - i;
          return B[i & M] + (B[(i + 1) & M] - B[i & M]) * f;
        };
        for (let i = 0; i < n; i++) {
          B[this.w] = inp[i];
          this.ph += 0.5 / SR;
          const s = Math.sin(TAU * this.ph), c = Math.cos(TAU * this.ph);
          L[i] += read((0.012 + 0.0025 * s) * SR) * 0.8;
          R[i] += read((0.013 + 0.0025 * c) * SR) * 0.8;
          this.w = (this.w + 1) & M;
        }
      }
    }

    // ---- Channels -------------------------------------------------------------
    function resetCtl(c) {
      c.expr = 127; c.mod = 0; c.sustain = false; c.bend = 0; c.rpn = 0x3fff; c.dataMsb = 0;
    }
    function newChannel(i) {
      const c = { prog: 0, msb: 0, lsb: 0, vol: 100, pan: 64, rev: 40, cho: 0, bendRange: 2, coarse: 0, fine: 0, drum: i === 9 };
      resetCtl(c);
      return c;
    }

    // ---- The processor ----------------------------------------------------------
    class CrescendoSynth extends AudioWorkletProcessor {
      constructor() {
        super();
        this.voices = [];
        this.chans = [];
        for (let i = 0; i < 16; i++) this.chans.push(newChannel(i));
        this.engine = 'fm'; this.sf = null; this.midiOut = false; this.xg = false;
        this.master = 0.8; this.sysVol = 1;
        this.song = null; this.idx = 0; this.pos = 0; this.playing = false; this.loops = 0;
        this.tmp = new Float32Array(BLOCK);
        this.rev = new Float32Array(BLOCK);
        this.cho = new Float32Array(BLOCK);
        this.reverb = new Reverb();
        this.chorus = new Chorus();
        this.choActive = 0;
        this.levels = new Float32Array(16);
        this.blocks = 0;
        this.outQ = [];
        this.port.onmessage = (e) => this.onMessage(e.data);
      }

      onMessage(m) {
        switch (m.cmd) {
          case 'load':
            this.playing = false;
            this.song = { times: m.times, msgs: m.msgs, sysex: new Map(m.sysex), dur: m.duration };
            this.seek(0);
            break;
          case 'play': if (this.song) this.playing = true; break;
          case 'pause': this.playing = false; this.allNotesOff(); this.report(); break;
          case 'stop':
            this.playing = false;
            this.allNotesOff();
            this.rewind();
            this.report();
            break;
          case 'seek': this.seek(m.t); this.report(); break;
          case 'loop': this.loops = m.n; break;
          case 'volume': this.master = m.v; break;
          case 'engine':
            if (this.midiOut && m.kind !== 'midi') this.deviceReset();
            this.engine = m.kind;
            this.midiOut = m.kind === 'midi';
            if (this.midiOut) { for (const v of this.voices) v.kill(); this.seek(this.pos); }
            break;
          case 'sf2': this.loadBank(m.bank); break;
          case 'panic': for (const v of this.voices) v.kill(); break;
        }
      }

      loadBank(b) {
        const map = new Map();
        for (const p of b.presets) {
          const key = p.bank * 128 + p.prog;
          if (!map.has(key)) map.set(key, p);
        }
        this.sf = { map, instruments: b.instruments, samples: b.samples, data: b.data };
      }

      resetChannels() {
        for (let i = 0; i < 16; i++) this.chans[i] = newChannel(i);
        this.sysVol = 1;
      }

      deviceReset() {
        for (let ch = 0; ch < 16; ch++) {
          this.outQ.push(0xb0 | ch | (123 << 8), 0xb0 | ch | (121 << 8), 0xb0 | ch | (120 << 8));
        }
      }

      allNotesOff(keepOneShots) {
        for (const v of this.voices) if (!(keepOneShots && v.oneShot)) v.release();
        if (this.midiOut) for (let ch = 0; ch < 16; ch++) this.outQ.push(0xb0 | ch | (123 << 8), 0xb0 | ch | (64 << 8));
      }

      rewind() {
        this.resetChannels();
        this.idx = 0; this.pos = 0;
        if (this.midiOut) this.deviceReset();
      }

      // Jump to `t` seconds, re-applying every controller/program change before it.
      seek(t) {
        for (const v of this.voices) v.kill();
        this.resetChannels();
        if (this.midiOut) this.deviceReset();
        this.pos = Math.max(0, t);
        this.idx = 0;
        if (!this.song) return;
        const { times, msgs } = this.song;
        let i = 0;
        for (; i < times.length && times[i] < t; i++) {
          const kind = msgs[i] & 0xf0;
          if (kind !== 0x90 && kind !== 0x80) this.dispatch(msgs[i], i);
        }
        this.idx = i;
      }

      dispatch(m, i) {
        const st = m & 0xff;
        if (st === 0xf0) { this.sysex(this.song.sysex.get(i)); return; }
        const a = (m >> 8) & 0x7f, b = (m >> 16) & 0x7f, ch = st & 15;
        if (this.midiOut) this.outQ.push(m);
        switch (st & 0xf0) {
          case 0x80: this.noteOff(ch, a); break;
          case 0x90: if (b) this.noteOn(ch, a, b); else this.noteOff(ch, a); break;
          case 0xb0: this.cc(ch, a, b); break;
          case 0xc0: this.chans[ch].prog = a; break;
          case 0xe0: this.chans[ch].bend = ((b << 7) | a) - 8192; break;
        }
      }

      sysex(d) {
        if (!d || d.length < 4) return;
        if (d[0] === 0x7e && d[2] === 0x09) { this.xg = false; this.resetChannels(); return; } // GM on/off
        if (d[0] === 0x7f && d[2] === 0x04 && d[3] === 0x01 && d.length >= 6) { this.sysVol = d[5] / 127; return; }
        if (d[0] === 0x41 && d[2] === 0x42 && d[3] === 0x12 && d.length >= 8) { // Roland GS
          if (d[4] === 0x40 && d[5] === 0x00 && d[6] === 0x7f) { this.xg = false; this.resetChannels(); return; }
          if (d[4] === 0x40 && (d[5] & 0xf0) === 0x10 && d[6] === 0x15) {
            const part = d[5] & 15, ch = part === 0 ? 9 : part <= 9 ? part - 1 : part;
            this.chans[ch].drum = d[7] !== 0;
          }
          return;
        }
        if (d[0] === 0x43 && d[2] === 0x4c && d[3] === 0 && d[4] === 0 && d[5] === 0x7e) { this.xg = true; this.resetChannels(); }
      }

      cc(ch, n, v) {
        const c = this.chans[ch];
        switch (n) {
          case 0: c.msb = v; if (v === 120 || (this.xg && v === 127)) c.drum = true; else if (this.xg && ch !== 9) c.drum = false; break;
          case 32: c.lsb = v; break;
          case 1: c.mod = v; break;
          case 7: c.vol = v; break;
          case 10: c.pan = v; break;
          case 11: c.expr = v; break;
          case 64:
            c.sustain = v >= 64;
            if (!c.sustain) for (const vo of this.voices) if (vo.ch === ch && vo.held) { vo.held = false; vo.release(); }
            break;
          case 91: c.rev = v; break;
          case 93: c.cho = v; break;
          case 98: case 99: c.rpn = 0x3fff; break;
          case 100: c.rpn = (c.rpn & 0x3f80) | v; break;
          case 101: c.rpn = (c.rpn & 0x7f) | (v << 7); break;
          case 6:
            c.dataMsb = v;
            if (c.rpn === 0) c.bendRange = v;
            else if (c.rpn === 1) c.fine = ((v << 7) - 8192) / 81.92;
            else if (c.rpn === 2) c.coarse = v - 64;
            break;
          case 38:
            if (c.rpn === 0) c.bendRange = c.dataMsb + v / 100;
            else if (c.rpn === 1) c.fine = (((c.dataMsb << 7) | v) - 8192) / 81.92;
            break;
          case 120: for (const vo of this.voices) if (vo.ch === ch) vo.kill(); break;
          case 121: resetCtl(c); break;
          default:
            if (n >= 123) for (const vo of this.voices) if (vo.ch === ch && !vo.oneShot) vo.release();
        }
      }

      noteOn(ch, key, vel) {
        if (this.midiOut) return;
        const c = this.chans[ch];
        const made = [];
        for (const v of this.voices) {
          if (v.ch === ch && v.key === key && !v.released && !v.oneShot) v.release();
        }
        if (this.engine === 'sf2' && this.sf) this.spawnSF(c, ch, key, vel, made);
        if (!made.length) {
          if (c.drum) {
            const r = drumRecipe(key, c.prog);
            if (r.choke) for (const v of this.voices) if (v.ch === ch && v.choke === r.choke) v.kill();
            made.push(new DrumVoice(r, ch, key, vel));
          } else {
            const p = PATCHES[c.prog];
            made.push(p.k === 'sub' ? new SubVoice(p, ch, key, vel) : p.k === 'noise' ? new NoiseVoice(p, ch, key, vel) : new FMVoice(p, ch, key, vel));
          }
        }
        for (const v of made) this.voices.push(v);
        this.limitVoices();
      }

      spawnSF(c, ch, key, vel, out) {
        const sf = this.sf;
        const preset = c.drum
          ? sf.map.get(128 * 128 + c.prog) || sf.map.get(128 * 128)
          : sf.map.get(c.msb * 128 + c.prog) || sf.map.get(c.prog);
        if (!preset) return;
        for (const pz of preset.zones) {
          if (key < pz.kl || key > pz.kh || vel < pz.vl || vel > pz.vh) continue;
          const inst = sf.instruments[pz.inst];
          if (!inst) continue;
          for (const iz of inst.zones) {
            if (key < iz.kl || key > iz.kh || vel < iz.vl || vel > iz.vh) continue;
            const g = new Float64Array(61), ig = iz.gens, pg = pz.gens;
            for (let k = 0; k < 61; k++) g[k] = ig[k] + (NOT_ADDITIVE[k] ? 0 : pg[k]);
            const s = sf.samples[iz.sample];
            if (!s) continue;
            if (g[57]) for (const v of this.voices) if (v.ch === ch && v.excl === g[57]) v.kill();
            out.push(new SampleVoice(sf, g, s, ch, key, vel, c.drum));
          }
        }
      }

      noteOff(ch, key) {
        const c = this.chans[ch];
        for (const v of this.voices) {
          if (v.ch !== ch || v.key !== key || v.released || v.oneShot) continue;
          if (c.sustain) v.held = true;
          else v.release();
        }
      }

      limitVoices() {
        const vs = this.voices;
        let active = 0;
        for (const v of vs) if (!v.killed) active++;
        while (active > MAX_VOICES) {
          let best = -1, bestScore = Infinity;
          for (let i = 0; i < vs.length; i++) {
            const v = vs[i];
            if (v.killed) continue;
            const score = (v.released ? 0 : 10) + v.lvl + i * 1e-4;
            if (score < bestScore) { bestScore = score; best = i; }
          }
          if (best < 0) break;
          vs[best].kill();
          active--;
        }
        if (vs.length > MAX_VOICES + 32) vs.splice(0, vs.length - MAX_VOICES - 32);
      }

      report() {
        this.port.postMessage({ type: 'pos', t: this.pos, ct: currentTime, playing: this.playing, levels: Array.from(this.levels) });
        this.levels.fill(0);
      }

      process(inputs, outputs) {
        const out = outputs[0];
        const L = out[0], R = out[1] || out[0], n = L.length;

        if (this.playing && this.song) {
          const end = this.pos + n / SR;
          const { times, msgs } = this.song;
          while (this.idx < times.length && times[this.idx] < end) { this.dispatch(msgs[this.idx], this.idx); this.idx++; }
          this.pos = end;
          if (this.idx >= times.length && this.pos >= this.song.dur) {
            if (this.loops !== 0) {
              if (this.loops > 0) this.loops--;
              this.allNotesOff(true);
              this.rewind();
              this.port.postMessage({ type: 'loop' });
            } else {
              this.playing = false;
              this.allNotesOff(true);
              this.rewind();
              this.port.postMessage({ type: 'ended' });
            }
          }
        }

        L.fill(0); if (R !== L) R.fill(0);
        const rev = this.rev, cho = this.cho, tmp = this.tmp;
        rev.fill(0);
        let choUsed = false;
        const vs = this.voices;
        for (let vi = 0; vi < vs.length; vi++) {
          const v = vs[vi], c = this.chans[v.ch];
          v.render(tmp, n, c);
          const cg = (c.vol / 127) * (c.vol / 127) * (c.expr / 127) * (c.expr / 127) * 1.4142;
          const pan = clamp((c.pan - 64) / 63 + v.pan, -1, 1), ang = ((pan + 1) * Math.PI) / 4;
          const tl = Math.cos(ang) * cg, tr = Math.sin(ang) * cg;
          if (v.gl < 0) { v.gl = tl; v.gr = tr; }
          let gl = v.gl, gr = v.gr;
          const dl = (tl - gl) / n, dr = (tr - gr) / n;
          const rs = clamp(v.rev + (c.rev / 127) * 0.45, 0, 1) * 0.7;
          const cs = clamp(v.cho + (c.cho / 127) * 0.6, 0, 1) * 0.7;
          if (cs > 0 && !choUsed) { choUsed = true; cho.fill(0); }
          for (let i = 0; i < n; i++) {
            const s = tmp[i];
            L[i] += s * gl; R[i] += s * gr;
            const m = s * (gl + gr);
            rev[i] += m * rs;
            if (cs > 0) cho[i] += m * cs;
            gl += dl; gr += dr;
          }
          v.gl = tl; v.gr = tr;
          const lv = v.lvl * cg;
          if (lv > this.levels[v.ch]) this.levels[v.ch] = lv;
        }
        let w = 0;
        for (let i = 0; i < vs.length; i++) if (!vs[i].done) vs[w++] = vs[i];
        vs.length = w;

        this.reverb.process(rev, L, R, n);
        if (choUsed) this.choActive = SR; // keep the chorus line running while its tail decays
        if (this.choActive > 0) {
          if (!choUsed) cho.fill(0);
          this.chorus.process(cho, L, R, n);
          this.choActive -= n;
        }

        const g = this.master * this.sysVol * (this.engine === 'sf2' ? 0.5 : 0.42);
        for (let i = 0; i < n; i++) {
          let l = L[i] * g, r = R[i] * g;
          // Soft knee instead of hard digital clipping.
          if (l > 0.8) l = 0.8 + 0.2 * Math.tanh((l - 0.8) / 0.2); else if (l < -0.8) l = -0.8 - 0.2 * Math.tanh((-l - 0.8) / 0.2);
          if (r > 0.8) r = 0.8 + 0.2 * Math.tanh((r - 0.8) / 0.2); else if (r < -0.8) r = -0.8 - 0.2 * Math.tanh((-r - 0.8) / 0.2);
          L[i] = l; if (R !== L) R[i] = r;
        }

        if (++this.blocks % POS_EVERY === 0 && (this.playing || vs.length)) this.report();
        if (this.outQ.length) { this.port.postMessage({ type: 'midi', msgs: this.outQ }); this.outQ = []; }
        return true;
      }
    }

    // Generators that are not summed between preset and instrument level.
    const NOT_ADDITIVE = new Uint8Array(61);
    for (const g of [0, 1, 2, 3, 4, 12, 41, 43, 44, 45, 46, 47, 50, 53, 54, 57, 58]) NOT_ADDITIVE[g] = 1;

    registerProcessor('crescendo-synth', CrescendoSynth);
  }

  const api = { version: VERSION, parseMidi, parseSF2, layoutLyrics, workletSource: () => '(' + crescendoWorklet.toString() + ')();' };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return;

  // ===========================================================================
  // Browser side: engine, player element, legacy <EMBED> support
  // ===========================================================================

  const SCRIPT = document.currentScript;
  const config = {
    // Resolved against the page, like any other attribute URL.
    soundfont: SCRIPT && SCRIPT.dataset.soundfont ? new URL(SCRIPT.dataset.soundfont, location.href).href : null,
    links: !(SCRIPT && SCRIPT.dataset.links === 'off'),
    logo: SCRIPT && SCRIPT.dataset.logo === 'globe' ? 'globe' : 'classic',
  };

  const store = {
    get(k) { try { return localStorage.getItem('crescendo.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('crescendo.' + k, v); } catch { /* private mode */ } },
  };
  const fmtTime = (t) => {
    t = Math.max(0, Math.floor(t));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  };
  const parseBool = (v, dflt = false) => (v == null ? dflt : !/^(false|no|0|off)$/i.test(String(v).trim()));
  /** LOOP attribute -> extra plays: -1 forever, 0 once, n-1 for LOOP=n. */
  const parseLoop = (v) => {
    if (v == null) return 0;
    v = String(v).trim().toLowerCase();
    if (v === '' || v === 'true' || v === 'yes' || v === 'infinite' || v === '-1') return -1;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 1 ? n - 1 : 0;
  };
  const fileName = (src) => {
    try { return decodeURIComponent(new URL(src, location.href).pathname.split('/').pop()) || 'song.mid'; } catch { return String(src); }
  };

  /** fetch() that retries once, since a 31 MB SoundFont on hotel Wi-Fi will hiccup. */
  async function fetchRetry(url) {
    try {
      return await fetch(url);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 800));
      return fetch(url, { cache: 'reload' });
    }
  }

  /** Downloads with progress; restarts once if the connection drops mid-stream. */
  async function fetchWithProgress(url, onProgress, retry = true) {
    try {
      const r = await fetchRetry(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // content-length is the compressed size when the server gzips, so it only steers the progress bar.
      const total = +r.headers.get('content-length') || 0;
      if (!r.body || !total) return await r.arrayBuffer();
      const reader = r.body.getReader(), chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        onProgress(Math.min(1, got / total));
      }
      return await new Blob(chunks).arrayBuffer();
    } catch (e) {
      if (!retry || /^HTTP /.test(e.message)) throw e;
      await new Promise((res) => setTimeout(res, 800));
      return fetchWithProgress(url, onProgress, false);
    }
  }


  // ---- The engine: one shared synth, like the one MIDI device you had --------
  const Engine = {
    ctx: null, node: null, _init: null, owner: null,
    kind: store.get('engine') || (config.soundfont ? 'sf2' : 'fm'),
    sf: { state: 'none', name: '', progress: 0, promise: null },
    midi: { access: null, out: null },
    listeners: new Set(),

    init() {
      if (this._init) return this._init;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx || !('AudioWorkletNode' in window)) return (this._init = Promise.reject(new Error('Web Audio not supported')));
      // Created synchronously so a user gesture that triggered init() unlocks it.
      this.ctx = new Ctx({ latencyHint: 'playback' });
      this._init = (async () => {
        const url = URL.createObjectURL(new Blob([api.workletSource()], { type: 'text/javascript' }));
        try { await this.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        this.node = new AudioWorkletNode(this.ctx, 'crescendo-synth', { numberOfInputs: 0, outputChannelCount: [2] });
        this.node.connect(this.ctx.destination);
        this.node.port.onmessage = (e) => this.onMessage(e.data);
        if (this.kind === 'midi') this.kind = 'fm'; // needs a fresh permission prompt each visit
        this.post({ cmd: 'engine', kind: this.kind === 'sf2' ? 'fm' : this.kind });
      })();
      return this._init;
    },

    post(msg, transfer) { if (this.node) this.node.port.postMessage(msg, transfer || []); },

    /** Resumes audio; resolves false if the browser still wants a click first. */
    async unlock() {
      await this.init();
      if (this.ctx.state !== 'running') {
        await Promise.race([this.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 250))]);
      }
      return this.ctx.state === 'running';
    },

    onMessage(d) {
      if (d.type === 'midi') { this.sendMidi(d.msgs); return; }
      if (this.owner) this.owner._engineMessage(d);
    },

    notify() { for (const fn of this.listeners) fn(); },

    /** Makes `player` the one driving the synth, loading its song if needed. */
    claim(player) {
      if (this.owner === player) return false;
      const prev = this.owner;
      this.owner = player;
      if (prev) prev._preempted();
      const s = player.song;
      this.post({ cmd: 'load', times: s.times, msgs: s.msgs, sysex: s.sysex, duration: s.duration });
      return true;
    },

    release(player) {
      if (this.owner !== player) return;
      this.post({ cmd: 'stop' });
      this.owner = null;
    },

    async setKind(kind, opts = {}) {
      if (kind === 'midi') {
        await this.selectMidiOut(opts.id);
      } else if (kind === 'sf2') {
        if (this.sf.state !== 'ready') {
          if (!config.soundfont && !this.sf.promise) throw new Error('No SoundFont loaded');
          await this.ensureSoundFont();
        }
      }
      this.kind = kind;
      if (kind !== 'midi') store.set('engine', kind);
      this.post({ cmd: 'engine', kind });
      this.notify();
    },

    /** Called before playback so wavetable songs don't start on the FM synth. */
    async prepare() {
      if (this.kind !== 'sf2') return;
      try {
        await this.ensureSoundFont();
        this.post({ cmd: 'engine', kind: 'sf2' });
      } catch (e) {
        console.warn('[Crescendo] SoundFont unavailable, using FM synth:', e);
        this.kind = 'fm';
        this.post({ cmd: 'engine', kind: 'fm' });
        this.notify();
      }
    },

    ensureSoundFont() {
      if (this.sf.state === 'ready') return Promise.resolve();
      if (this.sf.promise) return this.sf.promise;
      if (!config.soundfont) return Promise.reject(new Error('No SoundFont configured'));
      return this.loadSoundFont(config.soundfont);
    },

    loadSoundFont(src, name) {
      const sf = this.sf;
      sf.state = 'loading'; sf.progress = 0;
      this.notify();
      sf.promise = (async () => {
        try {
          let buf;
          if (src instanceof ArrayBuffer) buf = src;
          else if (src instanceof Blob) { buf = await src.arrayBuffer(); name = name || src.name; }
          else {
            name = name || fileName(src);
            buf = await fetchWithProgress(src, (p) => { sf.progress = p; this.notify(); });
          }
          const bank = parseSF2(buf);
          await this.init();
          this.post({ cmd: 'sf2', bank }, [bank.data.buffer]);
          sf.state = 'ready';
          sf.name = (bank.name || name || 'SoundFont').replace(/\.sf2$/i, '');
        } catch (e) {
          sf.state = 'error';
          throw e;
        } finally {
          sf.promise = null;
          this.notify();
        }
      })();
      return sf.promise;
    },

    async selectMidiOut(id) {
      if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI support');
      if (!this.midi.access) this.midi.access = await navigator.requestMIDIAccess();
      const outs = [...this.midi.access.outputs.values()];
      const out = outs.find((o) => o.id === id) || outs[0];
      if (!out) throw new Error('No MIDI output devices found');
      this.midi.out = out;
    },

    sendMidi(msgs) {
      const out = this.midi.out;
      if (!out) return;
      for (const m of msgs) {
        const st = m & 0xff;
        if (st === 0xf0) continue;
        const kind = st & 0xf0;
        try {
          out.send(kind === 0xc0 || kind === 0xd0 ? [st, (m >> 8) & 0x7f] : [st, (m >> 8) & 0x7f, (m >> 16) & 0x7f]);
        } catch { /* device went away */ }
      }
    },

    synthLabel() {
      if (this.kind === 'midi') return 'MIDI OUT: ' + (this.midi.out ? this.midi.out.name : '?');
      if (this.kind === 'sf2') return 'WAVETABLE: ' + (this.sf.name || (config.soundfont ? fileName(config.soundfont).replace(/\.sf2$/i, '') : '?'));
      return 'FM SYNTHESIS (OPL-STYLE)';
    },
  };

  // Browsers only allow sound after a click/keypress. Players that wanted to
  // autostart queue up here and the first gesture anywhere sets them going.
  const pendingAutostart = [];
  function onFirstGesture() {
    if (!pendingAutostart.length) return;
    Engine.init();
    if (Engine.ctx && Engine.ctx.state !== 'running') Engine.ctx.resume();
    const p = pendingAutostart.shift();
    pendingAutostart.length = 0;
    Overlay.hideToast();
    if (p.isConnected) p.play({ auto: true });
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(ev, onFirstGesture, true);

  // ---- Pop-up UI: context menus, dialogs, the link player window ------------
  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .menu { position: fixed; z-index: 2147483647; min-width: 190px; padding: 2px; background: #c0c0c0; color: #000;
      font: 11px/1 "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Arial, sans-serif;
      box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff, 2px 2px 0 rgba(0,0,0,.25); }
    .mi { display: flex; align-items: center; height: 19px; padding: 0 16px 0 0; cursor: default; white-space: nowrap; }
    .mi .ck { width: 20px; text-align: center; font-size: 10px; }
    .mi:hover:not(.dis) { background: #000080; color: #fff; }
    .mi.dis { color: #808080; text-shadow: 1px 1px #fff; }
    .sep { height: 0; margin: 3px 2px; border-top: 1px solid #808080; border-bottom: 1px solid #fff; }
    .win { position: fixed; z-index: 2147483646; background: #c0c0c0; color: #000; padding: 3px;
      font: 11px/1.35 "MS Sans Serif", "Microsoft Sans Serif", Tahoma, Arial, sans-serif;
      box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #dfdfdf, inset -2px -2px #808080, inset 2px 2px #fff, 4px 4px 0 rgba(0,0,0,.3); }
    .tb { height: 18px; display: flex; align-items: center; gap: 4px; padding: 0 2px 0 4px; color: #fff; font-weight: bold;
      background: linear-gradient(90deg, #000080, #1084d0); cursor: move; user-select: none; touch-action: none; }
    .tb span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { width: 16px; height: 14px; padding: 0; border: 0; background: #c0c0c0; color: #000; font: bold 9px/1 Arial, sans-serif; cursor: pointer;
      box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf; }
    .x:active { box-shadow: inset 1px 1px #0a0a0a, inset -1px -1px #fff, inset 2px 2px #808080; }
    .wb { padding: 10px; }
    .row { display: flex; justify-content: center; gap: 6px; margin-top: 12px; }
    .btn { min-width: 75px; height: 23px; border: 0; background: #c0c0c0; color: #000; font: inherit; cursor: pointer;
      box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf; }
    .btn:active { box-shadow: inset 1px 1px #0a0a0a, inset -1px -1px #fff, inset 2px 2px #808080; }
    .btn:focus-visible { outline: 1px dotted #000; outline-offset: -5px; }
    .about { display: flex; gap: 14px; align-items: flex-start; max-width: 360px; }
    .about .mark { flex: none; width: 52px; height: 58px; display: grid; place-items: center; background: #669999;
      box-shadow: inset -1px -1px #fff, inset 1px 1px #808080; }
    .about .mark svg { width: 44px; height: 50px; }
    .about .mark img { width: 41px; height: 49px; image-rendering: pixelated; }
    .about h1 { margin: 0 0 2px; font: italic bold 20px/1.1 "Times New Roman", Times, serif; color: #000080; }
    .about p { margin: 6px 0 0; }
    .about .fine { color: #404040; }
    .toast { position: fixed; z-index: 2147483645; left: 50%; bottom: 16px; transform: translateX(-50%); max-width: calc(100vw - 32px);
      padding: 6px 10px; background: #ffffe1; color: #000; border: 1px solid #000; font: 11px/1.3 Tahoma, Arial, sans-serif;
      box-shadow: 2px 2px 0 rgba(0,0,0,.3); cursor: pointer; }
  `;

  const Overlay = {
    host: null, root: null, menuEl: null, toastEl: null,
    ensure() {
      if (this.root) return this.root;
      this.host = document.createElement('crescendo-ui');
      this.root = this.host.attachShadow({ mode: 'open' });
      this.root.innerHTML = `<style>${UI_CSS}</style>`;
      document.body.appendChild(this.host);
      return this.root;
    },
    closeMenu() { if (this.menuEl) { this.menuEl.remove(); this.menuEl = null; } },
    menu(x, y, items) {
      this.closeMenu();
      const root = this.ensure();
      const m = document.createElement('div');
      m.className = 'menu';
      m.setAttribute('role', 'menu');
      for (const it of items) {
        if (it === '-') { m.appendChild(Object.assign(document.createElement('div'), { className: 'sep' })); continue; }
        const row = document.createElement('div');
        row.className = 'mi' + (it.disabled ? ' dis' : '');
        row.setAttribute('role', 'menuitem');
        const ck = document.createElement('span');
        ck.className = 'ck';
        ck.textContent = it.checked ? (it.radio ? '\u25cf' : '\u2714') : '';
        const label = document.createElement('span');
        label.textContent = it.label;
        row.append(ck, label);
        if (!it.disabled) row.addEventListener('click', () => { this.closeMenu(); it.action(); });
        m.appendChild(row);
      }
      root.appendChild(m);
      const r = m.getBoundingClientRect();
      m.style.left = Math.max(0, Math.min(x, innerWidth - r.width - 2)) + 'px';
      m.style.top = Math.max(0, Math.min(y, innerHeight - r.height - 2)) + 'px';
      this.menuEl = m;
      const off = (e) => {
        if (e.type === 'keydown' && e.key !== 'Escape') return;
        if (e.composedPath && e.composedPath().includes(m)) return;
        this.closeMenu();
        document.removeEventListener('pointerdown', off, true);
        document.removeEventListener('keydown', off, true);
      };
      setTimeout(() => {
        document.addEventListener('pointerdown', off, true);
        document.addEventListener('keydown', off, true);
      });
    },
    window({ title, body, x, y, onClose }) {
      const root = this.ensure();
      const w = document.createElement('div');
      w.className = 'win';
      w.setAttribute('role', 'dialog');
      w.innerHTML = '<div class="tb"><span></span><button class="x" aria-label="Close">\u2715</button></div><div class="wb"></div>';
      w.querySelector('.tb span').textContent = title;
      w.querySelector('.wb').appendChild(body);
      root.appendChild(w);
      const r = w.getBoundingClientRect();
      w.style.left = Math.max(4, x != null ? x : (innerWidth - r.width) / 2) + 'px';
      w.style.top = Math.max(4, y != null ? y : (innerHeight - r.height) / 3) + 'px';
      const close = () => { w.remove(); if (onClose) onClose(); };
      w.querySelector('.x').addEventListener('click', close);
      const tb = w.querySelector('.tb');
      tb.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.x')) return;
        const sx = e.clientX - w.offsetLeft, sy = e.clientY - w.offsetTop;
        tb.setPointerCapture(e.pointerId);
        const move = (ev) => {
          w.style.left = Math.max(0, Math.min(ev.clientX - sx, innerWidth - 40)) + 'px';
          w.style.top = Math.max(0, Math.min(ev.clientY - sy, innerHeight - 20)) + 'px';
        };
        const up = () => { tb.removeEventListener('pointermove', move); tb.removeEventListener('pointerup', up); };
        tb.addEventListener('pointermove', move);
        tb.addEventListener('pointerup', up);
      });
      return { el: w, close };
    },
    toast(text) {
      const root = this.ensure();
      if (!this.toastEl) {
        this.toastEl = document.createElement('div');
        this.toastEl.className = 'toast';
        root.appendChild(this.toastEl);
      }
      this.toastEl.textContent = text;
    },
    hideToast() { if (this.toastEl) { this.toastEl.remove(); this.toastEl = null; } },
  };

  function showAbout() {
    const body = document.createElement('div');
    const songs = Engine.owner && Engine.owner.song;
    body.innerHTML = `
      <div class="about">
        <div class="mark">${EMBLEM}</div>
        <div>
          <h1>Crescendo</h1>
          <div>JS Edition, version ${VERSION}</div>
          <p>MIDI music for your web pages. Full songs in tiny files!</p>
          <p><b>Synthesizer:</b> <span class="syn"></span><br><b>Polyphony:</b> 96 voices<br><b>Now playing:</b> <span class="np"></span></p>
          <p class="fine">A tribute to LiveUpdate's Crescendo plug-in for Netscape Navigator. Not affiliated with LiveUpdate.</p>
        </div>
      </div>
      <div class="row"><button class="btn">OK</button></div>`;
    body.querySelector('.syn').textContent = Engine.synthLabel().toLowerCase().replace(/^./, (c) => c.toUpperCase());
    body.querySelector('.np').textContent = songs ? songs.display : '(nothing)';
    const win = Overlay.window({ title: 'About Crescendo', body });
    const ok = body.querySelector('.btn');
    ok.addEventListener('click', win.close);
    ok.focus();
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.addEventListener('change', () => resolve(input.files[0] || null));
      input.click();
    });
  }

  let popup = null;
  /** Opens the floating player window for a URL or a File. */
  function openPopupPlayer(src, name) {
    if (popup) popup.close();
    const body = document.createElement('div');
    const p = document.createElement('crescendo-player');
    p.setAttribute('autostart', '');
    p.setAttribute('width', '300');
    p.setAttribute('height', '60');
    body.appendChild(p);
    const w = Overlay.window({
      title: 'Crescendo - ' + name, body,
      x: innerWidth - 340, y: innerHeight - 140,
      onClose: () => { p.stop(); popup = null; },
    });
    popup = w;
    if (src instanceof Blob) p.load(src);
    else p.setAttribute('src', src);
    return p;
  }

  // ---- <crescendo-player> -----------------------------------------------------
  // Skinned after the late-90s Crescendo control panel (200x55): teal panel with
  // a dithered bevel, logo badge, "Crescendo!" display, yellow counter, buffer
  // gauge, speaker volume slider and flat transport icons with a lock.
  // The badge is the original LiveUpdate logo (cropped from a screenshot of the
  // real panel); data-logo="globe" on the script tag swaps in our own drawing.
  const CLASSIC_LOGO = '<img alt="" draggable="false" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACkAAAAxCAIAAADIhxdXAAAGC0lEQVR42rVY7Y3jRgx9Z20PAcZNGHi2u3DK4OC6uJQh4rYLpwnBD+ciDphtQkh+UDOS/HHZTTbCQZBPs8Mh+d4jqS/W93jHRXIchu54BCBpN47XrsN/uzYfNRw/u+ORJIDdOILcjeP/Yjv2bYbHYWgPcYjdMMRRPnqCf7a9tCpX1x0lLcPQHq714Z3Xyz+uCDPjMLy+XgXARUA0dtqNY7yK+w74EAg6nk6/XrE9HCS9bTZF5USCJf6/CD9+bFDK9vcDhO/f/9xstkif6nek/PX1FWaQSIKQBAECaHIJACiAn5tvSdfjESAh1c1J0ggSgATEC302zknuJmyTFGYbJChVg/wMjgVxW7QlXY9dNci4eXa5C5qOAAIg+CHXV1gjmVIah2F7OKSUSinbw6GUwkKgIKV2oO3vh8SUoHIuiSclJRBJElMF4wf8bsoQfA3piDsokHKRANgdu/mwPQVHQA8fy/ns99vh8NswbLbb6VDbbbtDqbCklH77OW4PbxJ348+3zXTulFJiAooAFCQgmLYbx7fDYfdzXvnc7ypVRtmUuvBGIHbDaOTXrx0BwF+7624cAQGSXFBkO8gQhrvjkXcAeszva1XmBtlxGK/H4LGD+MoOICAp6C0aoEC/FASMFzB0XewW/pALRtzHnClttltATAlASuX79x/y81lSOZMsKgDc/exiSgky+wYCiakgndKpJJUCQmeHzpvNtgApFSghKRUWlAd+L6pkiw+lXKVq0hIAZibl/hK/4A5BBAyEAYIEI0nIJXf2BmoYdlMIb/LdquQ4DLdA1ZRSkHEMckJCuzy7quJ5FgEzELSe1lusPHavu2F8gLVqNR6WKwiGaMfOmkR2tWJSuHZYIyACciFn592K2fayNRiH4dpdb7wOTt+Yk3z+VXEsyULhMUlvoz2B6/X11nY3F3y9djevo2SBzfPqg7vWK6ai0mwJINHbyl2538Y8Au7uvd30jQ9FSgDnuHPJ4EngI+gErLcZJlF5b3Ae+aaxOrcoxI9rsqa8r7MoEJxwqNlRCqLiEXIHGWfd1DR3RtN9xB8YnjxtFuYDTG4xMCBXzlWGVMPDCRkzzttB6+6aIrii03KNVEMS+KpsxFRIa3x7Y2/seza5bRK7aT3vOr2c/eZ99InWNQhmXP211BK82JYtMC3rL93xuIDAyvv+MmMv59z3/WIBNWe59kuVVCH6JOeZ517NgU0sam3XDZ7bP90rirROMySxt2aegNFitUe1W2PzZZG6aY/sd2EQAWbPC+yJFtikS8H3CLOqkw1VU9EjYYDPqZvr2Ln4KTGlVMqZPEXPRDIVpCQaS0kFKMQppZMxFfyhkk6nRJZyTgXpm6GcgSKhFCDhLBSAJ5IooM7nk51KmTqOl0UczeVG60kH8j5fLgYou18uF8lJ5Oy9GS24zbzP7qIxZGSfXa7LpQJ/qvGTpri8ke1Rnyp6o87MbgLY7x1AbwYiZ+2zBP11MQGePQjUG0Hs9x7I2dfk7fMkpjR72iNXXmhZvAKIfU9Gamsx2WePecGMBPZZwL0YicDlYmYg7Rf9eavtlM8M0lTHmCWXCEa7arWi9z2BOqUQa1JTQM4Kzt+MAEvbjAlTgBl7A8DsggtAdg8sCzIipCrnTAYFYjqFcRam5o3mWWqla6vZIAEqKijjz93hcDifz66SGP0YyUSmmBESUynM2b99SwCyCs7wUuxEF06pqJRzSUyJTEYASbVXS3XG+HLzvUVL0ZjqHgGvZWAS5QCkT6haNcFq1fvJdPd0Hls1KNI0bckkQRNb4jjBn8Bd08SYTp8Zvrm+PPzOFELbqoc8UNO8X6KzDaXUnfb+wumnMzDvmjRBQRK5P5h7OY3gN6anfer1b747mDV/SPYxmczdkhadbK0XDNY8H4je+31NWBM0iCzC5xoa/S65IuwnfNsDUNVwmrxC+9jPnWCduwzv/g7x8k7bWqWyKoamkI7DcO2OH52/N/jIRQIUWK0Kyi7peu0k9+yL/lb/kmOPWQeuN+Ui/giJf8Km/2b7Scv1PDzvyPfHYv7+5HxyvptQ/Dqm5Hu/tP0NzMfXbAMDtiQAAAAASUVORK5CYII=">';
  const GLOBE_LOGO = `
    <svg viewBox="0 0 40 46" aria-hidden="true">
      <defs><radialGradient id="cg" cx="38%" cy="32%" r="70%">
        <stop offset="0" stop-color="#ffffcc"/><stop offset=".5" stop-color="#99cc66"/><stop offset="1" stop-color="#336633"/>
      </radialGradient></defs>
      <path d="M7 15C11 4 29 2 34 11" stroke="#6633cc" stroke-width="3.6" fill="none" stroke-linecap="round"/>
      <path d="M37 8 35.5 15 29.5 11.5Z" fill="#6633cc"/>
      <path d="M33 31C29 43 12 45 6 36" stroke="#9966ff" stroke-width="3.6" fill="none" stroke-linecap="round"/>
      <path d="M3 39 4.5 32 10.5 35.5Z" fill="#9966ff"/>
      <circle cx="20" cy="23" r="12.5" fill="url(#cg)" stroke="#003333" stroke-width="1"/>
      <path d="M7.5 23h25M20 10.5v25M10 16.5q10 4 20 0M10 29.5q10-4 20 0M20 10.5q-7 12.5 0 25M20 10.5q7 12.5 0 25" stroke="#336666" stroke-width=".7" fill="none"/>
      <text x="20.5" y="28.5" text-anchor="middle" font-size="15" font-weight="bold" font-family="Times New Roman, serif" fill="#ffff00" stroke="#003333" stroke-width=".7">&#9835;</text>
    </svg>`;
  const EMBLEM = config.logo === 'globe' ? GLOBE_LOGO : CLASSIC_LOGO;
  const ICONS = {
    begin: '<svg viewBox="0 0 13 12"><path d="M1 1h2.5v10H1zM8 1 3.5 6 8 11zM12.5 1 8 6l4.5 5z"/></svg>',
    back: '<svg viewBox="0 0 11 12"><path d="M5.5 1 1 6l4.5 5zM10 1 5.5 6l4.5 5z"/></svg>',
    pause: '<svg viewBox="0 0 11 12"><path d="M1 1h3.5v10H1zM6.5 1H10v10H6.5z"/></svg>',
    stop: '<svg viewBox="0 0 11 12"><path d="M1 1h9v10H1z"/></svg>',
    play: '<svg viewBox="0 0 11 12"><path class="y" d="M2 1.5 9.5 6 2 10.5z"/></svg>',
    fwd: '<svg viewBox="0 0 11 12"><path d="M1 1l4.5 5L1 11zM5.5 1 10 6l-4.5 5z"/></svg>',
    lock: '<svg viewBox="0 0 13 12"><path class="sh" d="M7.5 5.5V3.2a2.2 2.2 0 0 1 4.4 0V5"/><rect class="bd" x="1" y="5.5" width="8" height="5.5"/></svg>',
    speaker: '<svg viewBox="0 0 16 12" aria-hidden="true"><path d="M1 4h3l4-3.2v10.4L4 8H1z" fill="#3333cc" stroke="#000066" stroke-width=".8"/><path d="M2 5h2l3-2.3" stroke="#9999ff" stroke-width=".8" fill="none"/><path d="M10 3.5q1.6 2.5 0 5M12.3 2q2.6 4 0 8" stroke="#ffff00" stroke-width="1.1" fill="none"/></svg>',
  };
  const DOTS = 'repeating-conic-gradient(var(--a) 0 25%, var(--b) 0 50%) 0 0 / 2px 2px';
  const PLAYER_CSS = `
    :host { display: inline-block; width: 200px; height: 55px; vertical-align: middle; contain: content;
      font: 11px/1.2 Arial, Helvetica, sans-serif; user-select: none; -webkit-user-select: none; }
    :host([hidden]) { display: none !important; }
    * { box-sizing: border-box; }
    .frame { position: relative; width: 100%; height: 100%; display: flex; gap: 3px; padding: 3px 3px 3px 3px; outline: none;
      background: #669999; box-shadow: inset 1px 1px #99cccc, inset -1px -1px #336666; }
    /* the dithered bevel along each edge */
    .frame::before, .frame::after { content: ""; position: absolute; pointer-events: none; }
    .frame::before { --a: #99cccc; --b: transparent; left: 0; top: 0; right: 3px; height: 3px; background: ${DOTS};
      box-shadow: none; }
    .frame::after { --a: #336666; --b: transparent; left: 3px; bottom: 0; right: 0; height: 3px; background: ${DOTS}; }
    .edge-l, .edge-r { position: absolute; top: 0; bottom: 0; width: 3px; pointer-events: none; }
    .edge-l { --a: #99cccc; --b: transparent; left: 0; background: ${DOTS}; }
    .edge-r { --a: #336666; --b: transparent; right: 0; background: ${DOTS}; }
    .frame:focus-visible { outline: 1px dotted #ffff00; outline-offset: -2px; }
    .frame.drop { filter: brightness(1.2); }
    .emblem { flex: none; width: 41px; display: grid; place-items: center; cursor: pointer; }
    .emblem svg { width: 38px; height: 45px; filter: drop-shadow(1px 1px 0 #336666); }
    .emblem img { width: 41px; height: 49px; image-rendering: pixelated; }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 4px 0 2px 1px; }
    .top { display: flex; align-items: flex-start; height: 14px; flex: none; }
    .lcd { flex: 1; min-width: 0; height: 14px; overflow: hidden; display: flex; align-items: center; padding: 0 3px; cursor: pointer;
      background: #336666; border-top: 1px solid #003333; border-left: 1px solid #003333; box-shadow: 1px 1px #99cccc; color: #fff; }
    .lcd.logo { justify-content: center; }
    .marq { display: inline-block; white-space: pre; will-change: transform; font: italic 11px/1 Arial, Helvetica, sans-serif;
      text-shadow: 1px 1px #003333; }
    .marq .dim { color: #99cccc; }
    .time { flex: none; width: 53px; height: 14px; margin-left: 3px; display: grid; place-items: center; color: #ffff00;
      font: bold 11.5px/1 Arial, Helvetica, sans-serif; letter-spacing: -.1px; font-variant-numeric: tabular-nums;
      background: #336666; border-top: 1px solid #003333; border-left: 1px solid #003333; box-shadow: 1px 1px #99cccc; }
    .gauge { flex: none; width: 18px; height: 9px; margin: 2px 0 0 5px; position: relative; }
    .gauge::before { content: ""; position: absolute; left: 0; top: 4px; width: 3px; height: 5px;
      --a: #336666; --b: transparent; background: ${DOTS}; }
    .gauge b { position: absolute; left: 4px; top: 0; width: 14px; height: 7px; background: #336666;
      box-shadow: inset 0 1px #003333, 1px 0 #336666, 0 1px #336666; overflow: hidden; }
    .gauge b i { display: block; height: 100%; width: 100%; background: #99cccc; box-shadow: inset 0 1px #ccffff; }
    .gauge.busy b i { animation: blink .5s steps(1) infinite; }
    .vol { position: relative; height: 13px; margin-top: 1px; flex: none; cursor: pointer; touch-action: none; }
    .vol::before { content: ""; position: absolute; left: 0; right: 2px; top: 6px; height: 1px; background: #006666; box-shadow: 0 1px #99cccc; }
    .vol svg { position: absolute; top: 0; width: 16px; height: 12px; }
    .btns { display: flex; justify-content: space-between; align-items: center; height: 16px; flex: none; padding-right: 1px; }
    .b { flex: none; width: 15px; height: 14px; padding: 0; border: 0; background: none; display: grid; place-items: center; cursor: pointer; }
    .b svg { width: 12px; height: 11px; fill: #003333; stroke: #006666; stroke-width: .6; overflow: visible;
      filter: drop-shadow(-1px -1px 0 #99cccc) drop-shadow(1px 1px 0 rgba(0,51,51,.35)); }
    .b .y { fill: #ffcc00; stroke: #996600; }
    .b .sh { fill: none; stroke: #336666; stroke-width: 1.6; }
    .b .bd { fill: #99cccc; stroke: #336666; stroke-width: 1; }
    .b.on .bd { fill: #ffcc00; }
    .lock:not(.on) .sh { transform: none; }
    .lock.on .sh { transform: translateX(-4.5px); }
    .b:active svg, .b.on svg { transform: translate(1px, 1px); }
    .b.on svg { filter: drop-shadow(0 0 1.5px #ffffcc) drop-shadow(1px 1px 0 rgba(0,51,51,.35)); }
    .b:focus-visible { outline: 1px dotted #ffff00; }
    .blink { animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    :host([data-narrow]) .emblem, :host([data-narrow]) .gauge { display: none; }
    :host([data-compact]) .emblem, :host([data-compact]) .lcd, :host([data-compact]) .gauge, :host([data-compact]) .vol { display: none; }
    :host([data-compact]) .main { flex-direction: row-reverse; align-items: center; gap: 6px; padding: 0; }
    :host([data-compact]) .btns { flex: 1; }
    :host([data-compact]) .begin, :host([data-compact]) .lock { display: none; }
  `;
  const PLAYER_HTML = `
    <div class="frame" tabindex="0" aria-label="Crescendo MIDI player">
      <span class="edge-l"></span><span class="edge-r"></span>
      <div class="emblem" title="About Crescendo">${EMBLEM}</div>
      <div class="main">
        <div class="top">
          <div class="lcd" title="Right-click for options"><span class="marq"></span></div>
          <span class="time" title="Counter">00:00.00</span>
          <span class="gauge" title="Buffer"><b><i></i></b></span>
        </div>
        <div class="vol" title="Volume (or use the mouse wheel)">${ICONS.speaker}</div>
        <div class="btns">
          <button class="b begin" title="Back to beginning" aria-label="Back to beginning">${ICONS.begin}</button>
          <button class="b back" title="Back 10 seconds" aria-label="Back 10 seconds">${ICONS.back}</button>
          <button class="b pause" title="Pause" aria-label="Pause">${ICONS.pause}</button>
          <button class="b stop" title="Stop" aria-label="Stop">${ICONS.stop}</button>
          <button class="b play" title="Play" aria-label="Play">${ICONS.play}</button>
          <button class="b fwd" title="Forward 10 seconds" aria-label="Forward 10 seconds">${ICONS.fwd}</button>
          <button class="b lock" title="Lock: don't let other music on the page interrupt this song" aria-label="Lock" aria-pressed="false">${ICONS.lock}</button>
        </div>
      </div>
    </div>`;
  const fmtCounter = (t) => {
    t = Math.max(0, t);
    const cs = Math.floor(t * 100);
    return String(Math.floor(cs / 6000)).padStart(2, '0') + ':' + String(Math.floor(cs / 100) % 60).padStart(2, '0') + '.' + String(cs % 100).padStart(2, '0');
  };

  class CrescendoPlayer extends HTMLElement {
    static get observedAttributes() { return ['src', 'width', 'height', 'loop']; }

    constructor() {
      super();
      this.song = null;
      this.state = 'empty';
      this.locked = false;
      this.pos = 0;
      this.loopCount = 0;
      this.volume = Math.min(1, Math.max(0, parseFloat(store.get('volume') ?? '0.8')));
      this._src = null;
      this._msg = '';
      this._flash = null;
      this._lastPos = 0;
      this._lastStamp = 0;
      this._lyric = -1;
      this._raf = 0;
      this._lastFrame = 0;
      this._marqKey = '';
      this._marqW = 0;
      this._marqX = 0;

      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${PLAYER_CSS}</style>${PLAYER_HTML}`;
      const $ = (s) => root.querySelector(s);
      this.$ = {
        frame: $('.frame'), lcd: $('.lcd'), marq: $('.marq'), time: $('.time'), vol: $('.vol'), thumb: $('.vol svg'),
        play: $('.play'), pause: $('.pause'), lock: $('.lock'), gauge: $('.gauge'), fill: $('.gauge i'),
      };
      $('.begin').addEventListener('click', () => this.seek(0));
      $('.back').addEventListener('click', () => this.seek(this.currentTime - 10));
      $('.fwd').addEventListener('click', () => this.seek(this.currentTime + 10));
      this.$.play.addEventListener('click', () => this.play());
      this.$.pause.addEventListener('click', () => (this.state === 'paused' ? this.play() : this.pause()));
      $('.stop').addEventListener('click', () => this.stop());
      this.$.lock.addEventListener('click', () => {
        this.locked = !this.locked;
        this.$.lock.classList.toggle('on', this.locked);
        this.$.lock.setAttribute('aria-pressed', String(this.locked));
        this._flashMsg(this.locked ? 'Locked' : 'Unlocked');
      });
      $('.emblem').addEventListener('click', showAbout);
      this.$.lcd.addEventListener('click', () => { if (this.state === 'empty' || this.state === 'stopped') showAbout(); });

      const vol = this.$.vol;
      const setFromPointer = (e) => {
        const r = vol.getBoundingClientRect();
        this.setVolume((e.clientX - r.left - 8) / (r.width - 16));
      };
      vol.addEventListener('pointerdown', (e) => {
        vol.setPointerCapture(e.pointerId);
        setFromPointer(e);
        const up = () => { vol.removeEventListener('pointermove', setFromPointer); vol.removeEventListener('pointerup', up); };
        vol.addEventListener('pointermove', setFromPointer);
        vol.addEventListener('pointerup', up);
      });

      const frame = this.$.frame;
      frame.addEventListener('contextmenu', (e) => { e.preventDefault(); this._menu(e.clientX, e.clientY); });
      frame.addEventListener('keydown', (e) => {
        if (e.target !== frame) return;
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.state === 'playing' ? this.pause() : this.play(); }
        else if (e.key === 'ArrowLeft') this.seek(this.currentTime - 10);
        else if (e.key === 'ArrowRight') this.seek(this.currentTime + 10);
        else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = frame.getBoundingClientRect();
          this._menu(r.left + 10, r.bottom);
        }
      });
      frame.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.setVolume(this.volume + (e.deltaY < 0 ? 0.05 : -0.05));
      }, { passive: false });
      frame.addEventListener('dragover', (e) => { e.preventDefault(); frame.classList.add('drop'); });
      frame.addEventListener('dragleave', () => frame.classList.remove('drop'));
      frame.addEventListener('drop', (e) => {
        e.preventDefault();
        frame.classList.remove('drop');
        const f = e.dataTransfer.files[0];
        if (f) this.openFile(f);
      });
      this._onEngine = () => this._paint(true);
    }

    connectedCallback() {
      this._applySize();
      this.loopCount = parseLoop(this.getAttribute('loop'));
      if (this.hasAttribute('volume')) this.volume = Math.min(1, Math.max(0, parseFloat(this.getAttribute('volume')) / 100 || 0));
      Engine.listeners.add(this._onEngine);
      const src = this.getAttribute('src');
      if (src && src !== this._src) this.load(src);
      this._paint(true);
      this._startLoop();
    }

    disconnectedCallback() {
      Engine.listeners.delete(this._onEngine);
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      if (Engine.owner === this) { Engine.release(this); this.state = 'stopped'; }
    }

    attributeChangedCallback(name, old, val) {
      if (!this.isConnected || old === val) return;
      if (name === 'src' && val && val !== this._src) this.load(val);
      else if (name === 'loop') { this.loopCount = parseLoop(val); if (Engine.owner === this) Engine.post({ cmd: 'loop', n: this.loopCount }); }
      else this._applySize();
    }

    get autostart() { return parseBool(this.getAttribute('autostart'), false); }

    _applySize() {
      const w = parseInt(this.getAttribute('width'), 10), h = parseInt(this.getAttribute('height'), 10);
      if (w > 0) this.style.width = w + 'px';
      if (h > 0) this.style.height = h + 'px';
      const width = w > 0 ? w : this.offsetWidth || 200, height = h > 0 ? h : this.offsetHeight || 55;
      this.toggleAttribute('data-compact', height < 44);
      this.toggleAttribute('data-narrow', width < 180);
    }

    /** Loads a song from a URL, File/Blob or ArrayBuffer. */
    async load(src, name) {
      const token = (this._token = {});
      this._playToken = null;
      if (Engine.owner === this) Engine.release(this);
      this._src = typeof src === 'string' ? src : null;
      this.song = null;
      this.pos = 0;
      this._setState('loading');
      try {
        let buf;
        if (src instanceof ArrayBuffer) buf = src;
        else if (src instanceof Blob) { buf = await src.arrayBuffer(); name = name || src.name; }
        else {
          name = name || fileName(src);
          const r = await fetchRetry(new URL(src, document.baseURI));
          if (!r.ok) throw new Error(r.status === 404 ? 'File not found' : 'HTTP ' + r.status);
          buf = await r.arrayBuffer();
        }
        if (token !== this._token) return;
        const parsed = parseMidi(buf);
        const lyr = layoutLyrics(parsed.lyrics);
        const title = parsed.title && !/^(untitled|track ?\d*|sequence ?\d*)$/i.test(parsed.title) ? parsed.title : '';
        this.song = Object.assign(parsed, {
          name: name || 'song.mid', bytes: buf.byteLength, buffer: buf, lines: lyr.lines, marks: lyr.marks,
          display: title ? title + '  (' + (name || 'song.mid') + ')' : name || 'song.mid',
        });
        this.song.duration = Math.max(parsed.duration, 0.05) + 0.25; // let the last notes ring a moment
        this._setState('stopped');
        this.dispatchEvent(new CustomEvent('load', { detail: { title: this.song.display, duration: this.song.duration } }));
        if (this.autostart && !this._autoDone) { this._autoDone = true; this.play({ auto: true }); }
      } catch (e) {
        if (token !== this._token) return;
        console.warn('[Crescendo]', e);
        this._msg = 'Error: ' + (e.message || e);
        this._setState('error');
      }
    }

    async openFile(file) {
      if (/\.sf2$/i.test(file.name)) {
        try {
          await Engine.loadSoundFont(file);
          await Engine.setKind('sf2');
          this._flashMsg('SoundFont loaded');
        } catch (e) { this._flashMsg('Bad SoundFont'); }
        return;
      }
      await this.load(file);
      if (this.song) this.play();
    }

    /** opts.auto: an autostart, which a locked song playing elsewhere ignores. */
    async play(opts = {}) {
      if (!this.song || this.state === 'playing') return;
      const o = Engine.owner;
      if (opts.auto && o && o !== this && o.locked && o.state === 'playing') return;
      let ok;
      try { ok = await Engine.unlock(); }
      catch (e) { this._msg = 'Error: no Web Audio'; this._setState('error'); return; }
      if (!ok) {
        this._setState('waiting');
        if (!pendingAutostart.includes(this)) pendingAutostart.push(this);
        if (this.hidden || !this.offsetParent) Overlay.toast('\u266b This page has background music \u2014 click anywhere to start it.');
        return;
      }
      const token = (this._playToken = {});
      const prep = Engine.prepare();
      if (Engine.sf.state === 'loading') this._setState('buffering');
      await prep;
      if (token !== this._playToken || !this.song) return; // stopped or reloaded meanwhile
      const fresh = Engine.claim(this);
      Engine.post({ cmd: 'volume', v: this.volume });
      Engine.post({ cmd: 'loop', n: this.loopCount });
      if (fresh && this.pos > 0) Engine.post({ cmd: 'seek', t: this.pos });
      Engine.post({ cmd: 'play' });
      this._lastPos = this.pos;
      this._lastStamp = Engine.ctx.currentTime;
      this._setState('playing');
      this.dispatchEvent(new Event('play'));
    }

    pause() {
      if (this.state !== 'playing') return;
      this.pos = this.currentTime;
      if (Engine.owner === this) Engine.post({ cmd: 'pause' });
      this._setState('paused');
      this.dispatchEvent(new Event('pause'));
    }

    stop() {
      this._playToken = null;
      if (Engine.owner === this) Engine.post({ cmd: 'stop' });
      const i = pendingAutostart.indexOf(this);
      if (i >= 0) pendingAutostart.splice(i, 1);
      this.pos = 0;
      if (this.song) this._setState('stopped');
    }

    seek(t) {
      if (!this.song) return;
      this.pos = Math.min(Math.max(0, t), this.song.duration - 0.05);
      this._lastPos = this.pos;
      this._lastStamp = Engine.ctx ? Engine.ctx.currentTime : 0;
      this._lyric = -1;
      if (Engine.owner === this) Engine.post({ cmd: 'seek', t: this.pos });
      this._paint(true);
    }

    setVolume(v) {
      this.volume = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
      store.set('volume', String(this.volume));
      if (Engine.owner === this) Engine.post({ cmd: 'volume', v: this.volume });
      this._flashMsg('Volume ' + Math.round(this.volume * 100) + '%');
    }

    get currentTime() {
      if (this.state !== 'playing' || !Engine.ctx || !this.song) return this.pos;
      const lat = Engine.ctx.outputLatency || Engine.ctx.baseLatency || 0;
      return Math.min(this.song.duration, Math.max(0, this._lastPos + (Engine.ctx.currentTime - this._lastStamp) - lat));
    }

    get duration() { return this.song ? this.song.duration : 0; }

    _engineMessage(d) {
      if (d.type === 'pos') {
        if (this.state === 'playing') { this._lastPos = d.t; this._lastStamp = d.ct; this.pos = d.t; }
      } else if (d.type === 'loop') {
        this._lyric = -1;
        this._lastPos = 0;
        this._lastStamp = Engine.ctx.currentTime;
      } else if (d.type === 'ended') {
        this.pos = 0;
        this._lyric = -1;
        this._setState('stopped');
        this.dispatchEvent(new Event('ended'));
      }
    }

    _preempted() {
      if (this.state === 'playing') this.pos = this.currentTime;
      if (this.state === 'playing' || this.state === 'paused') this._setState('paused');
    }

    _setState(s) {
      this.state = s;
      this.$.play.classList.toggle('on', s === 'playing');
      this.$.pause.classList.toggle('on', s === 'paused');
      this._paint(true);
    }

    _flashMsg(text) {
      this._flash = { text, until: performance.now() + 1400 };
      this._paint(true);
    }

    _menu(x, y) {
      const s = this.state, has = !!this.song;
      const kind = Engine.kind;
      const items = [
        { label: 'Play', disabled: !has || s === 'playing', action: () => this.play() },
        { label: s === 'paused' ? 'Resume' : 'Pause', disabled: !(s === 'playing' || s === 'paused'), action: () => (s === 'paused' ? this.play() : this.pause()) },
        { label: 'Stop', disabled: !has, action: () => this.stop() },
        { label: 'Loop', checked: this.loopCount !== 0, action: () => { this.loopCount = this.loopCount ? 0 : -1; if (Engine.owner === this) Engine.post({ cmd: 'loop', n: this.loopCount }); this._flashMsg(this.loopCount ? 'Loop on' : 'Loop off'); } },
        '-',
        { label: 'FM Synthesis (OPL-style)', radio: true, checked: kind === 'fm', action: () => this._switch('fm') },
        {
          label: 'Wavetable' + (Engine.sf.name ? ': ' + Engine.sf.name : config.soundfont ? ': ' + fileName(config.soundfont).replace(/\.sf2$/i, '') : ''),
          radio: true, checked: kind === 'sf2', disabled: !config.soundfont && Engine.sf.state !== 'ready',
          action: () => this._switch('sf2'),
        },
        { label: 'Load SoundFont (.sf2)...', action: async () => { const f = await pickFile('.sf2'); if (f) this.openFile(f); } },
        { label: 'External MIDI Device' + (Engine.midi.out ? ': ' + Engine.midi.out.name : '...'), radio: true, checked: kind === 'midi', disabled: !navigator.requestMIDIAccess, action: () => this._switch('midi') },
        '-',
        { label: 'Open MIDI File...', action: async () => { const f = await pickFile('.mid,.midi,.kar,.rmi,.sf2'); if (f) this.openFile(f); } },
        { label: 'Save Song As...', disabled: !has, action: () => this._save() },
        '-',
        { label: 'About Crescendo...', action: showAbout },
      ];
      Overlay.menu(x, y, items);
    }

    async _switch(kind) {
      try {
        await Engine.setKind(kind);
        if (Engine.owner === this && this.state === 'playing') Engine.post({ cmd: 'seek', t: this.currentTime });
        this._flashMsg(kind === 'fm' ? 'FM synthesis' : kind === 'sf2' ? 'Wavetable' : 'MIDI out');
      } catch (e) {
        this._flashMsg('Error: ' + (e.message || e));
      }
    }

    _save() {
      const s = this.song;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([s.buffer], { type: 'audio/midi' }));
      a.download = s.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    _startLoop() {
      if (this._raf) return;
      const frame = (now) => {
        this._raf = requestAnimationFrame(frame);
        const dt = Math.min(0.1, (now - (this._lastFrame || now)) / 1000);
        this._lastFrame = now;
        this._paint(false, dt);
      };
      this._raf = requestAnimationFrame(frame);
    }

    _lyricLine(t) {
      const s = this.song;
      if (!s.marks.length || t < s.marks[0].t - 1.5) return null;
      let i = this._lyric;
      if (i < 0 || i >= s.marks.length || s.marks[i].t > t) i = -1;
      while (i + 1 < s.marks.length && s.marks[i + 1].t <= t) i++;
      this._lyric = i;
      if (i < 0) return { line: s.lines[s.marks[0].line] || '', upto: 0 };
      const m = s.marks[i];
      return { line: s.lines[m.line] || '', upto: m.upto };
    }

    /** What the display shows: {text, logo?, lyric?: [sung, rest], blink?} */
    _display(t) {
      if (this._flash && performance.now() < this._flash.until) return { text: this._flash.text };
      this._flash = null;
      const s = this.song;
      switch (this.state) {
        case 'empty': case 'stopped': return { text: 'Crescendo!', logo: true };
        case 'loading': return { text: 'receiving MIDI file', blink: false };
        case 'error': return { text: this._msg };
        case 'waiting': return { text: 'click to play!', blink: true };
        case 'buffering': return { text: 'loading instruments ' + Math.round(Engine.sf.progress * 100) + '%' };
      }
      const lyr = this._lyricLine(t);
      if (lyr) return { lyric: [lyr.line.slice(0, lyr.upto), lyr.line.slice(lyr.upto)] };
      return { text: s.display + (s.copyright ? '  \u2022  ' + s.copyright : '') + '  \u2022  ' + Engine.synthLabel().toLowerCase() };
    }

    _paint(force, dt = 0) {
      const $ = this.$, t = this.currentTime;
      const d = this._display(t);
      const key = d.lyric ? 'l:' + d.lyric.join('|') : (d.logo ? 'g:' : 't:') + d.text + (d.blink ? ':b' : '');
      if (key !== this._marqKey) {
        this._marqKey = key;
        const m = $.marq;
        m.textContent = '';
        $.lcd.classList.toggle('logo', !!d.logo);
        m.classList.toggle('blink', !!d.blink);
        if (d.lyric) {
          m.append(d.lyric[0]);
          m.append(Object.assign(document.createElement('span'), { className: 'dim', textContent: d.lyric[1] }));
        } else m.textContent = d.text;
        this._marqW = m.offsetWidth;
        this._scrolls = !d.lyric && !d.logo && this._marqW > $.lcd.clientWidth - 8;
        if (this._scrolls) { m.textContent = d.text + '   \u266a   ' + d.text + '   \u266a   '; this._marqW = m.offsetWidth / 2; }
        this._lyricMode = !!d.lyric;
        this._marqX = 0;
        m.style.transform = '';
      }
      if (this._scrolls && dt) {
        this._marqX = (this._marqX + dt * 26) % this._marqW;
        $.marq.style.transform = `translateX(${-Math.round(this._marqX)}px)`;
      } else if (this._lyricMode && force !== true) {
        // keep the part being sung in view on long lines
        const over = this._marqW - ($.lcd.clientWidth - 8);
        const sung = $.marq.firstChild ? $.marq.firstChild.textContent.length : 0;
        const total = $.marq.textContent.length || 1;
        $.marq.style.transform = over > 0 ? `translateX(${-Math.round((over * sung) / total)}px)` : '';
      }

      const busy = this.state === 'loading' || this.state === 'buffering';
      $.gauge.classList.toggle('busy', busy);
      const fill = this.state === 'buffering' ? Engine.sf.progress : this.song ? 1 : 0;
      $.fill.style.width = Math.round(fill * 100) + '%';

      const tt = fmtCounter(t);
      if ($.time.textContent !== tt) $.time.textContent = tt;
      $.thumb.style.left = `calc(${(this.volume * 100).toFixed(1)}% - ${(this.volume * 16).toFixed(1)}px)`;
    }
  }
  customElements.define('crescendo-player', CrescendoPlayer);

  // ---- Old-school markup: <EMBED>, <BGSOUND>, <OBJECT>, plain links ----------
  function upgradeLegacy(el) {
    const tag = el.tagName;
    if (tag !== 'EMBED' && tag !== 'BGSOUND' && tag !== 'OBJECT') return;
    const get = (n) => el.getAttribute(n);
    let src = get('src') || get('data');
    if (!src && tag === 'OBJECT') {
      const prm = el.querySelector('param[name="src" i], param[name="filename" i], param[name="url" i]');
      src = prm && prm.getAttribute('value');
    }
    const type = (get('type') || '').toLowerCase();
    if (!src || !(MIDI_RE.test(src) || /midi/.test(type))) return;
    const bg = tag === 'BGSOUND';
    const p = document.createElement('crescendo-player');
    p.setAttribute('src', src);
    if (bg || parseBool(get('autostart') ?? get('autoplay'), false)) p.setAttribute('autostart', '');
    const loop = get('loop') ?? get('playcount');
    if (loop != null) p.setAttribute('loop', loop);
    if (bg || parseBool(get('hidden'), false)) p.hidden = true;
    for (const n of ['width', 'height', 'volume', 'title', 'id', 'class', 'style', 'align']) if (get(n) != null) p.setAttribute(n, get(n));
    el.replaceWith(p);
  }
  function scan(rootNode) {
    if (rootNode.matches && rootNode.matches('embed,bgsound,object')) upgradeLegacy(rootNode);
    if (rootNode.querySelectorAll) for (const el of rootNode.querySelectorAll('embed,bgsound,object')) upgradeLegacy(el);
  }
  scan(document);
  new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan(document));

  if (config.links) {
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.composedPath().find((n) => n.tagName === 'A' && n.href);
      if (!a || a.hasAttribute('download') || !MIDI_RE.test(new URL(a.href).pathname)) return;
      e.preventDefault();
      openPopupPlayer(a.href, fileName(a.href));
    });
  }

  root.Crescendo = Object.assign(api, {
    Engine, config,
    /** Jukebox helper: Crescendo.play('song.mid') or Crescendo.play(fileFromDrop) */
    play(src) {
      if (src instanceof Blob) return openPopupPlayer(src, src.name || 'song.mid');
      return openPopupPlayer(new URL(src, location.href).href, fileName(src));
    },
    openSoundFont(file) { return Engine.loadSoundFont(file).then(() => Engine.setKind('sf2')); },
  });
})(typeof window !== 'undefined' ? window : globalThis);
