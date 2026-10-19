#!/usr/bin/env node
// Renders a MIDI file to WAV offline, using the exact same synth code the
// browser runs in its AudioWorklet. Handy for testing and for making WAVs.
//
//   node tools/render.mjs song.mid [out.wav] [--fm | --sf2 path.sf2] [--rate 44100] [--seconds N]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Crescendo = require('../crescendo/crescendo.js');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const rate = +opt('--rate', 44100);
const sf2 = opt('--sf2', null);
const maxSec = +opt('--seconds', 0);
const fmOnly = flag('--fm');
const quiet = flag('--quiet');
const [input, output = input.replace(/\.\w+$/, '') + '.wav'] = args;
if (!input) {
  console.error('usage: node tools/render.mjs song.mid [out.wav] [--fm | --sf2 bank.sf2] [--rate 44100] [--seconds N]');
  process.exit(1);
}

// Minimal AudioWorkletGlobalScope.
let Proc = null;
const posted = [];
const scope = {
  sampleRate: rate,
  currentTime: 0,
  console,
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; } },
  registerProcessor: (_name, cls) => { Proc = cls; },
};
vm.runInNewContext(Crescendo.workletSource(), scope);
const synth = new Proc();
const send = (data) => synth.port.onmessage({ data });

if (sf2 && !fmOnly) {
  const t0 = performance.now();
  const b = readFileSync(sf2);
  const bank = Crescendo.parseSF2(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  if (!quiet) console.log(`SoundFont "${bank.name}": ${bank.presets.length} presets, ${bank.samples.length} samples (${(performance.now() - t0).toFixed(0)} ms)`);
  send({ cmd: 'sf2', bank });
  send({ cmd: 'engine', kind: 'sf2' });
}

const f = readFileSync(input);
const song = Crescendo.parseMidi(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
if (!quiet) console.log(`"${song.title || input}": ${song.times.length} events, ${song.notes} notes, ${song.duration.toFixed(1)} s`);
send({ cmd: 'load', times: song.times, msgs: song.msgs, sysex: song.sysex, duration: song.duration + 0.25 });
send({ cmd: 'play' });

const BLOCK = 128;
const total = Math.ceil((maxSec || song.duration + 3) * rate);
const L = new Float32Array(total), R = new Float32Array(total);
const outL = new Float32Array(BLOCK), outR = new Float32Array(BLOCK);
const t0 = performance.now();
let maxVoices = 0;
for (let off = 0; off < total; off += BLOCK) {
  synth.process([], [[outL, outR]]);
  scope.currentTime += BLOCK / rate;
  maxVoices = Math.max(maxVoices, synth.voices.length);
  const n = Math.min(BLOCK, total - off);
  L.set(outL.subarray(0, n), off);
  R.set(outR.subarray(0, n), off);
}
const ms = performance.now() - t0;

let peak = 0, sum = 0, clipped = 0, bad = 0;
for (let i = 0; i < total; i++) {
  for (const x of [L[i], R[i]]) {
    if (!Number.isFinite(x)) { bad++; continue; }
    const a = Math.abs(x);
    if (a > peak) peak = a;
    if (a > 0.98) clipped++;
    sum += x * x;
  }
}
const rms = Math.sqrt(sum / (2 * total));
const db = (x) => (20 * Math.log10(x || 1e-9)).toFixed(1);
if (!quiet) {
  console.log(`rendered ${(total / rate).toFixed(1)} s in ${ms.toFixed(0)} ms (${((total / rate) * 1000 / ms).toFixed(1)}x realtime), max voices ${maxVoices}`);
  console.log(`peak ${db(peak)} dBFS, rms ${db(rms)} dBFS, near-clip samples ${clipped}, non-finite ${bad}`);
}

const buf = Buffer.alloc(44 + total * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 4, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(total * 4, 40);
for (let i = 0; i < total; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] || 0)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] || 0)) * 32767), 46 + i * 4);
}
writeFileSync(output, buf);
if (!quiet) console.log('wrote', output);
export { peak, rms };
