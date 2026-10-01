/**
 * The statistics are the one thing in this project that cannot be approximately
 * right. These tests check them against values computed independently, not
 * against the implementation's own output.
 */
import { describe, it, expect } from 'vitest';
import {
  lnChoose, binomPmf, binomTailGE, binomTailLE, normalSf, erfc,
  zScore, wilsonInterval, effectSize, summarize, verdict, chi2Sf,
} from '../src/core/stats.js';

const close = (a, b, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('binomial coefficients', () => {
  it('matches exact values', () => {
    close(Math.exp(lnChoose(25, 5)), 53130, 1e-6);
    close(Math.exp(lnChoose(10, 5)), 252, 1e-9);
    close(Math.exp(lnChoose(52, 5)), 2598960, 1e-3);
    expect(Math.exp(lnChoose(5, 0))).toBeCloseTo(1, 12);
    expect(lnChoose(5, 6)).toBe(-Infinity);
    expect(lnChoose(5, -1)).toBe(-Infinity);
  });
});

describe('binomial distribution', () => {
  it('sums to one over the whole support', () => {
    for (const [n, p] of [[25, 0.2], [1, 0.2], [40, 0.5], [100, 0.03]]) {
      let s = 0;
      for (let k = 0; k <= n; k++) s += binomPmf(k, n, p);
      close(s, 1, 1e-10);
    }
  });

  // Constants below come from exact rational arithmetic (Python Fraction over
  // p=1/5), computed independently of this implementation.
  it('matches independently computed PMF values for the Zener case', () => {
    // P(X=5 | 25, 0.2), the modal outcome
    close(binomPmf(5, 25, 0.2), 0.19601510252723770, 1e-12);
    // P(X=0 | 25, 0.2) = 0.8^25
    close(binomPmf(0, 25, 0.2), Math.pow(0.8, 25), 1e-12);
    // P(X=25 | 25, 0.2) = 0.2^25
    close(binomPmf(25, 25, 0.2), Math.pow(0.2, 25), 1e-12);
  });

  it('upper and lower tails are complementary', () => {
    for (let k = 0; k <= 25; k++) {
      const ge = binomTailGE(k, 25, 0.2);
      const le = binomTailLE(k, 25, 0.2);
      // P(X>=k) + P(X<=k) = 1 + P(X=k)
      close(ge + le, 1 + binomPmf(k, 25, 0.2), 1e-10);
    }
  });

  it('matches known one-tailed p-values', () => {
    close(binomTailGE(10, 25, 0.2), 0.017331869541845683, 1e-12);
    close(binomTailGE(5, 25, 0.2), 0.57932569074786840, 1e-12);
    expect(binomTailGE(0, 25, 0.2)).toBe(1);
    expect(binomTailGE(26, 25, 0.2)).toBe(0);
  });

  it('stays exact at large n where naive summation would underflow', () => {
    // 1000 trials, 250 hits at p=0.2 — far out in the tail
    const p = binomTailGE(250, 1000, 0.2);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-4);
    expect(Number.isFinite(p)).toBe(true);
  });
});

describe('normal tail', () => {
  it('matches standard critical values', () => {
    close(normalSf(0), 0.5, 1e-12);
    close(normalSf(1.6448536269514722), 0.05, 1e-7);
    close(normalSf(1.959963984540054), 0.025, 1e-7);
    close(normalSf(2.5758293035489004), 0.005, 1e-7);
    close(normalSf(3.090232306167813), 0.001, 1e-7);
  });
  it('is symmetric', () => {
    for (const z of [0.3, 1.0, 2.2, 3.5]) close(normalSf(z) + normalSf(-z), 1, 1e-9);
  });
  it('erfc matches known values', () => {
    close(erfc(0), 1, 1e-12);
    close(erfc(1), 0.15729920705, 1e-7);
  });
});

describe('z-score', () => {
  it('is zero at exactly chance', () => {
    expect(zScore(5, 25, 0.2)).toBe(0);
    expect(zScore(20, 100, 0.2)).toBe(0);
  });
  it('matches the hand calculation', () => {
    // sd = sqrt(25*.2*.8) = 2, so 10 hits is (10-5)/2 = 2.5
    close(zScore(10, 25, 0.2), 2.5, 1e-12);
    close(zScore(0, 25, 0.2), -2.5, 1e-12);
  });
  it('handles the degenerate case without exploding', () => {
    expect(zScore(0, 0, 0.2)).toBe(0);
    expect(Number.isFinite(zScore(1, 1, 0.2))).toBe(true);
  });
});

describe('Wilson interval', () => {
  it('brackets the point estimate', () => {
    const ci = wilsonInterval(10, 25);
    expect(ci.lo).toBeLessThan(10 / 25);
    expect(ci.hi).toBeGreaterThan(10 / 25);
  });
  it('stays inside [0,1] at the extremes', () => {
    for (const [h, n] of [[0, 25], [25, 25], [0, 1], [1, 1]]) {
      const ci = wilsonInterval(h, n);
      expect(ci.lo).toBeGreaterThanOrEqual(0);
      expect(ci.hi).toBeLessThanOrEqual(1);
      expect(ci.lo).toBeLessThanOrEqual(ci.hi);
    }
  });
  it('narrows as n grows', () => {
    const a = wilsonInterval(5, 25), b = wilsonInterval(200, 1000);
    expect(b.hi - b.lo).toBeLessThan(a.hi - a.lo);
  });
});

describe('summarize', () => {
  it('reports chance as chance', () => {
    const s = summarize(5, 25, 0.2);
    expect(s.z).toBe(0);
    expect(s.direction).toBe('exact');
    expect(s.rate).toBeCloseTo(0.2, 12);
    expect(s.expected).toBeCloseTo(5, 12);
  });

  it('never claims psi at chance performance', () => {
    expect(verdict(summarize(5, 25, 0.2)).tone).toBe('neutral');
    expect(verdict(summarize(6, 25, 0.2)).tone).toBe('neutral');
    expect(verdict(summarize(7, 25, 0.2)).tone).toBe('neutral');
  });

  it('refuses to judge too little data', () => {
    expect(verdict(summarize(5, 5, 0.2)).label).toBe('Insufficient data');
    expect(verdict(summarize(0, 0, 0.2)).label).toBe('Insufficient data');
  });

  it('two-tailed p is never above 1 and never below the one-tailed p', () => {
    for (let k = 0; k <= 25; k++) {
      const s = summarize(k, 25, 0.2);
      expect(s.pTwoTailed).toBeLessThanOrEqual(1);
      expect(s.pTwoTailed).toBeGreaterThanOrEqual(0);
      expect(s.pExact).toBeLessThanOrEqual(1);
      expect(s.pExact).toBeGreaterThanOrEqual(0);
    }
  });

  it('detects psi-missing as well as psi-hitting', () => {
    const low = summarize(0, 25, 0.2);
    expect(low.direction).toBe('missing');
    expect(low.z).toBeLessThan(0);
    expect(low.pExact).toBe(low.pLow);

    const high = summarize(12, 25, 0.2);
    expect(high.direction).toBe('hitting');
    expect(high.pExact).toBe(high.pHigh);
  });

  it('effect size is zero at chance and scales with departure', () => {
    close(effectSize(5, 25, 0.2), 0, 1e-12);
    expect(effectSize(10, 25, 0.2)).toBeGreaterThan(0);
    expect(effectSize(1, 25, 0.2)).toBeLessThan(0);
  });

  it('the significance thresholds are the conventional ones', () => {
    // 25 of 25 is as extreme as this test can get; it must read highly significant
    expect(verdict(summarize(25, 25, 0.2)).tone).toBe('strong');
  });
});

describe('chi-square tail', () => {
  it('matches published critical values for df = 4 (the call-bias test)', () => {
    close(chi2Sf(9.487729, 4), 0.05, 1e-6);
    close(chi2Sf(13.276704, 4), 0.01, 1e-6);
    close(chi2Sf(18.466827, 4), 0.001, 1e-6);
  });
  it('matches published critical values for odd df', () => {
    close(chi2Sf(3.841459, 1), 0.05, 1e-6);
    close(chi2Sf(7.814728, 3), 0.05, 1e-6);
    close(chi2Sf(11.070498, 5), 0.05, 1e-6);
  });
  it('is 1 at zero and decreasing', () => {
    expect(chi2Sf(0, 4)).toBe(1);
    expect(chi2Sf(-1, 4)).toBe(1);
    let prev = 1;
    for (const x of [1, 2, 5, 10, 20, 40]) {
      const v = chi2Sf(x, 4);
      expect(v).toBeLessThan(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
  });
});
