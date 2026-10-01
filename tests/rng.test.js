/**
 * Randomness tests. A biased generator would silently invalidate every result
 * the game reports, so these check the distribution rather than just the range.
 */
import { describe, it, expect } from 'vitest';
import { randomInt, randomFloat, shuffle, sample, randomCoordinate, randomHex } from '../src/core/rng.js';
import { seal, verify, sha256Hex } from '../src/core/commit.js';

describe('randomInt', () => {
  it('stays in range', () => {
    for (const max of [1, 2, 5, 10, 256, 257, 1000]) {
      for (let i = 0; i < 400; i++) {
        const v = randomInt(max);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(max);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it('rejects bad input rather than silently biasing', () => {
    expect(() => randomInt(0)).toThrow();
    expect(() => randomInt(-3)).toThrow();
    expect(() => randomInt(2.5)).toThrow();
  });

  it('is uniform over the five Zener symbols', () => {
    const N = 120000, k = 5;
    const counts = new Array(k).fill(0);
    for (let i = 0; i < N; i++) counts[randomInt(k)]++;
    const exp = N / k;
    const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
    // df=4; the 0.001 critical value is 18.47. A fair generator clears this
    // essentially always, and a modulo-biased one would not.
    expect(chi).toBeLessThan(18.47);
  });

  it('is uniform for a non-power-of-two bound, where modulo bias would show', () => {
    const N = 120000, k = 7;
    const counts = new Array(k).fill(0);
    for (let i = 0; i < N; i++) counts[randomInt(k)]++;
    const exp = N / k;
    const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(22.46); // df=6, p=0.001
  });
});

describe('randomFloat', () => {
  it('stays in [0,1)', () => {
    for (let i = 0; i < 5000; i++) {
      const v = randomFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('has a mean near one half', () => {
    let s = 0; const N = 50000;
    for (let i = 0; i < N; i++) s += randomFloat();
    expect(Math.abs(s / N - 0.5)).toBeLessThan(0.01);
  });
});

describe('shuffle', () => {
  it('is a permutation', () => {
    const src = Array.from({ length: 25 }, (_, i) => i);
    const out = shuffle(src.slice());
    expect(out.slice().sort((a, b) => a - b)).toEqual(src);
  });

  it('puts every element in every position at roughly equal rates', () => {
    const n = 5, N = 60000;
    const counts = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < N; i++) {
      const a = shuffle([0, 1, 2, 3, 4]);
      a.forEach((v, pos) => counts[v][pos]++);
    }
    const exp = N / n;
    for (const row of counts) {
      const chi = row.reduce((acc, c) => acc + (c - exp) ** 2 / exp, 0);
      expect(chi).toBeLessThan(18.47); // df=4, p=0.001
    }
  });
});

describe('sample', () => {
  it('returns k distinct elements', () => {
    const pool = Array.from({ length: 40 }, (_, i) => i);
    for (let i = 0; i < 200; i++) {
      const s = sample(pool, 5);
      expect(s).toHaveLength(5);
      expect(new Set(s).size).toBe(5);
    }
  });
  it('refuses to oversample', () => {
    expect(() => sample([1, 2, 3], 4)).toThrow();
  });
});

describe('coordinates', () => {
  it('are eight digits in the documented shape', () => {
    for (let i = 0; i < 200; i++) {
      const c = randomCoordinate();
      expect(c).toMatch(/^\d{4}-\d{4}$/);
    }
  });
  it('do not repeat in any practical sense', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(randomCoordinate());
    expect(seen.size).toBeGreaterThan(1900);
  });
});

describe('commitment', () => {
  it('verifies a sealed payload', async () => {
    const s = await seal('zener:3:star');
    expect(await verify(s.reveal)).toBe(true);
    expect(s.digest).toHaveLength(64);
  });

  it('detects a changed target — this is the whole point', async () => {
    const s = await seal('zener:3:star');
    expect(await verify({ ...s.reveal, payload: 'zener:3:circle' })).toBe(false);
    expect(await verify({ ...s.reveal, salt: randomHex(16) })).toBe(false);
    expect(await verify({ ...s.reveal, digest: 'deadbeef' })).toBe(false);
  });

  it('rejects malformed proofs instead of passing them', async () => {
    expect(await verify({})).toBe(false);
    expect(await verify({ salt: 'a', payload: null, digest: 'b' })).toBe(false);
  });

  it('uses a fresh salt every time, so identical targets differ', async () => {
    const a = await seal('zener:0:star');
    const b = await seal('zener:0:star');
    expect(a.digest).not.toBe(b.digest);
  });

  it('matches a known SHA-256 vector', async () => {
    expect(await sha256Hex('abc'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
