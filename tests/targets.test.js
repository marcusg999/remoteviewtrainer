/**
 * Fairness of the remote-viewing target draw.
 *
 * Ranking the true target first must be a 1-in-5 proposition and nothing else.
 * Three things could silently break that: the true target could be drawn
 * non-uniformly from the pool, a decoy could duplicate the target, or the
 * target could favour a display position. All three are checked here, because
 * any of them would quietly invalidate every remote-viewing result.
 */
import { describe, it, expect } from 'vitest';
import { TARGETS, CANDIDATES, CHANCE, chooseTargetSet, byId, poolIntegrity } from '../src/data/targets.js';

/**
 * Critical values at alpha = 1e-8 rather than the conventional 0.001.
 * See the note in rng.test.js: at 0.001 these tests fail roughly one CI run
 * in 111 purely by chance, which is what happened. Detection power against
 * real bias is unaffected — a biased draw produces chi-square far above
 * either bound.
 */
const CHI2_DF4 = 43.07;    // P(X > 43.07 | df=4)  ~ 1e-8
const CHI2_DF47 = 123.02;  // P(X > 123.02 | df=47) ~ 1e-8

describe('target pool', () => {
  it('is large enough for the protocol', () => {
    expect(TARGETS.length).toBeGreaterThanOrEqual(40);
    expect(CANDIDATES).toBe(5);
    expect(CHANCE).toBeCloseTo(0.2, 12);
  });

  it('has unique ids and complete entries', () => {
    const ids = TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TARGETS) {
      expect(typeof t.id).toBe('string');
      expect(t.name).toBeTruthy();
      expect(Array.isArray(t.tags)).toBe(true);
      expect(t.tags.length).toBeGreaterThan(0);
      expect(typeof t.render).toBe('function');
      expect(byId(t.id)).toBe(t);
    }
  });

  it('reports itself clean', () => {
    const r = poolIntegrity();
    expect(r.dupes).toEqual([]);
    expect(r.malformed).toEqual([]);
    expect(r.size).toBe(TARGETS.length);
  });
});

describe('chooseTargetSet — the invariants that cannot break', () => {
  const N = 20000;

  it('never puts the true target in the decoys, and never duplicates', () => {
    for (let i = 0; i < 3000; i++) {
      const { target, decoys, order } = chooseTargetSet();
      expect(decoys).toHaveLength(CANDIDATES - 1);
      expect(decoys.some((d) => d.id === target.id)).toBe(false);
      expect(order).toHaveLength(CANDIDATES);
      expect(new Set(order.map((t) => t.id)).size).toBe(CANDIDATES);
      expect(order.some((t) => t.id === target.id)).toBe(true);
    }
  });

  it('refuses a pool too small to run the protocol', () => {
    expect(() => chooseTargetSet(TARGETS.slice(0, 3))).toThrow();
  });

  it('draws the true target uniformly across the pool', () => {
    const counts = new Map(TARGETS.map((t) => [t.id, 0]));
    for (let i = 0; i < N; i++) {
      const { target } = chooseTargetSet();
      counts.set(target.id, counts.get(target.id) + 1);
    }
    const k = TARGETS.length;
    const exp = N / k;
    let chi2 = 0;
    for (const c of counts.values()) chi2 += (c - exp) ** 2 / exp;
    expect(chi2).toBeLessThan(CHI2_DF47);
  });

  it('puts the true target in each display position about a fifth of the time', () => {
    const pos = new Array(CANDIDATES).fill(0);
    for (let i = 0; i < N; i++) {
      const { target, order } = chooseTargetSet();
      pos[order.findIndex((t) => t.id === target.id)]++;
    }
    const exp = N / CANDIDATES;
    const chi2 = pos.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
    // Position must leak nothing about which candidate is the target.
    expect(chi2).toBeLessThan(CHI2_DF4);
    for (const p of pos) expect(Math.abs(p / N - 0.2)).toBeLessThan(0.02);
  });

  it('uses every pool member as a decoy at a comparable rate', () => {
    const counts = new Map(TARGETS.map((t) => [t.id, 0]));
    for (let i = 0; i < N; i++) {
      for (const d of chooseTargetSet().decoys) counts.set(d.id, counts.get(d.id) + 1);
    }
    const k = TARGETS.length;
    const exp = (N * (CANDIDATES - 1)) / k;
    let chi2 = 0;
    for (const c of counts.values()) chi2 += (c - exp) ** 2 / exp;
    expect(chi2).toBeLessThan(CHI2_DF47);
  });
});
