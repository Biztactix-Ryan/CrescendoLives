#!/usr/bin/env node
/**
 * make-songs.mjs — builds Crescendo's demo MIDI files.
 *
 *   node tools/make-songs.mjs
 *
 * Writes Standard MIDI Files (type 1, 480 PPQ) into ../midi/ plus playlist.json.
 * No dependencies: the SMF writer, note-name helpers and the little melody
 * notation used by the arrangements all live in this file.
 *
 * Melody notation (used by play()):
 *   tokens separated by whitespace, "|" bar lines are ignored (readability only)
 *   F#4        a note (C4 = middle C = MIDI 60; sharps "#", flats "b")
 *   C4+E4+G4   a chord
 *   r          a rest
 *   :0.5       duration in beats (quarter notes); "1/3" fractions allowed.
 *              The duration carries over to following tokens until changed.
 *   ~          tie into the same pitch(es) in the next token
 *   !          accent      *  staccato      _  tenuto (full length)
 *   @90        explicit velocity for this token
 *
 * The public-domain arrangements were checked note-for-note against the
 * Mutopia Project editions (Pachelbel "Canon per 3 Violini e Basso", Joplin
 * "The Entertainer" 1902 ed., Beethoven WoO 59 Breitkopf ed., Grieg Op. 46
 * piano score) and then re-orchestrated for General MIDI.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'midi');
const PPQ = 480;

// General MIDI program numbers (0-based) used in this file.
const GM = {
  ACOUSTIC_GRAND: 0, ELECTRIC_PIANO_1: 4, HARPSICHORD: 6, GLOCKENSPIEL: 9,
  SLAP_BASS_1: 36, VIOLIN: 40, VIOLA: 41, CELLO: 42, CONTRABASS: 43,
  PIZZICATO_STRINGS: 45, TIMPANI: 47, STRING_ENSEMBLE_1: 48, STRING_ENSEMBLE_2: 49,
  ORCHESTRA_HIT: 55, TROMBONE: 57, FRENCH_HORN: 60, BRASS_SECTION: 61,
  SYNTH_BRASS_1: 62, OBOE: 68, BASSOON: 70, FLUTE: 73, LEAD_SQUARE: 80, PAD_WARM: 89,
};
const GM_NAME = Object.fromEntries(Object.entries(GM).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, ' ')]));

// General MIDI percussion keys (channel 10).
const DRUM = {
  KICK: 36, SIDE_STICK: 37, SNARE: 38, CLAP: 39, LOW_FLOOR_TOM: 41, CLOSED_HAT: 42,
  HIGH_FLOOR_TOM: 43, PEDAL_HAT: 44, LOW_TOM: 45, OPEN_HAT: 46, LOW_MID_TOM: 47,
  HI_MID_TOM: 48, CRASH: 49, HIGH_TOM: 50, RIDE: 51, TAMBOURINE: 54, COWBELL: 56,
  BASS_DRUM_1: 35, CRASH_2: 57,
};

// ---------------------------------------------------------------------------
// Note names
// ---------------------------------------------------------------------------
const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** n('F#4') -> 66. Middle C is C4 = 60. Accepts #, ##, b, bb (E#4 = F4). */
function n(name) {
  if (typeof name === 'number') return name;
  const m = /^([A-G])(##|#|bb|b)?(-?\d)$/.exec(name.trim());
  if (!m) throw new Error(`bad note name "${name}"`);
  let pc = PITCH_CLASS[m[1]];
  if (m[2]) pc += m[2][0] === '#' ? m[2].length : -m[2].length;
  const midi = (Number(m[3]) + 1) * 12 + pc;
  if (midi < 0 || midi > 127) throw new Error(`note out of range "${name}"`);
  return midi;
}

/** Shift a MIDI pitch by diatonic steps inside a scale given as pitch classes. */
function diatonicShift(pitch, steps, scale) {
  const sc = [...scale].sort((a, b) => a - b); // C-based so octave wraps line up
  let idx = sc.indexOf(pitch % 12);
  if (idx < 0) return pitch + (steps < 0 ? -3 : 3); // chromatic note: plain minor third
  let octave = Math.floor(pitch / 12);
  idx += steps;
  octave += Math.floor(idx / sc.length);
  idx = ((idx % sc.length) + sc.length) % sc.length;
  return octave * 12 + sc[idx];
}
const F_MAJOR = [5, 7, 9, 10, 0, 2, 4];

// ---------------------------------------------------------------------------
// Tiny Standard MIDI File writer
// ---------------------------------------------------------------------------
const toTicks = (beat) => Math.max(0, Math.round(beat * PPQ));
const ascii = (s) => [...Buffer.from(s, 'latin1')];

/** Variable-length quantity (big-endian base-128, continuation bit on all but last byte). */
function vlq(value) {
  let v = value >>> 0;
  const bytes = [v & 0x7f];
  while ((v >>>= 7) > 0) bytes.unshift((v & 0x7f) | 0x80);
  return bytes;
}

const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v) => [(v >>> 8) & 255, v & 255];

class Track {
  constructor(name, channel = null) {
    this.name = name;
    this.channel = channel;
    this.events = [];
    this.seq = 0;
    this.meta(0, 0x03, ascii(name), -1); // track name always first
  }

  // order: -1 track name, 0 note-off, 1 meta/control, 2 note-on
  push(beat, order, ev) {
    this.events.push({ tick: toTicks(beat), order, seq: this.seq++, ...ev });
  }

  meta(beat, type, data, order = 1) { this.push(beat, order, { kind: 'meta', type, data }); }
  text(beat, str) { this.meta(beat, 0x01, ascii(str)); }

  chan(beat, status, ...data) {
    if (this.channel == null) throw new Error(`track "${this.name}" has no channel`);
    this.push(beat, 1, { kind: 'chan', bytes: [status | this.channel, ...data] });
  }
  program(beat, p) { this.chan(beat, 0xc0, p); }
  cc(beat, ctl, value) { this.chan(beat, 0xb0, ctl, Math.max(0, Math.min(127, Math.round(value)))); }
  pedal(from, to) { this.cc(from, 64, 127); this.cc(to, 64, 0); }

  note(pitch, start, dur, vel = 80) {
    const p = n(pitch);
    const v = Math.max(1, Math.min(127, Math.round(vel)));
    const on = toTicks(start);
    let off = toTicks(start + dur);
    if (off <= on) off = on + 1;
    const seq = this.seq++;
    this.events.push({ tick: on, order: 2, seq, kind: 'on', pitch: p, vel: v });
    this.events.push({ tick: off, order: 0, seq, kind: 'off', pitch: p });
  }

  /** Standard channel setup at the start of the song. */
  setup({ program = 0, volume = 100, pan = 64, reverb = 50, chorus = 0, expression = 127 }) {
    this.cc(0, 0, 0); // bank select MSB: GM bank
    this.program(0, program);
    this.cc(0, 7, volume);
    this.cc(0, 10, pan);
    this.cc(0, 11, expression);
    this.cc(0, 91, reverb);
    this.cc(0, 93, chorus);
    this.programNumber = program;
    return this;
  }

  /** Encode as an MTrk chunk. Guarantees balanced note on/off pairs. */
  encode(endTick) {
    const sorted = [...this.events].sort((a, b) => a.tick - b.tick || a.order - b.order || a.seq - b.seq);
    // Same pitch overlapping itself on one channel: cut the old note right before
    // the new one starts and swallow the surplus note-off later.
    // Two identical hits on the same tick are merged into one.
    const active = new Map();
    const lastOn = new Map();
    const evs = [];
    for (const e of sorted) {
      if (e.kind === 'on') {
        const c = active.get(e.pitch) || 0;
        active.set(e.pitch, c + 1);
        if (c > 0 && lastOn.get(e.pitch) === e.tick) continue;
        if (c > 0) evs.push({ ...e, kind: 'off' });
        lastOn.set(e.pitch, e.tick);
        evs.push(e);
      } else if (e.kind === 'off') {
        const c = active.get(e.pitch) || 0;
        if (c <= 0) continue;
        active.set(e.pitch, c - 1);
        if (c === 1) evs.push(e);
      } else evs.push(e);
    }
    for (const [pitch, c] of active) if (c > 0) throw new Error(`hanging note ${pitch} in ${this.name}`);

    const lastTick = evs.length ? evs[evs.length - 1].tick : 0;
    const out = [];
    let now = 0;
    let running = null; // running status
    const emit = (tick, bytes, status) => {
      out.push(...vlq(tick - now));
      now = tick;
      if (status != null && status === running) out.push(...bytes.slice(1));
      else out.push(...bytes);
      running = status;
    };
    for (const e of evs) {
      if (e.kind === 'meta') emit(e.tick, [0xff, e.type, ...vlq(e.data.length), ...e.data], null);
      else if (e.kind === 'chan') emit(e.tick, e.bytes, e.bytes[0]);
      else if (e.kind === 'on') emit(e.tick, [0x90 | this.channel, e.pitch, e.vel], 0x90 | this.channel);
      else if (e.kind === 'off') emit(e.tick, [0x80 | this.channel, e.pitch, 0x40], 0x80 | this.channel);
    }
    emit(Math.max(lastTick, endTick ?? 0), [0xff, 0x2f, 0x00], null); // end of track
    return [...ascii('MTrk'), ...u32(out.length), ...out];
  }
}

class Song {
  constructor({ file, title, composer, info = '', original = false }) {
    this.file = file;
    this.title = title;
    this.composer = composer;
    this.conductor = new Track(title); // track 0: sequence name = song title
    this.tracks = [this.conductor];
    this.tempos = [];
    this.endBeat = null;
    this.conductor.meta(0, 0x02, ascii(original
      ? 'Original composition for the Crescendo demo. Free to share.'
      : `Composition by ${composer}: public domain. GM arrangement for the Crescendo demo, free to share.`));
    this.conductor.text(0, `${title} - ${composer}`);
    if (info) this.conductor.text(0, info);
  }

  tempo(beat, bpm) {
    this.tempos.push({ tick: toTicks(beat), bpm });
    const us = Math.round(60_000_000 / bpm);
    this.conductor.meta(beat, 0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]);
  }

  timeSig(beat, num, den) {
    const clocks = den === 8 && num % 3 === 0 ? 36 : 96 / den;
    this.conductor.meta(beat, 0x58, [num, Math.log2(den), clocks, 8]);
  }

  /** sharps > 0, flats < 0 */
  keySig(beat, sharps, minor = false) { this.conductor.meta(beat, 0x59, [sharps & 255, minor ? 1 : 0]); }
  marker(beat, str) { this.conductor.meta(beat, 0x06, ascii(str)); }

  track(name, channel, setup) {
    const t = new Track(name, channel);
    if (setup) t.setup(setup);
    this.tracks.push(t);
    return t;
  }

  /** Put every track's end-of-track at exactly this beat (for clean looping). */
  end(beat) { this.endBeat = beat; }

  lastTick() {
    let max = 0;
    for (const t of this.tracks) for (const e of t.events) max = Math.max(max, e.tick);
    return this.endBeat != null ? Math.max(max, toTicks(this.endBeat)) : max;
  }

  toBytes() {
    const endTick = this.lastTick();
    const header = [...ascii('MThd'), ...u32(6), ...u16(1), ...u16(this.tracks.length), ...u16(PPQ)];
    return Uint8Array.from([...header, ...this.tracks.flatMap((t) => t.encode(endTick))]);
  }

  durationSeconds() {
    const end = this.lastTick();
    const tempos = [...this.tempos].sort((a, b) => a.tick - b.tick);
    if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: 120 });
    let secs = 0;
    for (let i = 0; i < tempos.length; i++) {
      const from = tempos[i].tick;
      const to = Math.min(end, i + 1 < tempos.length ? tempos[i + 1].tick : end);
      if (to > from) secs += ((to - from) / PPQ) * (60 / tempos[i].bpm);
    }
    return secs;
  }
}

// ---------------------------------------------------------------------------
// Arrangement helpers
// ---------------------------------------------------------------------------
function rngFor(seed) { // mulberry32: deterministic "human" velocity jitter
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rng = rngFor(1997);

const near = (a, b) => Math.abs(a - b) < 1e-6;
const mod = (a, m) => ((a % m) + m) % m;
const parseDur = (s) => (s.includes('/') ? Number(s.split('/')[0]) / Number(s.split('/')[1]) : Number(s));

/**
 * Play a melody string on a track starting at `start` (in beats).
 * Returns the beat where the phrase ends.
 *
 * opts: vel (number | (beat) => number), gate (0..1 of the written length),
 *       transpose (semitones), diatonic {steps, scale} (diatonic harmony shift),
 *       meter/origin (bar length + bar-line offset for metric accents),
 *       accent (strength of the metric accent), jitter (velocity randomness),
 *       strum (beats between chord notes, bottom up), top (extra velocity for
 *       the top note of chords), ringTo/ringMax (let low notes ring to the
 *       bar line), collect (array that receives every note played).
 */
function play(track, start, src, opts = {}) {
  const {
    vel = 80, gate = 0.9, transpose = 0, diatonic = null, meter = 4, origin = 0,
    accent = 6, jitter = 3, strum = 0, top = 0, ringTo = 0, ringMax = 127, collect = null,
  } = opts;
  let t = start;
  let dur = 1;
  let ties = new Map();
  const notes = [];
  const metric = (beat) => {
    const pos = mod(beat - origin, meter);
    if (near(pos, 0) || near(pos, meter)) return accent;
    if (meter === 4 && near(pos, 2)) return accent / 2;
    if (!near(pos, Math.round(pos))) return -accent / 3;
    return 0;
  };
  for (const tok of src.replace(/\|/g, ' ').split(/\s+/)) {
    if (!tok) continue;
    const m = /^([^:~!*_@]+)(?::([\d./]+))?([~!*_]*)(?:@(\d+))?$/.exec(tok);
    if (!m) throw new Error(`bad token "${tok}"`);
    if (m[2]) dur = parseDur(m[2]);
    const flags = m[3];
    if (m[1] === 'r') {
      ties = new Map();
      t += dur;
      continue;
    }
    let pitches = m[1].split('+').map((p) => n(p) + transpose);
    if (diatonic) pitches = pitches.map((p) => diatonicShift(p, diatonic.steps, diatonic.scale));
    pitches.sort((a, b) => a - b);
    const base = m[4] ? Number(m[4]) : typeof vel === 'function' ? vel(t) : vel;
    const v = base + metric(t) + (flags.includes('!') ? 14 : 0);
    const g = flags.includes('*') ? 0.4 : flags.includes('_') ? 0.98 : gate;
    const nextTies = new Map();
    pitches.forEach((p, i) => {
      let rec = ties.get(p);
      if (rec) {
        rec.dur += dur;
        rec.gate = g;
      } else {
        let nv = v + (rng() * 2 - 1) * jitter;
        if (pitches.length > 1 && top) nv += i === pitches.length - 1 ? top : -top / 2;
        rec = { pitch: p, start: t + i * strum, dur: dur - i * strum, gate: g, vel: nv };
        notes.push(rec);
      }
      if (flags.includes('~')) nextTies.set(p, rec);
    });
    ties = nextTies;
    t += dur;
  }
  for (const r of notes) {
    // Gate shortens the note; the gap is capped at what a one-beat note would get.
    let len = r.dur <= 1 ? r.dur * r.gate : r.dur - (1 - r.gate);
    if (ringTo && r.pitch <= ringMax) {
      const barEnd = origin + Math.ceil((r.start - origin + 1e-6) / ringTo) * ringTo;
      len = Math.max(len, barEnd - r.start - 0.1);
    }
    track.note(r.pitch, r.start, Math.max(len, 0.02), r.vel);
    if (collect) collect.push({ ...r, len });
  }
  return t;
}

/** Quick grace notes that land just before `beat`. */
function grace(track, beat, pitches, step, vel) {
  pitches.forEach((p, i) => track.note(p, beat - (pitches.length - i) * step, step * 0.9, vel));
}

/** Velocity curve: linear ramp between (beat, vel) points. */
function ramp(...points) {
  return (beat) => {
    if (beat <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      const [b0, v0] = points[i - 1];
      const [b1, v1] = points[i];
      if (beat <= b1) return v0 + ((beat - b0) / (b1 - b0)) * (v1 - v0);
    }
    return points[points.length - 1][1];
  };
}

/** Velocity per bar from an array (clamped to its last value). */
const perBar = (start, barLen, values) => (beat) =>
  values[Math.max(0, Math.min(values.length - 1, Math.floor((beat - start + 1e-6) / barLen)))];

// ===========================================================================
// 1. GeoCities Groove — original, 120 bpm, loops cleanly
// ===========================================================================
function geocitiesGroove() {
  rng = rngFor(404);
  const s = new Song({
    file: 'geocities-groove.mid',
    title: 'GeoCities Groove',
    composer: 'Original (Crescendo demo)',
    original: true,
    info: 'Welcome to my homepage!!! Sign my guestbook :)',
  });
  s.tempo(0, 120);
  s.timeSig(0, 4, 4);
  s.keySig(0, -1);

  const lead = s.track('Square Lead', 0, { program: GM.LEAD_SQUARE, volume: 90, pan: 64, reverb: 50, chorus: 30 });
  const brass = s.track('Synth Brass', 1, { program: GM.SYNTH_BRASS_1, volume: 80, pan: 88, reverb: 55, chorus: 40 });
  const ep = s.track('Electric Piano', 2, { program: GM.ELECTRIC_PIANO_1, volume: 86, pan: 40, reverb: 60, chorus: 64 });
  const bass = s.track('Slap Bass', 3, { program: GM.SLAP_BASS_1, volume: 104, pan: 64, reverb: 20, chorus: 0 });
  const pad = s.track('Warm Pad', 4, { program: GM.PAD_WARM, volume: 70, pan: 64, reverb: 72, chorus: 70 });
  const hit = s.track('Orchestra Hit', 5, { program: GM.ORCHESTRA_HIT, volume: 92, pan: 64, reverb: 64, chorus: 0 });
  const glock = s.track('Glockenspiel', 6, { program: GM.GLOCKENSPIEL, volume: 74, pan: 100, reverb: 70, chorus: 20 });
  const drums = s.track('Drums', 9, { program: 0, volume: 108, pan: 64, reverb: 40, chorus: 0 });

  const CH = {
    F: { root: 'F2', ep: 'A3+C4+F4', pad: 'F3+C4+A4', hit: 'F3+F4+A4+C5' },
    Dm: { root: 'D2', ep: 'A3+D4+F4', pad: 'D3+A3+F4', hit: 'D3+D4+F4+A4' },
    Bb: { root: 'Bb1', ep: 'Bb3+D4+F4', pad: 'Bb2+F3+D4', hit: 'Bb2+Bb3+D4+F4' },
    C: { root: 'C2', ep: 'G3+C4+E4', pad: 'C3+G3+E4', hit: 'C3+C4+E4+G4' },
    Gm7: { root: 'G1', ep: 'F3+Bb3+D4', pad: 'G3+D4+F4', hit: 'G2+G3+Bb3+D4' },
    Am: { root: 'A1', ep: 'A3+C4+E4', pad: 'A2+E3+C4', hit: 'A2+A3+C4+E4' },
  };

  const VERSE_MEL = `
    C5:0.5 A4 C5 F5:1 E5:0.5 F5 G5 |
    A5:1.5 G5:0.5 F5:1 D5 |
    D5:0.5 F5 Bb5:1 A5:0.5 G5 F5:1 |
    G5:1.5 E5:0.5 C5:1 r |
    C5:0.5 A4 C5 F5:1 E5:0.5 F5 G5 |
    A5:1.5 Bb5:0.5 A5 G5 F5:1 |
    G5:0.5 A5 Bb5:1 C6:0.5 Bb5 A5 G5 |
    F5:2 r:1 C5:0.5 E5 |`;
  const CHORUS_MEL = `
    F5:0.5 Bb5 D6:1 C6:0.5 Bb5:1 F5:0.5 |
    E5:0.5 G5 C6:1 Bb5:0.5 A5:1 G5:0.5 |
    A5:0.5 C6 E6:1 D6:0.5 C6 A5:1 |
    D6:1.5 C6:0.5 A5:1 F5 |
    F5:0.5 Bb5 D6:1 C6:0.5 Bb5:1 F5:0.5 |
    E5:0.5 G5 C6:1 Bb5:0.5 A5:1 G5:0.5 |
    D6:0.5 D6 C6 Bb5 C6 C6 D6 E6 |
    F6:2_ r:2 |`;
  const OUTRO_MEL = `C6:0.5 A5 F5 C6 A5 F5 C5:1 | E5:0.5 G5 C6 E6 G6:2_ |`;

  const VERSE = ['F', 'Dm', 'Bb', 'C', 'F', 'Dm', ['Gm7', 'C'], 'F'];
  const CHORUS = ['Bb', 'C', 'Am', 'Dm', 'Bb', 'C', ['Bb', 'C'], 'F'];
  const FORM = [
    ['Intro', ['F', 'Dm', 'Bb', 'C']],
    ['Verse', VERSE],
    ['Chorus', CHORUS],
    ['Break', ['F', 'F', 'Bb', 'C']],
    ['Verse 2', VERSE],
    ['Chorus 2', CHORUS],
    ['Outro', ['F', 'C']],
  ];

  const d = (key, t, vel, len = 0.12) => drums.note(key, t, len, vel + (rng() * 2 - 1) * 4);
  const hats = (t, from = 0, to = 4, open = false) => {
    for (let b = from; b < to; b += 0.5) {
      if (open && near(b, 3.5)) d(DRUM.OPEN_HAT, t + b, 84, 0.45);
      else d(DRUM.CLOSED_HAT, t + b, near(b % 1, 0) ? 86 : 58);
    }
  };
  const grooveA = (t, bar) => {
    for (const b of [0, 2, 2.5]) d(DRUM.KICK, t + b, b === 0 ? 112 : 96);
    if (bar % 2 === 1) d(DRUM.KICK, t + 1.75, 70);
    for (const b of [1, 3]) d(DRUM.SNARE, t + b, 104);
    d(DRUM.SNARE, t + 3.75, 44); // ghost
    hats(t, 0, 4, bar % 2 === 1);
  };
  const grooveB = (t) => {
    for (const b of [0, 1, 2, 3]) d(DRUM.KICK, t + b, 110);
    for (const b of [1, 3]) { d(DRUM.SNARE, t + b, 106); d(DRUM.CLAP, t + b, 84); }
    for (const b of [0.5, 1.5, 2.5, 3.5]) d(DRUM.OPEN_HAT, t + b, 72, 0.3);
    for (const b of [0, 1, 2, 3]) d(DRUM.PEDAL_HAT, t + b, 54);
  };
  const fill = (t, from = 2) => { // snare 16ths into toms, ends on the bar line
    const toms = [DRUM.HIGH_TOM, DRUM.HI_MID_TOM, DRUM.LOW_MID_TOM, DRUM.LOW_TOM, DRUM.HIGH_FLOOR_TOM, DRUM.LOW_FLOOR_TOM];
    const steps = (4 - from) * 4;
    for (let i = 0; i < steps; i++) {
      const b = from + i / 4;
      const key = b < 3 ? DRUM.SNARE : toms[Math.min(toms.length - 1, Math.floor((b - 3) * 6))];
      d(key, t + b, 70 + (i / steps) * 50);
    }
    d(DRUM.KICK, t + from, 100);
  };
  const crash = (t) => { d(DRUM.CRASH, t, 116, 1); d(DRUM.KICK, t, 116); };

  const slap = (t, root, len) => { // one or two chords per bar
    const pattern = [[0, 0, 0.45, 112], [0.75, 0, 0.2, 68], [1, 12, 0.3, 104], [1.5, 0, 0.4, 92]];
    const r = n(root);
    for (const [o, iv, l, v] of pattern) bass.note(r + iv, t + o, l, v);
    if (len === 4) for (const [o, iv, l, v] of [[2.5, 0, 0.3, 92], [2.75, 7, 0.2, 80], [3, 12, 0.3, 104], [3.5, 10, 0.4, 88]]) bass.note(r + iv, t + o, l, v);
  };
  const octaves = (t, root, len) => {
    for (let i = 0; i < len * 2; i++) bass.note(n(root) + (i % 2 ? 12 : 0), t + i / 2, 0.4, i % 2 ? 96 : 112);
  };
  const BREAK_RIFF = 'F2:0.5 F3:0.25 F2 r:0.5 Eb3 F3 C3 A2 G2';

  let t = 0;
  for (const [section, bars] of FORM) {
    s.marker(t, section);
    const sectionStart = t;
    if (section.startsWith('Verse')) {
      play(lead, t, VERSE_MEL, { vel: 96, gate: 0.85, accent: 8 });
      if (section === 'Verse 2') play(brass, t, VERSE_MEL, { vel: 70, gate: 0.85, diatonic: { steps: -2, scale: F_MAJOR } });
    }
    if (section.startsWith('Chorus')) {
      play(lead, t, CHORUS_MEL, { vel: 104, gate: 0.85, accent: 8 });
      if (section === 'Chorus 2') {
        play(brass, t, CHORUS_MEL, { vel: 76, gate: 0.85, diatonic: { steps: -2, scale: F_MAJOR } });
        play(glock, t, CHORUS_MEL, { vel: 72, gate: 0.6, transpose: 12 });
      }
    }
    if (section === 'Outro') play(lead, t, OUTRO_MEL, { vel: 100, gate: 0.85 });

    bars.forEach((bar, i) => {
      const segs = Array.isArray(bar) ? bar.map((c) => [c, 2]) : [[bar, 4]];
      let o = 0;
      for (const [name, len] of segs) {
        const c = CH[name];
        const ts = t + o;
        // pad (rests during the first half of the break)
        if (!(section === 'Break' && i < 2)) play(pad, ts, `${c.pad}:${len}`, { vel: section === 'Intro' ? 58 : 50, gate: 0.98, accent: 0 });
        // electric piano comping
        if (section === 'Intro' || section === 'Outro') play(ep, ts, `${c.ep}:${len}`, { vel: 62, gate: 0.95, strum: 0.03 });
        else if (section.startsWith('Verse')) for (const b of [0.5, 1.5].concat(len === 4 ? [2.5, 3.5] : [])) play(ep, ts + b, `${c.ep}:0.35`, { vel: 64, accent: 0 });
        else if (section.startsWith('Chorus')) for (const [b, l] of [[0, 0.7], [1.5, 0.45]].concat(len === 4 ? [[2.5, 0.45], [3, 0.9]] : [])) play(ep, ts + b, `${c.ep}:${l}`, { vel: 70, accent: 0 });
        else for (const [b, l] of [[0, 0.25], [0.75, 0.25], [1.5, 0.5], [2.75, 0.25], [3.5, 0.4]]) play(ep, ts + b, `${c.ep}:${l}`, { vel: 68, accent: 0 });
        // bass
        if (section === 'Intro') {
          if (i < 2) bass.note(n(c.root) + 12, ts, len - 0.1, 96);
          else slap(ts, c.root, len);
        } else if (section.startsWith('Verse')) slap(ts, c.root, len);
        else if (section.startsWith('Chorus')) octaves(ts, c.root, len);
        else if (section === 'Break') play(bass, ts, BREAK_RIFF, { vel: 100, gate: 0.8, transpose: { F: 0, Bb: 5, C: 7 }[name] });
        else if (section === 'Outro') i === 0 ? slap(ts, c.root, len) : octaves(ts, c.root, len);
        o += len;
      }

      // glockenspiel sparkle in the intro
      if (section === 'Intro') {
        const tones = CH[bars[i]].pad.split('+').map((p) => n(p) + 24);
        const arp = [tones[0], tones[1], tones[2], tones[1]];
        for (let k = 0; k < 8; k++) glock.note(arp[k % 4], t + k * 0.5, 0.4, k % 4 === 0 ? 70 : 56);
      }

      // drums
      if (section === 'Intro') {
        if (i === 0 || i === 2) crash(t);
        if (i >= 1) hats(t, 0, i === 3 ? 2 : 4);
        if (i >= 2 && i < 3) { d(DRUM.KICK, t + 2, 100); }
        if (i === 3) fill(t, 2);
      } else if (section.startsWith('Verse')) {
        if (i === 0) d(DRUM.CRASH, t, 112, 1);
        if (section === 'Verse 2') for (let b = 0; b < 4; b += 0.5) d(DRUM.TAMBOURINE, t + b, b % 1 ? 74 : 54);
        if (i === 7) { grooveA(t, 0); fill(t, 3); } else grooveA(t, i);
      } else if (section.startsWith('Chorus')) {
        if (i === 0 || i === 4) d(DRUM.CRASH, t, 116, 1);
        if (section === 'Chorus 2') for (const b of [1, 3]) d(DRUM.TAMBOURINE, t + b, 90);
        if (i === 7) { grooveB(t); fill(t, 2); } else grooveB(t);
      } else if (section === 'Break') {
        for (const b of [0, 0.75, 2.5]) d(DRUM.KICK, t + b, 108);
        for (const b of [1, 3]) d(DRUM.SNARE, t + b, 96);
        d(DRUM.CLAP, t + 3, 90);
        for (const b of [0, 1.5, 3]) d(DRUM.COWBELL, t + b, 84);
        if (i < 3) for (let b = 0; b < 4; b += 0.25) d(DRUM.CLOSED_HAT, t + b, near(b % 1, 0) ? 70 : 44);
        else fill(t, 2);
      } else if (section === 'Outro') {
        if (i === 0) { crash(t); grooveB(t); } else fill(t, 0);
      }

      // orchestra hits
      const stab = (b, chord, len = 0.5, v = 110) => play(hit, t + b, `${CH[chord].hit}:${len}`, { vel: v, gate: 1, accent: 0 });
      if (section === 'Intro' && (i === 0 || i === 2)) stab(0, bars[i], 1);
      if (section === 'Intro' && i === 3) { stab(2, 'C'); stab(3, 'C', 0.5, 118); }
      if (section.startsWith('Chorus') && (i === 0 || i === 4)) stab(0, 'Bb');
      if (section.startsWith('Chorus') && i === 7) stab(0, 'F', 1);
      if (section === 'Break' && i === 3) { stab(2, 'C', 0.25); stab(2.5, 'C', 0.25); stab(3, 'C', 0.5, 118); }
      if (section === 'Outro' && i === 0) stab(0, 'F', 1);
      if (section === 'Outro' && i === 1) { stab(0, 'C'); stab(1.5, 'C'); }

      t += 4;
    });
    if (t - sectionStart !== bars.length * 4) throw new Error('section length');
  }
  s.end(t); // 42 bars: end-of-track exactly on the loop point
  return s;
}

// ===========================================================================
// 2. Pachelbel — Canon in D (c. 1680)
// ===========================================================================
// The canon line: violin I plays it from bar 3, violin II from bar 5, violin III
// from bar 7 — always over the same 2-bar ground. Original note values (bass in
// quarters); the familiar "half-note / quarter / eighth" lines of popular
// arrangements are Pachelbel's quarter / eighth / sixteenth variations here.
const CANON_LINE = [
  /*  1 */ 'F#5:1 E5 D5 C#5',
  /*  2 */ 'B4:1 A4 B4 C#5',
  /*  3 */ 'D5:1 C#5 B4 A4',
  /*  4 */ 'G4:1 F#4 G4 E4',
  /*  5 */ 'D4:0.5 F#4 A4 G4 F#4 D4 F#4 E4',
  /*  6 */ 'D4:0.5 B3 D4 A4 G4 B4 A4 G4',
  /*  7 */ 'F#4:0.5 D4 E4 C#5 D5 F#5 A5 A4',
  /*  8 */ 'B4:0.5 G4 A4 F#4 D4 D5 D5:0.75 C#5:0.25',
  /*  9 */ 'D5:0.25 C#5 D5 D4 C#4 A4 E4 F#4 D4 D5 C#5 B4 C#5 F#5 A5 B5',
  /* 10 */ 'G5:0.25 F#5 E5 G5 F#5 E5 D5 C#5 B4 A4 G4 F#4 E4 G4 F#4 E4',
  /* 11 */ 'D4:0.25 E4 F#4 G4 A4 E4 A4 G4 F#4 B4 A4 G4 A4 G4 F#4 E4',
  /* 12 */ 'D4:0.25 B3 B4 C#5 D5 C#5 B4 A4 G4 F#4 E4 B4 A4 B4 A4 G4',
  /* 13 */ 'F#4:0.5 F#5 E5:1 r:0.5 D5 F#5:1',
  /* 14 */ 'B5:1 A5 B5 C#6',
  /* 15 */ 'D6:0.5 D5 C#5:1 r:0.5 B4 D5:1',
  /* 16 */ 'D5:1.5 D5:0.5 D5 G5 E5 A5',
  /* 17 */ 'A5:0.25 F#5:0.125 G5 A5:0.25 F#5:0.125 G5 A5 A4 B4 C#5 D5 E5 F#5 G5 F#5:0.25 D5:0.125 E5 F#5:0.25 F#4:0.125 G4 A4 B4 A4 G4 A4 F#4 G4 A4',
  /* 18 */ 'G4:0.25 B4:0.125 A4 G4:0.25 F#4:0.125 E4 F#4 E4 D4 E4 F#4 G4 A4 B4 G4:0.25 B4:0.125 A4 B4:0.25 C#5:0.125 D5 A4 B4 C#5 D5 E5 F#5 G5 A5',
  /* 19 */ 'F#5:0.25 D5:0.125 E5 F#5:0.25 E5:0.125 D5 E5 C#5 D5 E5 F#5 E5 D5 C#5 D5:0.25 B4:0.125 C#5 D5:0.25 D4:0.125 E4 F#4 G4 F#4 E4 F#4 D5 C#5 D5',
  /* 20 */ 'B4:0.25 D5:0.125 C#5 B4:0.25 A4:0.125 G4 A4 G4 F#4 G4 A4 B4 C#5 D5 B4:0.25 D5:0.125 C#5 D5:0.25 C#5:0.125 B4 C#5 D5 E5 D5 C#5 D5 B4 C#5',
  /* 21 */ 'D5:0.5 r C#5 r B4 r D5 r',
  /* 22 */ 'D4:0.5 r D4 r D4 r E4 r',
  /* 23 */ 'r:0.5 A4 r A4 r F#4 r A4',
  /* 24 */ 'r:0.5 G4 r F#4 r G4 r E5',
  /* 25 */ 'F#5:0.25 F#4 G4 F#4 E4 E5 F#5 E5 D5 F#4 D4 B4 A4 A3 G3 A3',
  /* 26 */ 'B3:0.25 B4 C#5 B4 A4 A3 G3 A3 B3 B4 A4 B4 C#5 C#4 B3 C#4',
  /* 27 */ 'D4:0.25 D5 E5 D5 C#5 C#4 D4 C#4 B3 B4 A4 B4 C#5 C#4 F#4 E4',
  /* 28 */ 'D4:0.25 D5 E5 G5 F#5 F#4 A4 F#5 D5 G5 F#5 G5 E5 A4 G4 A4',
  /* 29 */ 'F#4:0.25 A4 A4 A4 A4 A4 A4 A4 F#4 F#4 F#4 F#4 F#4 F#4 A4 A4',
  /* 30 */ 'G4:0.25 G4 G4 D5 D5 D5 D5 D5 D5 D5 B4 B4 A4 A4 E5 C#5',
  /* 31 */ 'A4:0.25 F#5 F#5 F#5 E5 E5 E5 E5 D5 D5 D5 D5 A5 A5 A5 A5',
  /* 32 */ 'B5:0.25 B5 B5 B5 A5 A5 A5 A5 B5 B5 B5 B5 C#6 C#5 C#5 C#5',
];

function canonInD() {
  rng = rngFor(1680);
  const s = new Song({ file: 'canon-in-d.mid', title: 'Canon in D', composer: 'Johann Pachelbel' });
  s.timeSig(0, 4, 4);
  s.keySig(0, 2);
  s.tempo(0, 64);

  const cello = s.track('Cello (ground bass)', 0, { program: GM.CELLO, volume: 100, pan: 50, reverb: 64, chorus: 10 });
  const contra = s.track('Contrabass', 1, { program: GM.CONTRABASS, volume: 82, pan: 58, reverb: 60, chorus: 0 });
  const v1 = s.track('Violin I', 2, { program: GM.VIOLIN, volume: 104, pan: 26, reverb: 70, chorus: 20 });
  const v2 = s.track('Violin II', 3, { program: GM.VIOLIN, volume: 100, pan: 102, reverb: 70, chorus: 20 });
  const v3 = s.track('Viola (canon voice III)', 4, { program: GM.VIOLA, volume: 100, pan: 76, reverb: 70, chorus: 20 });
  const hpsd = s.track('Harpsichord continuo', 5, { program: GM.HARPSICHORD, volume: 76, pan: 88, reverb: 52, chorus: 0 });
  const pad = s.track('String Pad', 6, { program: GM.STRING_ENSEMBLE_2, volume: 62, pan: 64, reverb: 80, chorus: 40 });

  const GROUND = 'D3:1 A2 B2 F#2 G2 D2 G2 A2';
  const CHORDS = ['D4+F#4+A4', 'C#4+E4+A4', 'B3+D4+F#4', 'C#4+F#4+A4', 'B3+D4+G4', 'A3+D4+F#4', 'B3+D4+G4', 'C#4+E4+A4'];
  const BARS = 34; // 17 statements of the ground, then a final chord
  const dyn = (beat) => 56 + Math.min(Math.floor(beat / 4), 26) * 1.25; // long crescendo

  for (let g = 0; g < BARS / 2; g++) {
    const t = g * 8;
    play(cello, t, GROUND, { vel: 70 + Math.min(g, 10), gate: 0.94, accent: 6 });
    if (g >= 4) play(contra, t, GROUND, { vel: 62, gate: 0.88, transpose: -12, accent: 4 });
    // Harpsichord: quarter chords, then eighths once the sixteenths start
    const eighths = g >= 4;
    const hs = CHORDS.map((c) => (eighths ? `${c}:0.5 ${c}` : `${c}:1`)).join(' ');
    play(hpsd, t, hs, { vel: 58, gate: 0.85, strum: 0.012, accent: 6, top: 6 });
    if (g >= 6) play(pad, t, CHORDS.map((c) => `${c}:1`).join(' '), { vel: g >= 8 ? 46 : 38, gate: 1, accent: 0, jitter: 1 });
  }

  // The three canon voices
  const voices = [[v1, 2, 0], [v2, 4, -3], [v3, 6, -5]];
  for (const [trk, entryBar, velOff] of voices) {
    const bars = BARS - entryBar;
    play(trk, entryBar * 4, CANON_LINE.slice(0, bars).join(' | '), {
      vel: (b) => dyn(b) + velOff, gate: 0.92, accent: 5, jitter: 3,
    });
  }

  // Ritardando into the final D major chord
  const fin = BARS * 4;
  [[fin - 6, 62], [fin - 4, 59], [fin - 3, 56], [fin - 2, 53], [fin - 1, 50], [fin, 44]].forEach(([b, bpm]) => s.tempo(b, bpm));
  v1.note('D5', fin, 3.9, 84);
  v2.note('A4', fin, 3.9, 78);
  v3.note('F#4', fin, 3.9, 76);
  cello.note('D3', fin, 3.9, 84);
  contra.note('D2', fin, 3.9, 74);
  play(hpsd, fin, 'D2+A2+D3+F#3+A3+D4+F#4+A4+D5:4', { vel: 70, gate: 0.98, strum: 0.07, accent: 0 });
  play(pad, fin, 'D4+F#4+A4:4', { vel: 48, gate: 0.98, accent: 0 });
  return s;
}

// ===========================================================================
// 3. Scott Joplin — The Entertainer (1902)
// ===========================================================================
// Intro, A (twice), B (twice; the repeat is played an octave higher, as marked
// "Repeat 8va" in the 1902 edition), A again, ending on the final C chord.
const ENT = {
  RH_INTRO: `
    D6:0.25 E6 C6 A5:0.5 B5:0.25 G5:0.5 |
    D5:0.25 E5 C5 A4:0.5 B4:0.25 G4:0.5 |
    D4:0.25 E4 C4 A3:0.5 B3:0.25 A3 Ab3 |
    G3:0.5 r G5+D5+B4+G4 D4:0.25 D#4 |`,
  LH_INTRO: `
    D5:0.25 E5 C5 A4:0.5 B4:0.25 G4:0.5 |
    D4:0.25 E4 C4 A3:0.5 B3:0.25 G3:0.5 |
    D3:0.25 E3 C3 A2:0.5 B2:0.25 A2 Ab2 |
    G2:0.5 r G2+G1 B3+G3 |`,
  // A strain, 15 bars; the endings follow.
  RH_A: `
    E4:0.25 C5:0.5 E4:0.25 C5:0.5 E4:0.25 C5:1.5 | C6+E5+C5:0.25 D6+F5+D5 D#6+F#5+D#5 |
    E6+G5+E5:0.25 C6+E5+C5 D6+F5+D5 E6+G5+E5:0.5 B5+D5+B4:0.25 D6+F5+D5:0.5 |
    C6+E5+C5:1.5 D4:0.25 D#4 |
    E4:0.25 C5:0.5 E4:0.25 C5:0.5 E4:0.25 C5:1.75 | A5+C5+A4:0.25 G5+C5+G4 |
    F#5+C5+F#4:0.25 A5+A4 C6+C5 E6+E5:0.5 D6+D5:0.25 C6+C5 A5+A4 |
    D6+F5+D5:1.5 D4:0.25 D#4 |
    E4:0.25 C5:0.5 E4:0.25 C5:0.5 E4:0.25 C5:1.5 | C6+E5+C5:0.25 D6+F5+D5 D#6+F#5+D#5 |
    E6+G5+E5:0.25 C6+E5+C5 D6+F5+D5 E6+G5+E5:0.5 B5+D5+B4:0.25 D6+F5+D5:0.5 |
    C6+E5+C5:1.5 C6+C5:0.25 D6+D5 |
    E6+E5:0.25 C6+C5 D6+D5 E6+E5:0.5 C6+C5:0.25 D6+D5 C6+C5 |
    E6+E5:0.25 C6+C5 D6+D5 E6+E5:0.5 C6+C5:0.25 D6+D5 C6+C5 |
    E6+G5+E5:0.25 C6+E5+C5 D6+F5+D5 E6+G5+E5:0.5 B5+D5+B4:0.25 D6+F5+D5:0.5 |`,
  RH_A_END1: 'C6+E5+C5:1.5 D4:0.25 D#4 |',
  RH_A_END2: 'C6+E5+C5:1.25 E5+C5+E4:0.25 F5+D5+F4 F#5+D#5+F#4 |',
  RH_A_FINAL: 'C6+E5+C5:1 C6+E5+C5:0.5 r |',
  LH_A: `
    C3:0.5 C4+G3+E3 G3+G2 C4+Bb3+G3 |
    F3+F2:0.5 C4+A3 E3+E2 C4+G3 |
    G2:0.5 C4+G3+E3 G2 B3+G3+F3 |
    C3:0.5 C4+G3+E3 C4+G3+E3 B3+G3 |
    C3:0.5 C4+G3+E3 G3+G2 C4+Bb3+G3 |
    F3+F2:0.5 C4+A3 E3+E2 Eb3+Eb2 |
    D3+D2:0.5 C4+A3+F#3+D3 D3 C4+A3+F#3 |
    B3+G3:0.5 G3+G2 A3+A2 B3+B2 |
    C3:0.5 C4+G3+E3 G3+G2 C4+Bb3+G3 |
    F3+F2:0.5 C4+A3 E3+E2 C4+G3 |
    G2:0.5 C4+G3+E3 G2 B3+G3+F3 |
    C3:0.5 C4+G3+E3 E4+C4+G3 r |
    C4+C3:0.5 E4+C4+G3 Bb3+Bb2 E4+C4+G3 |
    A3+A2:0.5 F4+C4+A3 Ab3+Ab2 F4+C4+Ab3 |
    G3+G2:0.5 E4+C4+G3 G2 B3+G3 |`,
  LH_A_END1: 'C4+G3+C3:0.5 G3+G2 A3+A2 B3+B2 |',
  LH_A_END2: 'C4+G3+C3:0.5 G3+G2 C3+C2 r |',
  // B strain, 15 bars (last chord tied into the endings)
  RH_B: `
    G5+E5+G4:0.5 A5+E5+A4:0.25 G5+E5+G4:0.5 E5+C5+E4:0.25 F5+D5+F4 F#5+D#5+F#4 |
    G5+E5+G4:0.5 A5+E5+A4:0.25 G5+E5+G4:0.5 E5:0.25 C5 G4 |
    A4:0.25 B4 C5 D5 E5 D5 C5 D5 |
    G4:0.25 E5 F5 G5 A5 G5 E5 F5 |
    G5+E5+G4:0.5 A5+E5+A4:0.25 G5+E5+G4:0.5 E5+C5+E4:0.25 F5+D5+F4 F#5+D#5+F#4 |
    G5+E5+G4:0.5 A5+E5+A4:0.25 G5+E5+G4:0.5 G5:0.25 A5 A#5 |
    B5+G5+D5:0.25 B5+G5+D5:0.5 B5+F#5+C5 A5:0.25 F#5+C5 D5 |
    G5+B4:1.25 E5+C5+E4:0.25 F5+D5+F4 F#5+D#5+F#4 |
    G5+E5+G4:0.5 A5+E5+A4:0.25 G5+E5+G4:0.5 E5+C5+E4:0.25 F5+D5+F4 F#5+D#5+F#4 |
    G5+E5+G4:0.5 A5+E5+A4:0.25 G5+E5+G4:0.5 E5:0.25 C5 G4 |
    A4:0.25 B4 C5 D5 E5 D5 C5 D5 |
    C5:1.25 G4:0.25 F#4 G4 |
    C5:0.5 A4:0.25 C5:0.5 A4:0.25 C5 A4 |
    G4:0.25 C5 E5 G5:0.5 E5:0.25 C5 G4 |
    A4+F#4:0.5 C5+F#4 E5+F4:0.25 D5+F4:0.5 C5+E4:0.25~ |`,
  RH_B_END1: 'C5+E4:1.25 E6+C6+E5:0.25 F6+D6+F5 F#6+D#6+F#5 |',
  RH_B_END2: 'C5+E4:1.5',
  LH_B: `
    C3+C2:0.5 E4+C4+G3 G2 E4+C4+G3 |
    C3:0.5 E4+C4+G3 G2 E4+C4+G3 |
    F2:0.5 F4+C4+A3 F3 F4+C4+Ab3 |
    E3:0.5 E4+C4+G3 G2 E4+C4+G3 |
    C3:0.5 E4+C4+G3 G2 E4+C4+G3 |
    C3:0.5 E4+C4+G3 E3 Eb3 |
    D3:0.5 D4+B3+G3 D3 D4+C4+A3 |
    D4+B3+G3:0.5 F3+F2 E3+E2 D3+D2 |
    C3+C2:0.5 E4+C4+G3 G2 E4+C4+G3 |
    C3:0.5 E4+C4+G3 G2 E4+C4+G3 |
    F2:0.5 F4+C4+A3 F3 F4+C4+Ab3 |
    E3:0.5 E4+C4+G3 C3 E4+C4+Bb3 |
    F4+C4+A3+F3:0.5 F4+C4+A3+F3 D#4+C4+A3+F#3 D#4+C4+A3+F#3 |
    E4+C4+G3:0.5 E4+C4+G3 E4+C4+G3 E4+C4+G3 |
    C4+D3:0.5 A3+D3 B3+G3 B3+G3 |`,
  LH_B_END1: 'C4+C3:0.5 G3+G2 E3+E2 D3+D2 |',
  LH_B_END2: 'C4+C3:0.5 G3+G2 C3+C2 r |',
};

function theEntertainer() {
  rng = rngFor(1902);
  const s = new Song({ file: 'the-entertainer.mid', title: 'The Entertainer', composer: 'Scott Joplin', info: 'A Ragtime Two Step (1902). Not fast.' });
  s.timeSig(0, 2, 4);
  s.keySig(0, 0);
  s.tempo(0, 76);
  const rh = s.track('Piano (right hand)', 0, { program: GM.ACOUSTIC_GRAND, volume: 110, pan: 74, reverb: 42, chorus: 0 });
  const lh = s.track('Piano (left hand)', 1, { program: GM.ACOUSTIC_GRAND, volume: 106, pan: 54, reverb: 42, chorus: 0 });

  const BAR = 2;
  // Dynamics from the 1902 edition: the A strain swells p -> f every two bars.
  const A_DYN = [64, 70, 90, 84, 64, 70, 90, 84, 64, 72, 92, 92, 90, 90, 92, 84];
  const B_DYN = [92, 92, 92, 92, 92, 92, 92, 92, 66, 66, 66, 64, 66, 74, 84, 88];
  const rhOpts = (start, dyn, extra = {}) => ({ vel: perBar(start, BAR, dyn), gate: 0.88, meter: 2, accent: 5, top: 10, jitter: 3, ...extra });
  const lhOpts = (start, dyn) => ({ vel: (b) => perBar(start, BAR, dyn)(b) - 14, gate: 0.8, meter: 1, accent: 10, top: 0, jitter: 3 });
  const both = (t, rhSrc, lhSrc, dyn, rhExtra) => {
    const e1 = play(rh, t, rhSrc, rhOpts(t, dyn, rhExtra));
    const e2 = play(lh, t, lhSrc, lhOpts(t, dyn));
    if (!near(e1, e2)) throw new Error(`Entertainer hands out of sync at ${t}: ${e1} vs ${e2}`);
    return e1;
  };

  let t = 0;
  s.marker(t, 'Intro');
  t = both(t, ENT.RH_INTRO, ENT.LH_INTRO, [96, 92, 88, 80]);
  s.marker(t, 'A');
  t = both(t, ENT.RH_A + ENT.RH_A_END1, ENT.LH_A + ENT.LH_A_END1, A_DYN);
  t = both(t, ENT.RH_A + ENT.RH_A_END2, ENT.LH_A + ENT.LH_A_END2, A_DYN);
  s.marker(t, 'B');
  t = both(t, ENT.RH_B + ENT.RH_B_END1, ENT.LH_B + ENT.LH_B_END1, B_DYN);
  // Repeat 8va: right hand an octave up, then back down for the pickup into A
  const rEnd = play(rh, t, ENT.RH_B + ENT.RH_B_END2, rhOpts(t, B_DYN, { transpose: 12 }));
  play(rh, rEnd, 'D4:0.25 D#4', rhOpts(t, B_DYN));
  t = play(lh, t, ENT.LH_B + ENT.LH_B_END2, lhOpts(t, B_DYN));
  s.marker(t, 'A');
  const finalStart = t + 15 * BAR;
  s.tempo(finalStart, 72);
  s.tempo(finalStart + 1, 66);
  t = both(t, ENT.RH_A + ENT.RH_A_FINAL, ENT.LH_A + ENT.LH_A_END2, A_DYN);
  return s;
}

// ===========================================================================
// 4. Beethoven — Für Elise (Bagatelle WoO 59, 1810)
// ===========================================================================
// A, A, B+A, B, the F-major episode, A. (3/8; one bar = 1.5 beats.)
const ELISE = {
  PICKUP: 'E5:0.25 D#5',
  RH_A: `
    E5:0.25 D#5 E5 B4 D5 C5 |
    A4:0.5 r:0.25 C4 E4 A4 |
    B4:0.5 r:0.25 E4 G#4 B4 |
    C5:0.5 r:0.25 E4 E5 D#5 |
    E5:0.25 D#5 E5 B4 D5 C5 |
    A4:0.5 r:0.25 C4 E4 A4 |
    B4:0.5 r:0.25 E4 C5 B4 |`,
  LH_A: `
    r:1.5 |
    A2:0.25 E3 A3 r:0.75 |
    E2:0.25 E3 G#3 r:0.75 |
    A2:0.25 E3 A3 r:0.75 |
    r:1.5 |
    A2:0.25 E3 A3 r:0.75 |
    E2:0.25 E3 G#3 r:0.75 |`,
  RH_END_REPEAT: 'A4:1 E5:0.25 D#5 |', // back to the top (with the pickup)
  RH_END_TO_B: 'A4:0.5 r:0.25 B4 C5 D5 |',
  RH_END_TO_F: 'A4:0.5 r:0.25 E4+C5 F4+C5 E4+G4+C5 |',
  LH_END: 'A2:0.25 E3 A3 r:0.75 |',
  LH_END_TO_F: 'A2:0.25 E3 A3 Bb3+C4 A3+C4 G3+Bb3+C4 |',
  RH_B: `
    E5:0.75 G4:0.25 F5 E5 |
    D5:0.75 F4:0.25 E5 D5 |
    C5:0.75 E4:0.25 D5 C5 |
    B4:0.5 r:0.25 E4 E5 r |
    r:0.25 E5 E6 r r D#5 |
    E5:0.5 r:0.25 D#5 E5 D#5 |`,
  LH_B: `
    C3:0.25 G3 C4 r:0.75 |
    G2:0.25 G3 B3 r:0.75 |
    A2:0.25 E3 A3 r:0.75 |
    E2:0.25 E3 E4 r r E4 |
    E5:0.25 r r D#5 E5 r |
    r:0.25 D#5 E5 r r:0.5 |`,
  RH_F: `
    C5:1 F5:0.375 E5:0.125 |
    E5:0.5 D5 Bb5:0.375 A5:0.125 |
    A5:0.25 G5 F5 E5 D5 C5 |
    Bb4:0.5 A4 A4:0.125 G4 A4 Bb4 |
    C5:1 D5:0.25 D#5 |
    E5:0.75 E5:0.25 F5 A4 |
    C5:1 D5:0.375 B4:0.125 |
    C5:0.125 G5 G4 G5 A4 G5 B4 G5 C5 G5 D5 G5 |
    E5:0.125 G5 C6 B5 A5 G5 F5 E5 D5 G5 F5 D5 |
    C5:0.125 G5 G4 G5 A4 G5 B4 G5 C5 G5 D5 G5 |
    E5:0.125 G5 C6 B5 A5 G5 F5 E5 D5 G5 F5 D5 |
    E5:0.125 F5 E5 D#5 E5 B4 E5 D#5 E5 B4 E5 D#5 |
    E5:0.75 B4:0.25 E5 D#5 |
    E5:0.75 B4:0.25 E5 D#5 |
    E5:0.25 D#5 E5 D#5 E5 D#5 |`,
  LH_F: `
    F3:0.25 A3 C4 A3 C4 A3 |
    F3:0.25 Bb3 D4 Bb3 D4 Bb3 |
    F3:0.25 E4 F3+G3+Bb3 E4 F3+G3+Bb3 E4 |
    F3:0.25 A3 C4 A3 C4 A3 |
    F3:0.25 A3 C4 A3 C4 A3 |
    E3:0.25 A3 C4 A3 D3+D4 F3 |
    G3:0.25 E4 G3 E4 G3 F4 |
    C4+E4:0.5 r:0.25 F4+G4 E4+G4 D4+F4+G4 |
    C4+E4+G4:0.5 F3+A3 G3+B3 |
    C4:0.5 r:0.25 F4+G4 E4+G4 D4+F4+G4 |
    C4+E4+G4:0.5 F3+A3 G3+B3 |
    G#3+B3:0.5 r:1 |
    r:1.5 | r:1.5 | r:1.5 |`,
  RH_FINAL: 'A4:1.5 |',
  LH_FINAL: 'A1+A2:1.5 |',
};

function furElise() {
  rng = rngFor(1810);
  const s = new Song({ file: 'fur-elise.mid', title: 'Für Elise', composer: 'Ludwig van Beethoven', info: 'Bagatelle in A minor, WoO 59. Poco moto.' });
  s.timeSig(0, 3, 8);
  s.keySig(0, 0, true);
  s.tempo(0, 66);
  const rh = s.track('Piano (right hand)', 0, { program: GM.ACOUSTIC_GRAND, volume: 108, pan: 72, reverb: 58, chorus: 0 });
  const lh = s.track('Piano (left hand)', 1, { program: GM.ACOUSTIC_GRAND, volume: 104, pan: 56, reverb: 58, chorus: 0 });

  const BAR = 1.5;
  const pedalBars = new Set();
  const lhNotes = [];
  const R = (t, src, vel, extra = {}) => play(rh, t, src, { vel, gate: 0.92, meter: BAR, accent: 6, jitter: 3, top: 6, ...extra });
  const L = (t, src, vel) => play(lh, t, src, { vel, gate: 0.9, meter: BAR, accent: 6, jitter: 2, ringTo: BAR, ringMax: 60, collect: lhNotes });
  const both = (t, rhSrc, lhSrc, vel) => {
    const e1 = R(t, rhSrc, vel);
    const e2 = L(t, lhSrc, (typeof vel === 'function' ? vel(t) : vel) - 12);
    if (!near(e1, e2)) throw new Error(`Für Elise hands out of sync at ${t}: ${e1} vs ${e2}`);
    return e1;
  };

  // One empty bar, then the pickup lands on its last eighth.
  let t = BAR;
  R(t - 0.5, ELISE.PICKUP, 56);
  s.marker(t, 'A');
  t = both(t, ELISE.RH_A + ELISE.RH_END_REPEAT, ELISE.LH_A + ELISE.LH_END, 58);
  t = both(t, ELISE.RH_A + ELISE.RH_END_TO_B, ELISE.LH_A + ELISE.LH_END, 60);
  for (const last of [false, true]) {
    s.marker(t, 'B');
    t = both(t, ELISE.RH_B, ELISE.LH_B, ramp([t, 66], [t + 4 * BAR, 72], [t + 6 * BAR, 58]));
    t = both(t, ELISE.RH_A + (last ? ELISE.RH_END_TO_F : ELISE.RH_END_TO_B), ELISE.LH_A + (last ? ELISE.LH_END_TO_F : ELISE.LH_END), 58);
  }
  // F major episode (grace notes F-A before the first C; Bb appoggiatura in bar 4)
  s.marker(t, 'C');
  grace(rh, t, ['F4', 'A4'], 0.07, 56);
  grace(rh, t + 3 * BAR + 1, ['Bb4'], 0.06, 58);
  const fEnd = t + 15 * BAR;
  s.tempo(fEnd - 3 * BAR, 63);
  s.tempo(fEnd - BAR, 58);
  t = both(t, ELISE.RH_F, ELISE.LH_F, ramp([t, 68], [t + 7 * BAR, 74], [t + 11 * BAR, 80], [t + 12 * BAR, 62], [fEnd, 54]));
  s.tempo(t, 66);
  // ...and home: the A theme once more, slowing into the last A minor
  s.marker(t, 'A');
  s.tempo(t + 6 * BAR, 60);
  s.tempo(t + 7 * BAR, 50);
  t = both(t, ELISE.RH_A + ELISE.RH_FINAL, ELISE.LH_A + ELISE.LH_FINAL, ramp([t, 58], [t + 8 * BAR, 46]));

  // Damper pedal for each bar that starts with a left-hand arpeggio (as marked in the score)
  for (const nt of lhNotes) {
    const pos = mod(nt.start, BAR);
    if (nt.pitch <= n('C3') && near(pos, 0)) pedalBars.add(nt.start);
  }
  for (const b of [...pedalBars].sort((a, c) => a - c)) lh.pedal(b + 0.03, b + 1.38);
  return s;
}

// ===========================================================================
// 5. Grieg — In the Hall of the Mountain King (Peer Gynt, 1875)
// ===========================================================================
// One long accelerando: bassoons + pizzicato in the dark, strings and oboe join,
// then everybody (piccolo-ish flute, brass, timpani, cymbals) for the stretto
// and the final hammer blows.
const MK = {
  A: `B3:0.5 C#4 D4 E4 F#4! D4 F#4:1 |
      E#4:0.5! C#4 E#4:1 E4:0.5! C4 E4:1 |
      B3:0.5 C#4 D4 E4 F#4! D4 F#4 B4 |
      A4:0.5 F#4 D4 F#4 A4:2!_ |`,
  A_END: `B3:0.5 C#4 D4 E4 F#4! D4 F#4:1 |
      E#4:0.5! C#4 E#4:1 E4:0.5! C4 E4:1 |
      B3:0.5 C#4 D4 E4 F#4! D4 F#4 B4 |
      F#4:0.5 D4 F#4 B4 B3:2!_ |`,
  B: `F#3:0.5 G#3 A#3 B3 C#4! A#3 C#4:1 |
      D4:0.5! A#3 D4:1 C#4:0.5! A#3 C#4:1 |
      F#3:0.5 G#3 A#3 B3 C#4! A#3 C#4:1 |
      D4:0.5! A#3 D4:1 C#4:2!_ |`,
};

function mountainKing() {
  rng = rngFor(1875);
  const s = new Song({ file: 'hall-of-the-mountain-king.mid', title: 'In the Hall of the Mountain King', composer: 'Edvard Grieg', info: 'From Peer Gynt Suite No. 1, Op. 46. Alla marcia e molto marcato.' });
  s.timeSig(0, 4, 4);
  s.keySig(0, 2, true);

  const bsn = s.track('Bassoons', 0, { program: GM.BASSOON, volume: 112, pan: 70, reverb: 50, chorus: 0 });
  const pizz = s.track('Pizzicato Strings', 1, { program: GM.PIZZICATO_STRINGS, volume: 104, pan: 46, reverb: 60, chorus: 10 });
  const cello = s.track('Cellos & Basses', 2, { program: GM.CELLO, volume: 104, pan: 52, reverb: 55, chorus: 0 });
  const vln = s.track('Violins', 3, { program: GM.STRING_ENSEMBLE_1, volume: 106, pan: 34, reverb: 64, chorus: 20 });
  const oboe = s.track('Oboe', 4, { program: GM.OBOE, volume: 92, pan: 82, reverb: 60, chorus: 0 });
  const flute = s.track('Flute', 5, { program: GM.FLUTE, volume: 90, pan: 92, reverb: 64, chorus: 0 });
  const brass = s.track('Trumpets', 6, { program: GM.BRASS_SECTION, volume: 100, pan: 76, reverb: 58, chorus: 10 });
  const tbn = s.track('Trombones', 7, { program: GM.TROMBONE, volume: 104, pan: 60, reverb: 56, chorus: 0 });
  const timp = s.track('Timpani', 8, { program: GM.TIMPANI, volume: 108, pan: 64, reverb: 66, chorus: 0 });
  const perc = s.track('Percussion', 9, { program: 0, volume: 100, pan: 64, reverb: 66, chorus: 0 });
  const horn = s.track('French Horns', 10, { program: GM.FRENCH_HORN, volume: 96, pan: 88, reverb: 70, chorus: 10 });

  // --- form: [phrase, transpose] per 4-bar phrase -------------------------
  const SEC1 = [['A', -12], ['A', -12], ['B', -12], ['B', 0], ['A', -12], ['A', -12]];
  const SEC2 = [['A', 0], ['A', 0], ['B', 0], ['B', 12]];
  const SEC3 = [['A', 12], ['A', 12], ['B', 12], ['B', 24], ['A', 12], ['A_END', 12]];
  const s1 = 4, s2 = s1 + SEC1.length * 16, s3 = s2 + SEC2.length * 16, sEnd = s3 + SEC3.length * 16;

  // --- tempo: one long accelerando ----------------------------------------
  s.tempo(0, 52);
  const accel = (from, to, bpm0, bpm1) => {
    for (let b = from; b < to; b += 4) s.tempo(b, Math.round(bpm0 + ((b - from) / (to - from)) * (bpm1 - bpm0)));
  };
  accel(s1, s2, 100, 122);
  accel(s2, s3, 124, 148);
  accel(s3, sEnd, 152, 188);
  s.tempo(sEnd, 192);

  // opening: horns hold F# (the fermata)
  play(horn, 0, 'F#3+F#4:3.6_', { vel: 52, accent: 0 });

  // accompaniment figures per phrase bar
  const bassFor = (ph, bar) => {
    if (ph === 'B') return bar % 2 === 0 ? ['F#2', 'C#3', 'F#2', 'C#3'] : ['D2', 'A#2', 'F#2', 'C#3'];
    return bar === 3 && ph === 'A' ? ['D2', 'A2', 'D2', 'A2'] : ['B1', 'F#2', 'B1', 'F#2'];
  };
  // the little "oom - (F#+D) E# F#" turn from Grieg's accompaniment
  const turnFor = (ph, bar, half) => {
    if (ph === 'B') return bar % 2 === 1 && half === 0 ? ['D3+A#3', 'C#3', 'D3'] : ['C#3+A#3', 'B#2', 'C#3'];
    if (bar === 1) return half === 0 ? ['F#3+C#4', 'E#3', 'F#3'] : ['F#3+C4', 'E#3', 'F#3'];
    if (bar === 3 && ph === 'A') return ['A3+F#4', 'G#3', 'A3'];
    return ['F#3+D4', 'E#3', 'F#3'];
  };
  const tbnFor = (ph, bar) => {
    if (ph === 'B') return bar % 2 === 0 ? 'F#2+F#3:0.5! E3 D3 C#3 F#2+F#3! E3 D3 C#3' : 'D2+D3:0.5! C#3 D3 E3 F#2+F#3! E3 D3 C#3';
    if (bar === 3 && ph === 'A') return 'D3+D4:0.5! C#4 B3 A3 D3+D4! C#4 B3 A3';
    if (bar === 3 && ph === 'A_END') return 'B2+B3:0.5! A3 G3 F#3 B2+B3:2!_';
    return 'B2+B3:0.5! A3 G3 F#3 B2+B3! A3 G3 F#3';
  };
  const hornFor = (ph, bar) => {
    if (ph === 'B') return 'F#3+C#4:2 F#3+C#4';
    if (bar === 3 && ph === 'A') return 'A3+D4:2 A3+D4';
    return 'B3+B4:2 B3+B4';
  };

  // --- Section I: in the dark (pp, bassoons + pizzicato) ------------------
  let t = s1;
  SEC1.forEach(([ph, tr], i) => {
    const v = 46 + i * 2;
    play(bsn, t, MK[ph], { vel: v, gate: 0.5, transpose: tr, accent: 4 });
    for (let bar = 0; bar < 4; bar++) {
      let notes = bassFor(ph, bar);
      if (i === 5 && bar === 2) notes = ['B1', 'B2', 'A2', 'G2'];
      if (i === 5 && bar === 3) notes = ['F#2', 'E2', 'C#2', 'B1'];
      play(pizz, t + bar * 4, notes.map((x) => `${x}:1`).join(' '), { vel: v + 6, gate: 0.3, accent: 6 });
    }
    t += 16;
  });

  // --- Section II: strings take the tune (mf, crescendo) ------------------
  SEC2.forEach(([ph, tr], i) => {
    const v = (b) => 66 + ((b - s2) / (s3 - s2)) * 22;
    play(vln, t, MK[ph], { vel: v, gate: 0.45, transpose: tr, accent: 5 });
    play(oboe, t, MK[ph], { vel: (b) => v(b) - 8, gate: 0.45, transpose: tr + 12, accent: 5 });
    for (let bar = 0; bar < 4; bar++) {
      const tb = t + bar * 4;
      const [b0, , b2] = bassFor(ph, bar);
      const lowBass = (x) => (n(x) < n('C2') ? n(x) + 12 : n(x)); // keep the cellos in range
      cello.note(lowBass(b0), tb, 0.45, v(tb) + 4);
      cello.note(lowBass(b2), tb + 2, 0.45, v(tb));
      bsn.note(lowBass(b0), tb, 0.45, v(tb) - 6);
      bsn.note(lowBass(b2), tb + 2, 0.45, v(tb) - 8);
      for (const half of [0, 1]) {
        const [c, x, y] = turnFor(ph, bar, half);
        play(pizz, tb + half * 2 + 1, `${c}:0.25 ${x} ${y}:0.5`, { vel: v(tb) - 4, gate: 0.6, accent: 0 });
      }
      timp.note(ph === 'B' ? 'F#2' : 'B2', tb, 0.5, 40 + i * 6);
    }
    t += 16;
  });

  // --- Section III: più vivo, tutti ff --------------------------------------
  SEC3.forEach(([ph, tr], i) => {
    const v = (b) => 100 + ((b - s3) / (sEnd - s3)) * 16;
    play(vln, t, MK[ph], { vel: v, gate: 0.5, transpose: tr, accent: 6 });
    play(flute, t, MK[ph], { vel: (b) => v(b) - 10, gate: 0.5, transpose: tr + 12, accent: 6 });
    play(oboe, t, MK[ph], { vel: (b) => v(b) - 12, gate: 0.5, transpose: tr, accent: 6 });
    if (i >= 4) play(brass, t, MK[ph], { vel: (b) => v(b) - 4, gate: 0.55, transpose: tr, accent: 6 });
    for (let bar = 0; bar < 4; bar++) {
      const tb = t + bar * 4;
      const line = tbnFor(ph === 'A_END' && bar < 3 ? 'A' : ph, bar);
      play(tbn, tb, line, { vel: v(tb) - 8, gate: 0.5, accent: 4 });
      play(bsn, tb, line, { vel: v(tb) - 12, gate: 0.5, accent: 4 });
      play(cello, tb, line, { vel: v(tb) - 10, gate: 0.5, accent: 4, transpose: -12 });
      play(horn, tb, hornFor(ph, bar), { vel: v(tb) - 16, gate: 0.9, accent: 0 });
      const [q0, q1, q2, q3] = ph === 'B' ? ['F#2', 'C#3', 'F#2', 'C#3'] : ['B2', 'F#2', 'B2', 'F#2'];
      play(timp, tb, `${q0}:1 ${q1} ${q2} ${q3}`, { vel: v(tb) - 6, gate: 0.6, accent: 10 });
      perc.note(DRUM.BASS_DRUM_1, tb, 0.2, v(tb) - 6);
      perc.note(DRUM.BASS_DRUM_1, tb + 2, 0.2, v(tb) - 14);
      if (bar === 0) perc.note(DRUM.CRASH, tb, 1, i >= 4 ? 120 : 104);
      if (i >= 4 && bar === 2) perc.note(DRUM.CRASH_2, tb, 1, 112);
    }
    t += 16;
  });

  // --- Coda: the hammer blows ----------------------------------------------
  const DIM = 'D4+F4+G#4+B4'; // B-diminished blow (D E# G# B)
  const blow = (b, v = 122) => {
    play(vln, b, `${DIM}+D5+B5:0.5*`, { vel: v, accent: 0 });
    play(brass, b, `${DIM}:0.5*`, { vel: v - 2, accent: 0 });
    play(horn, b, `${DIM}:0.5*`, { vel: v - 8, accent: 0 });
    play(oboe, b, 'B5:0.5*', { vel: v - 10, accent: 0 });
    grace(flute, b, ['G#5', 'A5', 'A#5'], 0.07, v - 20);
    flute.note('B5', b, 0.3, v - 4);
    perc.note(DRUM.CRASH, b, 0.8, v - 10);
  };
  const lowB = (b, v = 124) => {
    play(tbn, b, 'B1+B2:0.6', { vel: v, accent: 0 });
    play(cello, b, 'B1+B2:0.6', { vel: v - 4, accent: 0 });
    play(bsn, b, 'B2:0.6', { vel: v - 10, accent: 0 });
    timp.note('B2', b, 0.6, v);
    perc.note(DRUM.BASS_DRUM_1, b, 0.3, v);
  };
  const run = (b) => {
    play(vln, b, 'B4:0.5 C#5 D5 E5 F#5 D5 F#5 B5 | A#5 F#5 A#5 C#6 B5:2!_', { vel: 112, gate: 0.5, accent: 6 });
    play(flute, b, 'B5:0.5 C#6 D6 E6 F#6 D6 F#6 B6 | A#6 F#6 A#6 C#7 B6:2!_', { vel: 100, gate: 0.5, accent: 6 });
    play(tbn, b, 'G2+G3:1 r F#2+F#3 r | F#1+F#2 r B1+B2 r', { vel: 112, gate: 0.6, accent: 0 });
    play(cello, b, 'G2+G3:1 r F#2+F#3 r | F#2 r B1+B2 r', { vel: 108, gate: 0.6, accent: 0 });
    play(brass, b, 'r:1 D4+G4+B4 r D4+F#4+B4 | r C#4+F#4+A#4 r D4+F#4+B4', { vel: 108, gate: 0.6, accent: 0 });
    play(horn, b, 'r:1 D4+G4+B4 r D4+F#4+B4 | r C#4+F#4+A#4 r D4+F#4+B4', { vel: 100, gate: 0.6, accent: 0 });
    timp.note('B2', b, 0.5, 108); timp.note('F#2', b + 2, 0.5, 100);
    timp.note('F#2', b + 4, 0.5, 104); timp.note('B2', b + 6, 0.5, 112);
  };
  const CODA = ['blow', 'blow', 'run', 'blow', 'blow', 'run', 'blow', 'blow', 'blow3', 'blow4', 'roll1', 'roll2', 'final'];
  t = sEnd;
  s.marker(t, 'Coda');
  for (const bar of CODA) {
    if (bar === 'blow') { lowB(t); blow(t + 1); }
    if (bar === 'blow3') { lowB(t, 84); blow(t + 1, 64); blow(t + 2, 72); blow(t + 3, 80); } // pp, then cresc.
    if (bar === 'blow4') [0, 1, 2, 3].forEach((k) => blow(t + k, 88 + k * 10));
    if (bar === 'run') { run(t); t += 4; }
    if (bar === 'roll1' || bar === 'roll2') {
      const from = bar === 'roll1' ? 2 : 0;
      for (let b = from; b < 4; b += 0.25) {
        const crescendo = 60 + ((bar === 'roll1' ? b - 2 : b + 2) / 6) * 60;
        timp.note('B2', t + b, 0.2, crescendo);
        vln.note(near(b % 0.5, 0) ? 'B2' : 'B3', t + b, 0.22, crescendo - 6);
        cello.note(near(b % 0.5, 0) ? 'B1' : 'B2', t + b, 0.22, crescendo - 6);
      }
      if (bar === 'roll2') perc.note(DRUM.CRASH, t + 3.5, 0.5, 90);
    }
    if (bar === 'final') {
      lowB(t, 127);
      perc.note(DRUM.CRASH, t, 1.5, 127);
      perc.note(DRUM.CRASH_2, t + 1, 1.5, 124);
      const chord = 'B2+D3+F#3+B3+D4+F#4+B4:0.75';
      for (const trk of [vln, brass, horn, tbn]) play(trk, t + 1, chord, { vel: 124, accent: 0 });
      play(flute, t + 1, 'B5+D6:0.75', { vel: 118, accent: 0 });
      play(oboe, t + 1, 'B5:0.75', { vel: 112, accent: 0 });
      play(cello, t + 1, 'B1+B2:0.75', { vel: 124, accent: 0 });
      timp.note('B2', t + 1, 0.8, 127);
      perc.note(DRUM.BASS_DRUM_1, t + 1, 0.4, 127);
    }
    t += 4;
  }
  s.end(t - 1.5); // trim the silent tail of the last bar
  return s;
}

// ===========================================================================
// Build everything
// ===========================================================================
const SONGS = [geocitiesGroove, theEntertainer, furElise, canonInD, mountainKing];

mkdirSync(OUT_DIR, { recursive: true });
const playlist = [];
for (const make of SONGS) {
  const song = make();
  const bytes = song.toBytes();
  writeFileSync(join(OUT_DIR, song.file), bytes);
  playlist.push({ file: song.file, title: song.title, composer: song.composer });
  const secs = song.durationSeconds();
  const channels = song.tracks
    .filter((t) => t.channel != null)
    .map((t) => `ch${t.channel + 1}:${t.channel === 9 ? 'drums' : GM_NAME[t.programNumber] ?? t.programNumber}`);
  console.log(`${song.file.padEnd(34)} ${String(bytes.length).padStart(6)} bytes  ${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}  ${channels.join(', ')}`);
}
writeFileSync(join(OUT_DIR, 'playlist.json'), JSON.stringify(playlist, null, 2) + '\n');
console.log(`wrote ${playlist.length} songs + playlist.json to ${OUT_DIR}`);
