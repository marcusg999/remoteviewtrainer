/**
 * All sound is synthesised at runtime. No audio files to load, and the pitches
 * can track game state (the hit chime rises with a streak) which a sample
 * could not do.
 *
 * Browsers block audio until a gesture, so everything no-ops until unlock().
 */
let ctx = null;
let master = null;
let muted = false;
let ambientNodes = null;

export function unlock() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);
  if (ctx.state === 'suspended') ctx.resume();
}

export function setMuted(m) {
  muted = m;
  if (master) master.gain.setTargetAtTime(m ? 0 : 0.55, ctx.currentTime, 0.05);
}
export function isMuted() { return muted; }
export function ready() { return !!ctx && ctx.state === 'running'; }

function env(node, t0, a, d, peak = 1) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  node.connect(g);
  g.connect(master);
  return g;
}

function tone({ freq, type = 'sine', dur = 0.2, attack = 0.005, gain = 0.3, detune = 0, slideTo = null, delay = 0 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), t0 + dur);
  o.detune.value = detune;
  env(o, t0, attack, dur, gain);
  o.start(t0);
  o.stop(t0 + dur + attack + 0.05);
}

function noise({ dur = 0.2, gain = 0.2, filter = 1800, q = 1, type = 'bandpass', sweepTo = null, delay = 0 }) {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.setValueAtTime(filter, t0); f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  src.connect(f);
  env(f, t0, 0.004, dur, gain);
  src.start(t0);
}

/* ---- the actual cues ---- */

/** Card sliding off the deck. */
export const sfxDeal = () =>
  noise({ dur: 0.16, gain: 0.13, filter: 2600, sweepTo: 900, q: 0.8, type: 'bandpass' });

/** The turn itself — a short airy whoosh. */
export const sfxFlip = () => {
  noise({ dur: 0.2, gain: 0.16, filter: 700, sweepTo: 3200, q: 0.7 });
  tone({ freq: 180, type: 'triangle', dur: 0.1, gain: 0.05, slideTo: 300 });
};

/** Card landing on felt. */
export const sfxLand = () => {
  noise({ dur: 0.1, gain: 0.1, filter: 420, q: 0.9, type: 'lowpass' });
  tone({ freq: 90, type: 'sine', dur: 0.09, gain: 0.1, slideTo: 55 });
};

/** A hit. Pitch climbs with the streak so a run *sounds* like a run. */
export function sfxHit(streak = 0) {
  const base = 523.25; // C5
  const steps = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
  const semi = steps[Math.min(streak, steps.length - 1)];
  const f = base * 2 ** (semi / 12);
  tone({ freq: f, type: 'triangle', dur: 0.34, gain: 0.26, attack: 0.002 });
  tone({ freq: f * 2, type: 'sine', dur: 0.26, gain: 0.11, attack: 0.002 });
  tone({ freq: f * 3, type: 'sine', dur: 0.16, gain: 0.05, delay: 0.015 });
  noise({ dur: 0.1, gain: 0.07, filter: 6000, q: 0.5, type: 'highpass' });
}

/** A miss. Deliberately soft — this happens 80% of the time and must not nag. */
export function sfxMiss() {
  tone({ freq: 196, type: 'sine', dur: 0.2, gain: 0.12, slideTo: 150 });
  noise({ dur: 0.12, gain: 0.05, filter: 500, q: 0.8, type: 'lowpass' });
}

/** Guess committed. */
export const sfxCommit = () => {
  tone({ freq: 330, type: 'square', dur: 0.06, gain: 0.06 });
  tone({ freq: 494, type: 'square', dur: 0.08, gain: 0.05, delay: 0.05 });
};

export const sfxHover = () =>
  tone({ freq: 880, type: 'sine', dur: 0.035, gain: 0.025 });

/** End-of-run sting, scaled by how unusual the result was. */
export function sfxResult(z) {
  const strong = z >= 1.64;
  const notes = strong ? [523.25, 659.25, 783.99, 1046.5] : [392, 440, 392];
  notes.forEach((f, i) =>
    tone({ freq: f, type: 'triangle', dur: 0.5, gain: 0.17, delay: i * 0.1 }));
  if (strong) noise({ dur: 0.7, gain: 0.07, filter: 3000, q: 0.4, type: 'bandpass', delay: 0.05 });
}

/** Low room tone + a slow candle hiss. Starts on first unlock. */
export function startAmbient() {
  if (!ctx || ambientNodes) return;
  const g = ctx.createGain();
  g.gain.value = 0.055;
  g.connect(master);

  // room hum
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.value = 54;
  const og = ctx.createGain(); og.gain.value = 0.5;
  o.connect(og); og.connect(g); o.start();

  // filtered noise bed
  const n = ctx.createBufferSource();
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995; d[i] = last; }
  n.buffer = buf; n.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 420;
  n.connect(f); f.connect(g); n.start();

  ambientNodes = { g, o, n };
}
