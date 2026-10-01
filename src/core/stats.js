/**
 * Real statistics for psi testing. No fudging, ever.
 *
 * Every number shown to the player comes from this file. The headline figure is
 * the EXACT one-tailed binomial p-value; the z-score is the standard normal
 * approximation to the same test. We report both because the normal
 * approximation is unreliable at the small n a single session produces, and
 * hiding that would be lying to the player about their own data.
 */

/** Lanczos approximation to ln Γ(x), x > 0. |rel err| < 1e-13. */
const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lnGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ln C(n, k) — exact enough for any n we will ever log. */
export function lnChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  if (k === 0 || k === n) return 0;
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
}

/** ln P(X = k) for X ~ Binomial(n, p). */
export function lnBinomPmf(k, n, p) {
  if (k < 0 || k > n) return -Infinity;
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return lnChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p);
}

export function binomPmf(k, n, p) {
  return Math.exp(lnBinomPmf(k, n, p));
}

/** Numerically stable sum of exponentials given log terms. */
function logSumExp(logs) {
  let max = -Infinity;
  for (const v of logs) if (v > max) max = v;
  if (max === -Infinity) return -Infinity;
  let sum = 0;
  for (const v of logs) sum += Math.exp(v - max);
  return max + Math.log(sum);
}

/**
 * Exact one-tailed binomial p-value: P(X >= k) for X ~ Binomial(n, p).
 * This is the probability of scoring AT LEAST this well purely by guessing.
 * Summed in log space so it stays exact for large n.
 */
export function binomTailGE(k, n, p) {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const logs = [];
  for (let i = k; i <= n; i++) logs.push(lnBinomPmf(i, n, p));
  return Math.min(1, Math.exp(logSumExp(logs)));
}

/** Exact one-tailed low side: P(X <= k). Psi-missing is a real effect. */
export function binomTailLE(k, n, p) {
  if (k >= n) return 1;
  if (k < 0) return 0;
  const logs = [];
  for (let i = 0; i <= k; i++) logs.push(lnBinomPmf(i, n, p));
  return Math.min(1, Math.exp(logSumExp(logs)));
}

/**
 * Complementary error function. Rational Chebyshev approximation,
 * |rel err| < 1.2e-7 — enough for every p-value we display.
 */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  const cof = [
    -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
    6.529054439e-9, 5.059343495e-9, -9.91364156e-10, -2.27365122e-10,
    9.6467911e-11, 2.394038e-12, -6.886027e-12, 8.94487e-13,
    3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
  ];
  let d = 0, dd = 0;
  for (let j = cof.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + cof[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (cof[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

/** Upper tail of the standard normal: P(Z >= z). */
export function normalSf(z) {
  return 0.5 * erfc(z / Math.SQRT2);
}

/**
 * Upper tail of the chi-square distribution, P(X > x).
 * Even df has a closed form; odd df adds the normal-tail term. The call-bias
 * test uses df = 4, but both branches are here so the function is honest.
 */
export function chi2Sf(x, df) {
  if (x <= 0) return 1;
  const h = x / 2;
  if (df % 2 === 0) {
    // P(X > x) = exp(-x/2) * sum_{i=0}^{df/2-1} (x/2)^i / i!
    let term = 1, sum = 1;
    for (let i = 1; i < df / 2; i++) { term *= h / i; sum += term; }
    return Math.min(1, Math.exp(-h) * sum);
  }
  // odd df: start from the normal tail and add the series
  let sum = erfc(Math.sqrt(h));
  let term = Math.sqrt(2 * x / Math.PI) * Math.exp(-h);
  for (let i = 3; i <= df; i += 2) { sum += term; term *= x / i; }
  return Math.min(1, Math.max(0, sum));
}

/**
 * Standard one-proportion z-score: z = (hits - np) / sqrt(np(1-p)).
 * Uncorrected, as is conventional in the parapsychology literature.
 */
export function zScore(hits, trials, p) {
  if (trials <= 0) return 0;
  const mean = trials * p;
  const sd = Math.sqrt(trials * p * (1 - p));
  if (sd === 0) return 0;
  return (hits - mean) / sd;
}

/** Wilson score interval for the true hit rate. Honest at small n. */
export function wilsonInterval(hits, trials, z = 1.959963985) {
  if (trials <= 0) return { lo: 0, hi: 1 };
  const phat = hits / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = phat + z2 / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * trials)) / trials);
  return {
    lo: Math.max(0, (centre - margin) / denom),
    hi: Math.min(1, (centre + margin) / denom),
  };
}

/**
 * Effect size for psi work: hits above chance per trial, in SD units.
 * This is the number that actually matters, and it is almost always ~0.
 */
export function effectSize(hits, trials, p) {
  if (trials <= 0) return 0;
  return (hits / trials - p) / Math.sqrt(p * (1 - p));
}

/**
 * The full honest readout for a run of trials.
 * `direction` picks which tail the p-value describes.
 */
export function summarize(hits, trials, p) {
  const z = zScore(hits, trials, p);
  const expected = trials * p;
  const pHi = binomTailGE(hits, trials, p);
  const pLo = binomTailLE(hits, trials, p);
  return {
    hits,
    trials,
    chance: p,
    expected,
    rate: trials > 0 ? hits / trials : 0,
    z,
    // exact one-tailed p in the observed direction
    pExact: hits >= expected ? pHi : pLo,
    pHigh: pHi,
    pLow: pLo,
    // two-tailed via the doubling convention, capped at 1
    pTwoTailed: Math.min(1, 2 * Math.min(pHi, pLo)),
    pNormal: normalSf(Math.abs(z)),
    ci: wilsonInterval(hits, trials),
    effect: effectSize(hits, trials, p),
    direction: hits > expected ? 'hitting' : hits < expected ? 'missing' : 'exact',
  };
}

/**
 * Plain-language verdict. Deliberately conservative: we never tell a player
 * they have psi. Thresholds follow ordinary significance conventions.
 */
export function verdict(s) {
  if (s.trials < 25) return { label: 'Insufficient data', tone: 'neutral' };
  const p = s.pTwoTailed;
  if (p > 0.05) return { label: 'Consistent with chance', tone: 'neutral' };
  if (p > 0.01) return { label: 'Suggestive (p < .05)', tone: 'weak' };
  if (p > 0.001) return { label: 'Significant (p < .01)', tone: 'strong' };
  return { label: 'Highly significant (p < .001)', tone: 'strong' };
}
