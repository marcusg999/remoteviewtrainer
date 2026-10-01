/**
 * Randomness for target selection.
 *
 * Targets are drawn from the OS CSPRNG via crypto.getRandomValues, using
 * rejection sampling so every outcome is exactly equally likely. Math.random
 * is never used for anything a player is scored against — it is only allowed
 * for cosmetic things like particle jitter.
 */

const g = globalThis.crypto;
if (!g || typeof g.getRandomValues !== 'function') {
  throw new Error('Secure randomness unavailable; refusing to run a scored test.');
}

/** Uniform integer in [0, max). Rejection-sampled: no modulo bias. */
export function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) throw new Error('randomInt: bad max');
  if (max === 1) return 0;
  // Smallest byte count that can represent max-1.
  const bytes = Math.ceil(Math.log2(max) / 8);
  const limit = Math.floor(256 ** bytes / max) * max; // largest unbiased cutoff
  const buf = new Uint8Array(bytes);
  for (;;) {
    g.getRandomValues(buf);
    let v = 0;
    for (let i = 0; i < bytes; i++) v = v * 256 + buf[i];
    if (v < limit) return v % max;
  }
}

/** Uniform float in [0, 1) with 53 bits of entropy. Cosmetic use is fine too. */
export function randomFloat() {
  const buf = new Uint32Array(2);
  g.getRandomValues(buf);
  // 53-bit mantissa: 26 high bits + 27 low bits
  return ((buf[0] >>> 5) * 2 ** 27 + (buf[1] >>> 5)) / 2 ** 53;
}

/** Fisher-Yates, unbiased, in place. Returns the same array. */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/** Pick one element uniformly. */
export function pick(arr) {
  if (!arr.length) throw new Error('pick: empty');
  return arr[randomInt(arr.length)];
}

/** k distinct elements, uniformly, without replacement. */
export function sample(arr, k) {
  if (k > arr.length) throw new Error('sample: k too large');
  return shuffle(arr.slice()).slice(0, k);
}

/** Random hex string of `n` bytes. Used for salts and coordinates. */
export function randomHex(n) {
  const buf = new Uint8Array(n);
  g.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A Coordinate Remote Viewing-style 8-digit reference.
 * It is an arbitrary label for the target, exactly as in the original
 * protocol: the digits carry no information about the target itself.
 */
export function randomCoordinate() {
  let s = '';
  for (let i = 0; i < 8; i++) s += randomInt(10);
  return s.slice(0, 4) + '-' + s.slice(4);
}
