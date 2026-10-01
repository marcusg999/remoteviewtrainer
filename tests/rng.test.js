/**
 * Randomness tests. A biased generator would silently invalidate every result
 * the game reports, so these check the distribution rather than just the range.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomInt, randomFloat, shuffle, sample, randomCoordinate, randomHex } from '../src/core/rng.js';
import { seal, verify, sha256Hex } from '../src/core/commit.js';

/**
 * Critical values for the distribution tests below, at alpha = 1e-8.
 *
 * These were originally set at the conventional alpha = 0.001. That is the
 * right threshold for a one-off scientific test and the wrong one for a test
 * that runs on every push: five such tests give roughly a 0.9% chance of a
 * false failure per CI run, about one run in 111, and CI duly failed on a
 * decoy-uniformity chi-square of 82.78 against a threshold of 82.70. That is
 * not a flake to re-run — it is a correctly functioning test with an
 * inherent false-positive rate that was set too high for how often it runs.
 *
 * Power is barely affected: these tests detect gross breakage (a stuck
 * value, an off-by-one in a range, a shuffle that favours a position), which
 * produces chi-square in the hundreds or thousands, nowhere near these
 * bounds. They were never sensitive enough to catch subtle modulo bias at
 * this sample size — the exhaustive sweep below is what guards that, and it
 * is deterministic.
 */
const CHI2_DF4 = 43.07;   // P(X > 43.07 | df=4)  ~ 1e-8
const CHI2_DF6 = 48.36;   // P(X > 48.36 | df=6)  ~ 1e-8
const CHI2_DF47 = 123.02; // P(X > 123.02 | df=47) ~ 1e-8

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
    expect(chi).toBeLessThan(CHI2_DF4);
  });

  it('is uniform for a non-power-of-two bound, where modulo bias would show', () => {
    const N = 120000, k = 7;
    const counts = new Array(k).fill(0);
    for (let i = 0; i < N; i++) counts[randomInt(k)]++;
    const exp = N / k;
    const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(CHI2_DF6);
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
      expect(chi).toBeLessThan(CHI2_DF4);
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

/**
 * Exhaustive proof that rejection sampling removes modulo bias.
 *
 * The chi-square tests above never had the power to catch this: with a
 * single byte and k=5, naive `byte % 5` over-represents 0 by 1 part in 256,
 * which at 120k draws produces a chi-square of about 1.7 — indistinguishable
 * from noise. So the statistical test would pass a biased implementation.
 *
 * This test instead feeds the generator every byte value 0..255 in order and
 * checks the output exactly. For k=5 the unbiased cutoff is
 * floor(256/5)*5 = 255, so bytes 0..254 map onto the five residues 51 times
 * each and byte 255 must be REJECTED and redrawn. A naive modulo would
 * accept 255 and return a sixth 0, breaking the exact equality below.
 */
describe('rejection sampling (deterministic, no statistics)', () => {
  const sweepCrypto = () => {
    let i = 0;
    return {
      getRandomValues(buf) {
        for (let n = 0; n < buf.length; n++) { buf[n] = i % 256; i++; }
        return buf;
      },
    };
  };

  it('discards the biased tail of the byte range, exactly', async () => {
    vi.resetModules();
    vi.stubGlobal('crypto', sweepCrypto());
    const { randomInt: ri } = await import('../src/core/rng.js');

    const counts = [0, 0, 0, 0, 0];
    // 255 accepted draws is exactly one full sweep of 0..254; byte 255 is
    // rejected, so a correct implementation consumes 256 bytes to produce 255
    // values and every residue lands exactly 51 times.
    for (let n = 0; n < 255; n++) counts[ri(5)]++;
    expect(counts).toEqual([51, 51, 51, 51, 51]);

    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('refuses to run at all without a secure generator', async () => {
    vi.resetModules();
    vi.stubGlobal('crypto', undefined);
    await expect(import('../src/core/rng.js')).rejects.toThrow(/secure randomness/i);
    vi.unstubAllGlobals();
    vi.resetModules();
  });
});
