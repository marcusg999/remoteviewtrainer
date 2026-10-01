/** Easing curves. The back/elastic ones are what make a card feel physical. */
export const linear = (t) => t;
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
export const easeInQuad = (t) => t * t;
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOutQuart = (t) => 1 - (1 - t) ** 4;
export const easeOutQuint = (t) => 1 - (1 - t) ** 5;
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const easeInOutExpo = (t) =>
  t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;

/** Overshoot. s=1.70158 is the classic ~10% overshoot. */
export function easeOutBack(t, s = 1.70158) {
  return 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
}
export function easeInOutBack(t, s = 1.70158 * 1.525) {
  return t < 0.5
    ? ((2 * t) ** 2 * ((s + 1) * 2 * t - s)) / 2
    : ((2 * t - 2) ** 2 * ((s + 1) * (2 * t - 2) + s) + 2) / 2;
}

/** Springy settle — the "lands with weight" curve. */
export function easeOutElastic(t, amp = 1, period = 0.3) {
  if (t === 0 || t === 1) return t;
  const s = (period / (2 * Math.PI)) * Math.asin(1 / Math.max(amp, 1));
  return amp * 2 ** (-10 * t) * Math.sin(((t - s) * (2 * Math.PI)) / period) + 1;
}

/** Decaying bounce, for things that hit a surface. */
export function easeOutBounce(t) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const inverseLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(inverseLerp(a, b, v)));

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
