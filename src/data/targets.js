/**
 * The remote-viewing target pool.
 *
 * Every target is a small procedural drawing — no external images, nothing to
 * load, and the art stays crisp from a 120px ranking thumbnail up to a
 * full-width reveal on a 3x-DPR phone.
 *
 * DESIGN RULES, because the ranking task depends on them:
 *
 *  1. Targets must be VISUALLY DISTINCT from one another. If two members of the
 *     pool read alike at thumbnail size, a viewer who perceived the target
 *     correctly could still rank a decoy first, which would depress the hit
 *     rate below the 20% the statistics assume. Each entry below owns a
 *     different silhouette AND a different dominant palette.
 *  2. Every render() is DETERMINISTIC. Any jitter comes from a seeded LCG, not
 *     Math.random, so a target looks identical in the ranking grid and in the
 *     reveal. A target that redrew itself differently on each paint would be a
 *     cue in its own right ("the one that keeps changing is the real one").
 *  3. render(ctx, w, h) must fill the whole box opaquely and must not depend on
 *     canvas state set by the caller.
 *
 * Target *selection* lives here too, in chooseTargetSet(), so the one function
 * the protocol's fairness rests on sits next to the pool it draws from and can
 * be tested without pulling in any UI.
 */
import { randomInt, sample, shuffle } from '../core/rng.js';

/* ------------------------------------------------------------------ *
 * Drawing helpers. Coordinates are FRACTIONS of w/h (0..1) so a target
 * renders the same composition at any size. Line widths are fractions of
 * the mean of w and h.
 * ------------------------------------------------------------------ */

const S = (w, h) => (w + h) / 2;

function lg(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) g.addColorStop(t, c);
  return g;
}
/** Full-bleed vertical wash. Always the first call in a render. */
function wash(ctx, w, h, a, b, c) {
  ctx.fillStyle = c
    ? lg(ctx, 0, 0, 0, h, [[0, a], [0.55, b], [1, c]])
    : lg(ctx, 0, 0, 0, h, [[0, a], [1, b]]);
  ctx.fillRect(0, 0, w, h);
}
function box(ctx, w, h, x, y, bw, bh, c) {
  ctx.fillStyle = c;
  ctx.fillRect(x * w, y * h, bw * w, bh * h);
}
function ply(ctx, w, h, pts, c) {
  ctx.fillStyle = c;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i) ctx.lineTo(p[0] * w, p[1] * h); else ctx.moveTo(p[0] * w, p[1] * h);
  }
  ctx.closePath();
  ctx.fill();
}
function pline(ctx, w, h, pts, c, lw, closed) {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(0.8, lw * S(w, h));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i) ctx.lineTo(p[0] * w, p[1] * h); else ctx.moveTo(p[0] * w, p[1] * h);
  }
  if (closed) ctx.closePath();
  ctx.stroke();
}
/** Smooth curve through points (midpoint quadratics). fillTo fills down to y. */
function curve(ctx, w, h, pts, c, lw, fillTo) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0] * w, pts[i][1] * h, mx * w, my * h);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0] * w, last[1] * h);
  if (fillTo != null) {
    ctx.lineTo(last[0] * w, fillTo * h);
    ctx.lineTo(pts[0][0] * w, fillTo * h);
    ctx.closePath();
    ctx.fillStyle = c;
    ctx.fill();
  } else {
    ctx.strokeStyle = c;
    ctx.lineWidth = Math.max(0.8, lw * S(w, h));
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}
function cir(ctx, w, h, x, y, r, c) {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.arc(x * w, y * h, r * S(w, h), 0, Math.PI * 2);
  ctx.fill();
}
function elp(ctx, w, h, x, y, rx, ry, c, a0, a1) {
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.ellipse(x * w, y * h, rx * w, ry * h, 0, a0 ?? 0, a1 ?? Math.PI * 2);
  ctx.closePath();
  ctx.fill();
}
function elps(ctx, w, h, x, y, rx, ry, c, lw, a0, a1) {
  ctx.strokeStyle = c;
  ctx.lineWidth = Math.max(0.8, lw * S(w, h));
  ctx.beginPath();
  ctx.ellipse(x * w, y * h, rx * w, ry * h, 0, a0 ?? 0, a1 ?? Math.PI * 2);
  ctx.stroke();
}
/** Deterministic pseudo-random. Cosmetic only — never used for a scored draw. */
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function speckle(ctx, w, h, n, c, x0, x1, y0, y1, sz, rnd) {
  ctx.fillStyle = c;
  for (let i = 0; i < n; i++) {
    const x = (x0 + (x1 - x0) * rnd()) * w;
    const y = (y0 + (y1 - y0) * rnd()) * h;
    const r = sz * S(w, h) * (0.5 + rnd());
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}
/** Flat water with horizontal glints. */
function water(ctx, w, h, y0, y1, a, b, glints, rnd) {
  ctx.fillStyle = lg(ctx, 0, y0 * h, 0, y1 * h, [[0, a], [1, b]]);
  ctx.fillRect(0, y0 * h, w, (y1 - y0) * h);
  if (!glints) return;
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  for (let i = 0; i < glints; i++) {
    const y = (y0 + (y1 - y0) * ((i + 0.5) / glints)) * h;
    const cx = (0.15 + 0.7 * rnd()) * w;
    const len = (0.08 + 0.26 * rnd()) * w;
    ctx.lineWidth = Math.max(0.8, 0.006 * S(w, h));
    ctx.beginPath(); ctx.moveTo(cx - len / 2, y); ctx.lineTo(cx + len / 2, y); ctx.stroke();
  }
}
/** Conifer silhouette. */
function pine(ctx, w, h, x, baseY, ph, pw, c) {
  ply(ctx, w, h, [[x, baseY - ph], [x + pw, baseY], [x - pw, baseY]], c);
  ply(ctx, w, h, [[x, baseY - ph], [x + pw * 0.72, baseY - ph * 0.34], [x - pw * 0.72, baseY - ph * 0.34]], c);
}
/** Flattened cloud bank. Round speckles in a sky read as bubbles, not cloud. */
function clouds(ctx, w, h, rnd, y0, y1, n, alpha) {
  for (let i = 0; i < (n || 3); i++) {
    const x = 0.08 + rnd() * 0.84;
    const y = y0 + (y1 - y0) * rnd();
    const rx = 0.09 + rnd() * 0.10;
    ctx.fillStyle = `rgba(255,255,255,${(alpha ?? 0.72).toFixed(2)})`;
    ctx.beginPath();
    ctx.ellipse(x * w, y * h, rx * w, rx * w * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse((x - rx * 0.3) * w, (y - 0.012) * h, rx * 0.5 * w, rx * w * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function starfield(ctx, w, h, n, yMax, rnd) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * yMax * h, a = 0.35 + rnd() * 0.65;
    ctx.fillStyle = `rgba(255,248,224,${a.toFixed(2)})`;
    const r = (0.0035 + rnd() * 0.004) * S(w, h);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

/* ------------------------------------------------------------------ *
 * The pool. 48 targets.
 * ------------------------------------------------------------------ */

export const TARGETS = [
  {
    id: 'waterfall', name: 'Waterfall',
    tags: ['water', 'falling', 'loud', 'cold', 'vertical', 'mist', 'green', 'wet'],
    describe: 'A high waterfall thundering between dark wet cliffs into a churning pool. Loud, cold, drenched in spray.',
    render(ctx, w, h) {
      const r = lcg(11);
      wash(ctx, w, h, '#b9cfd6', '#8fb0ad');
      ply(ctx, w, h, [[0, 0.02], [0.33, 0.06], [0.37, 1], [0, 1]], '#23402f');
      ply(ctx, w, h, [[1, 0.0], [0.66, 0.05], [0.63, 1], [1, 1]], '#1a3326');
      box(ctx, w, h, 0.37, 0.05, 0.26, 0.74, '#f2f7f7');
      ctx.strokeStyle = 'rgba(150,185,195,0.75)';
      for (let i = 0; i < 7; i++) {
        const x = (0.39 + i * 0.035) * w;
        ctx.lineWidth = Math.max(0.8, 0.005 * S(w, h));
        ctx.beginPath(); ctx.moveTo(x, 0.07 * h); ctx.lineTo(x + (r() - 0.5) * 0.02 * w, 0.76 * h); ctx.stroke();
      }
      elp(ctx, w, h, 0.5, 0.84, 0.30, 0.10, '#e9f2f3');
      water(ctx, w, h, 0.86, 1, '#9fc0bd', '#6d9290', 3, r);
      speckle(ctx, w, h, 22, 'rgba(255,255,255,0.55)', 0.3, 0.72, 0.72, 0.9, 0.013, r);
    },
  },
  {
    id: 'stone-bridge', name: 'Stone Arch Bridge',
    tags: ['stone', 'arch', 'span', 'river', 'man-made', 'crossing', 'grey', 'old'],
    describe: 'An old single-arch stone bridge crossing a slow green river between wooded banks.',
    render(ctx, w, h) {
      const r = lcg(22);
      wash(ctx, w, h, '#cfe0ea', '#a9c7cf');
      water(ctx, w, h, 0.62, 1, '#4e7d6c', '#2f5447', 4, r);
      ply(ctx, w, h, [[0, 0.58], [0.3, 0.6], [0, 0.72]], '#2d4a2c');
      ply(ctx, w, h, [[1, 0.58], [0.7, 0.6], [1, 0.72]], '#2d4a2c');
      box(ctx, w, h, 0.05, 0.38, 0.9, 0.3, '#9a9287');
      ctx.fillStyle = lg(ctx, 0, 0.38 * h, 0, 0.68 * h, [[0, '#cfe0ea'], [0.42, '#8fb2bb'], [1, '#2f5447']]);
      ctx.beginPath();
      ctx.ellipse(0.5 * w, 0.68 * h, 0.27 * w, 0.26 * h, 0, Math.PI, Math.PI * 2);
      ctx.closePath(); ctx.fill();
      box(ctx, w, h, 0.03, 0.34, 0.94, 0.05, '#b5ad9f');
      for (let i = 0; i < 9; i++) box(ctx, w, h, 0.06 + i * 0.1, 0.30, 0.035, 0.05, '#b5ad9f');
      ctx.strokeStyle = 'rgba(60,54,46,0.3)';
      ctx.lineWidth = Math.max(0.8, 0.004 * S(w, h));
      ctx.beginPath();
      ctx.ellipse(0.5 * w, 0.68 * h, 0.31 * w, 0.30 * h, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
    },
  },
  {
    id: 'pyramid', name: 'Great Pyramid',
    tags: ['stone', 'triangle', 'desert', 'hot', 'dry', 'massive', 'ancient', 'sand'],
    describe: 'A colossal stone pyramid on open desert sand under a white hammering sun. Dry, hot, geometric.',
    render(ctx, w, h) {
      const r = lcg(33);
      wash(ctx, w, h, '#f0c27a', '#f7dfae');
      cir(ctx, w, h, 0.80, 0.18, 0.055, '#fff5d6');
      box(ctx, w, h, 0, 0.70, 1, 0.3, '#deb173');
      ply(ctx, w, h, [[0.5, 0.18], [0.90, 0.72], [0.5, 0.72]], '#c89350');
      ply(ctx, w, h, [[0.5, 0.18], [0.10, 0.72], [0.5, 0.72]], '#f2d49a');
      pline(ctx, w, h, [[0.5, 0.18], [0.5, 0.72]], 'rgba(120,84,40,0.35)', 0.004);
      ply(ctx, w, h, [[0.26, 0.60], [0.40, 0.72], [0.26, 0.72]], '#d9ae6e');
      ply(ctx, w, h, [[0.26, 0.60], [0.12, 0.72], [0.26, 0.72]], '#f6dfae');
      speckle(ctx, w, h, 20, 'rgba(160,112,58,0.3)', 0, 1, 0.76, 1, 0.008, r);
    },
  },
  {
    id: 'lighthouse', name: 'Lighthouse',
    tags: ['tower', 'light', 'beam', 'night', 'sea', 'rock', 'red', 'rotating'],
    describe: 'A banded lighthouse on black rocks at night, its beam sweeping out across a dark sea.',
    render(ctx, w, h) {
      const r = lcg(44);
      wash(ctx, w, h, '#0b1430', '#16284a');
      starfield(ctx, w, h, 40, 0.55, r);
      water(ctx, w, h, 0.72, 1, '#13263f', '#0a1626', 4, r);
      ply(ctx, w, h, [[0.44, 0.30], [1.05, 0.10], [1.05, 0.46]], 'rgba(255,224,140,0.22)');
      ply(ctx, w, h, [[0.52, 0.72], [0.40, 0.72], [0.44, 0.24], [0.49, 0.24]], '#f3ecdd');
      box(ctx, w, h, 0.408, 0.37, 0.078, 0.07, '#d64b3c');
      box(ctx, w, h, 0.418, 0.53, 0.070, 0.07, '#d64b3c');
      box(ctx, w, h, 0.426, 0.66, 0.064, 0.06, '#d64b3c');
      box(ctx, w, h, 0.41, 0.26, 0.085, 0.05, '#2b3448');
      cir(ctx, w, h, 0.452, 0.235, 0.028, '#ffe79a');
      ply(ctx, w, h, [[0.40, 0.24], [0.50, 0.24], [0.452, 0.17]], '#2b3448');
      ply(ctx, w, h, [[0.2, 0.78], [0.38, 0.68], [0.6, 0.70], [0.76, 0.80], [0.76, 0.85], [0.2, 0.85]], '#0e141f');
    },
  },
  {
    id: 'canyon', name: 'Red Canyon',
    tags: ['rock', 'layered', 'deep', 'dry', 'orange', 'narrow', 'echo', 'vast'],
    describe: 'A deep red sandstone canyon with banded walls dropping to a thin green river far below.',
    render(ctx, w, h) {
      const r = lcg(55);
      wash(ctx, w, h, '#a8d2e8', '#dfe9e4');
      box(ctx, w, h, 0, 0.26, 1, 0.74, '#7a3b24');
      ply(ctx, w, h, [[0, 0.18], [0.40, 0.30], [0.44, 1], [0, 1]], '#c2643a');
      ply(ctx, w, h, [[1, 0.14], [0.60, 0.28], [0.56, 1], [1, 1]], '#9e4b2c');
      const bands = ['#d97a48', '#b85c33', '#e39157', '#a9512d', '#cf6f40'];
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = bands[i];
        ctx.globalAlpha = 0.6;
        ctx.fillRect(0, (0.34 + i * 0.12) * h, 0.43 * w, 0.045 * h);
        ctx.fillRect(0.57 * w, (0.32 + i * 0.12) * h, 0.43 * w, 0.045 * h);
        ctx.globalAlpha = 1;
      }
      ply(ctx, w, h, [[0.41, 0.68], [0.59, 0.68], [0.68, 1], [0.32, 1]], '#6b3f28');
      curve(ctx, w, h, [[0.50, 0.68], [0.44, 0.78], [0.56, 0.88], [0.47, 1]], '#3f8fa0', 0.055);
      curve(ctx, w, h, [[0.50, 0.68], [0.44, 0.78], [0.56, 0.88], [0.47, 1]], 'rgba(214,246,250,0.45)', 0.012);
      speckle(ctx, w, h, 14, 'rgba(60,24,12,0.35)', 0.02, 0.4, 0.4, 0.95, 0.01, r);
    },
  },
  {
    id: 'skyline', name: 'City Skyline at Night',
    tags: ['city', 'man-made', 'lights', 'tall', 'grid', 'busy', 'glass', 'night'],
    describe: 'A dense city skyline at night: tall rectangular towers, thousands of lit windows, a hard horizon of glass.',
    render(ctx, w, h) {
      const r = lcg(66);
      wash(ctx, w, h, '#0e1030', '#3b2a4d', '#6b3f55');
      cir(ctx, w, h, 0.17, 0.16, 0.05, '#fdf3c7');
      const towers = [
        [0.00, 0.52, 0.11], [0.11, 0.40, 0.09], [0.20, 0.60, 0.08], [0.28, 0.30, 0.10],
        [0.38, 0.50, 0.07], [0.45, 0.22, 0.09], [0.54, 0.46, 0.11], [0.65, 0.34, 0.08],
        [0.73, 0.56, 0.09], [0.82, 0.42, 0.10], [0.92, 0.58, 0.08],
      ];
      for (const [x, y, bw] of towers) {
        box(ctx, w, h, x, y, bw - 0.008, 1 - y, '#13152c');
        for (let gy = y + 0.04; gy < 0.96; gy += 0.055) {
          for (let gx = x + 0.015; gx < x + bw - 0.022; gx += 0.025) {
            if (r() < 0.55) box(ctx, w, h, gx, gy, 0.012, 0.022, r() < 0.3 ? '#ffd98a' : '#f6c868');
          }
        }
      }
      box(ctx, w, h, 0, 0.96, 1, 0.04, '#070815');
    },
  },
  {
    id: 'forest', name: 'Deep Forest',
    tags: ['trees', 'green', 'vertical', 'shade', 'damp', 'quiet', 'bark', 'enclosed'],
    describe: 'Inside a dense forest: tall straight trunks, a high green canopy, soft damp ground, filtered light.',
    render(ctx, w, h) {
      const r = lcg(77);
      wash(ctx, w, h, '#3c6a33', '#20421f');
      box(ctx, w, h, 0, 0, 1, 0.3, '#59893c');
      speckle(ctx, w, h, 60, 'rgba(126,178,74,0.75)', 0, 1, 0, 0.34, 0.03, r);
      for (let i = 0; i < 9; i++) {
        const x = 0.04 + i * 0.115 + (r() - 0.5) * 0.03;
        const tw = 0.018 + r() * 0.02;
        ply(ctx, w, h, [[x, 0.12], [x + tw, 0.12], [x + tw * 1.4, 1], [x - tw * 0.4, 1]], i % 2 ? '#3b2a1c' : '#4a3524');
      }
      ply(ctx, w, h, [[0.30, 0], [0.46, 0], [0.70, 1], [0.52, 1]], 'rgba(255,245,200,0.09)');
      box(ctx, w, h, 0, 0.90, 1, 0.1, '#2b3a1c');
    },
  },
  {
    id: 'harbour', name: 'Fishing Harbour',
    tags: ['boats', 'water', 'masts', 'salt', 'rope', 'man-made', 'busy', 'blue'],
    describe: 'A small fishing harbour: moored boats with bare masts, a stone quay, the smell of salt and diesel.',
    render(ctx, w, h) {
      const r = lcg(88);
      wash(ctx, w, h, '#bdd9e8', '#e6eef0');
      box(ctx, w, h, 0, 0.44, 1, 0.07, '#cbb79a');
      for (let i = 0; i < 6; i++) box(ctx, w, h, 0.03 + i * 0.17, 0.37, 0.10, 0.075, i % 2 ? '#8d6f5a' : '#a8886c');
      water(ctx, w, h, 0.51, 1, '#2f6f96', '#143c58', 5, r);
      const boats = [[0.18, 0.66, 0.15], [0.48, 0.76, 0.19], [0.78, 0.62, 0.13]];
      for (const [bx, by, bw] of boats) {
        ply(ctx, w, h, [[bx - bw, by], [bx + bw, by], [bx + bw * 0.7, by + 0.075], [bx - bw * 0.7, by + 0.075]], '#f2ece0');
        box(ctx, w, h, bx - bw, by - 0.018, bw * 2, 0.02, '#c2452f');
        pline(ctx, w, h, [[bx, by - 0.02], [bx, by - 0.34]], '#5d5345', 0.008);
        pline(ctx, w, h, [[bx - 0.05, by - 0.08], [bx, by - 0.14], [bx + 0.05, by - 0.08]], '#5d5345', 0.005);
      }
      pline(ctx, w, h, [[0, 0.51], [1, 0.51]], 'rgba(255,255,255,0.4)', 0.004);
    },
  },
  {
    id: 'volcano', name: 'Erupting Volcano',
    tags: ['fire', 'heat', 'black', 'red', 'ash', 'cone', 'violent', 'smoke'],
    describe: 'A black volcanic cone erupting: orange lava fountaining from the crater, glowing rivers, an ash column.',
    render(ctx, w, h) {
      const r = lcg(99);
      wash(ctx, w, h, '#2a0f16', '#6c2218', '#b8442a');
      ctx.fillStyle = 'rgba(70,62,66,0.85)';
      ctx.beginPath();
      ctx.moveTo(0.46 * w, 0.30 * h);
      ctx.bezierCurveTo(0.30 * w, 0.18 * h, 0.66 * w, 0.10 * h, 0.52 * w, -0.04 * h);
      ctx.lineTo(0.80 * w, -0.04 * h);
      ctx.bezierCurveTo(0.74 * w, 0.12 * h, 0.78 * w, 0.22 * h, 0.62 * w, 0.30 * h);
      ctx.closePath(); ctx.fill();
      ply(ctx, w, h, [[0.52, 0.26], [0.95, 0.92], [0.05, 0.92]], '#231a1c');
      ply(ctx, w, h, [[0.52, 0.26], [0.95, 0.92], [0.58, 0.92]], '#15100f');
      ply(ctx, w, h, [[0.52, 0.22], [0.60, 0.30], [0.44, 0.30]], '#ffd05a');
      curve(ctx, w, h, [[0.50, 0.30], [0.46, 0.48], [0.49, 0.66], [0.42, 0.92]], '#ff6a2a', 0.022);
      curve(ctx, w, h, [[0.55, 0.30], [0.62, 0.50], [0.66, 0.72], [0.72, 0.92]], '#ffa83c', 0.014);
      box(ctx, w, h, 0, 0.92, 1, 0.08, '#120d0e');
      speckle(ctx, w, h, 16, 'rgba(255,170,70,0.8)', 0.35, 0.68, 0.05, 0.28, 0.009, r);
    },
  },
  {
    id: 'cathedral', name: 'Cathedral Interior',
    tags: ['stone', 'arches', 'tall', 'echo', 'cold', 'enclosed', 'coloured glass', 'sacred'],
    describe: 'Inside a gothic cathedral: a nave of pointed arches receding into gloom, a vast cold vertical space, a rose window of coloured glass.',
    render(ctx, w, h) {
      const r = lcg(111);
      wash(ctx, w, h, '#241f33', '#121020');
      const arch = (hw, base, top) => {
        const mid = top + (base - top) * 0.45;
        ctx.beginPath();
        ctx.moveTo((0.5 - hw) * w, base * h);
        ctx.lineTo((0.5 - hw) * w, mid * h);
        ctx.quadraticCurveTo((0.5 - hw * 0.72) * w, (top + (base - top) * 0.10) * h, 0.5 * w, top * h);
        ctx.quadraticCurveTo((0.5 + hw * 0.72) * w, (top + (base - top) * 0.10) * h, (0.5 + hw) * w, mid * h);
        ctx.lineTo((0.5 + hw) * w, base * h);
        ctx.closePath();
      };
      // the nave, bay by bay, each one further away and darker
      const shades = ['#5d5675', '#4e4864', '#413c55', '#363247', '#2c293c', '#232133'];
      for (let i = 0; i < 6; i++) {
        const t = i / 6;
        ctx.fillStyle = shades[i];
        arch(0.455 - t * 0.30, 1.0, 0.045 + t * 0.21);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(214,202,236,0.22)';
      ctx.lineWidth = Math.max(0.8, 0.005 * S(w, h));
      for (let i = 0; i < 6; i++) {
        const t = i / 6;
        arch(0.455 - t * 0.30, 1.0, 0.045 + t * 0.21);
        ctx.stroke();
      }
      // the rose window closing the far end
      const cols = ['#d84a4a', '#3f7fd4', '#e8c23d', '#4fb46b', '#9a5fd0', '#e2873a'];
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = cols[i % 6];
        ctx.beginPath();
        ctx.moveTo(0.5 * w, 0.44 * h);
        ctx.ellipse(0.5 * w, 0.44 * h, 0.085 * w, 0.085 * w, 0, (i / 12) * Math.PI * 2, ((i + 1) / 12) * Math.PI * 2);
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = '#1b1828';
      ctx.lineWidth = Math.max(1, 0.007 * S(w, h));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(0.5 * w, 0.44 * h);
        ctx.lineTo((0.5 + Math.cos(a) * 0.085) * w, (0.44 + Math.sin(a) * 0.085 * (w / h)) * h);
        ctx.stroke();
      }
      elps(ctx, w, h, 0.5, 0.44, 0.085, 0.085 * (w / h), '#1b1828', 0.010);
      cir(ctx, w, h, 0.5, 0.44, 0.022, '#fff3cd');
      // light falling on the flagstones
      ply(ctx, w, h, [[0.40, 0.62], [0.60, 0.62], [0.80, 1], [0.20, 1]], 'rgba(255,238,196,0.10)');
      pline(ctx, w, h, [[0.20, 1], [0.44, 0.62]], 'rgba(255,238,196,0.12)', 0.006);
      for (const x of [0.17, 0.83]) {
        cir(ctx, w, h, x, 0.86, 0.013, '#ffd98a');
        cir(ctx, w, h, x, 0.86, 0.030, 'rgba(255,200,110,0.14)');
      }
      speckle(ctx, w, h, 10, 'rgba(255,240,205,0.10)', 0.3, 0.7, 0.5, 0.9, 0.02, r);
    },
  },
  {
    id: 'dune', name: 'Desert Dunes',
    tags: ['sand', 'curves', 'hot', 'dry', 'empty', 'wind', 'gold', 'smooth'],
    describe: 'Rolling wind-carved sand dunes, nothing man-made, nothing but smooth gold curves and heat.',
    render(ctx, w, h) {
      const r = lcg(121);
      wash(ctx, w, h, '#8fc0de', '#d6e4ea');
      curve(ctx, w, h, [[0, 0.46], [0.3, 0.38], [0.6, 0.47], [1, 0.40]], '#e0ae63', 0, 1);
      curve(ctx, w, h, [[0, 0.62], [0.25, 0.52], [0.55, 0.64], [1, 0.56]], '#f0cb8c', 0, 1);
      curve(ctx, w, h, [[0, 0.80], [0.35, 0.68], [0.7, 0.84], [1, 0.74]], '#c99253', 0, 1);
      curve(ctx, w, h, [[0, 0.95], [0.4, 0.86], [0.75, 0.98], [1, 0.90]], '#e8bb79', 0, 1);
      curve(ctx, w, h, [[0, 0.62], [0.25, 0.52], [0.55, 0.64], [1, 0.56]], 'rgba(255,248,224,0.6)', 0.006);
      curve(ctx, w, h, [[0, 0.80], [0.35, 0.68], [0.7, 0.84], [1, 0.74]], 'rgba(120,78,34,0.25)', 0.006);
      speckle(ctx, w, h, 10, 'rgba(255,255,255,0.18)', 0, 1, 0.6, 1, 0.01, r);
    },
  },
  {
    id: 'glacier', name: 'Glacier',
    tags: ['ice', 'blue', 'cold', 'cracked', 'massive', 'grinding', 'white', 'silent'],
    describe: 'A glacier tongue of fractured blue-white ice, deep crevasses, grey moraine rubble, bitter cold.',
    render(ctx, w, h) {
      const r = lcg(131);
      wash(ctx, w, h, '#9fa8b4', '#cdd6dd');
      ply(ctx, w, h, [[0, 0.40], [0.22, 0.24], [0.42, 0.36], [0, 0.52]], '#6f7886');
      ply(ctx, w, h, [[1, 0.38], [0.78, 0.22], [0.56, 0.36], [1, 0.52]], '#5f6876');
      ply(ctx, w, h, [[0.1, 1], [0.0, 0.62], [0.3, 0.36], [0.7, 0.36], [1, 0.62], [0.9, 1]], '#dff0f7');
      const seracs = [[0.18, 0.62], [0.36, 0.52], [0.54, 0.58], [0.72, 0.50], [0.46, 0.76], [0.26, 0.86], [0.66, 0.82]];
      for (const [x, y] of seracs) {
        ply(ctx, w, h, [[x - 0.09, y + 0.09], [x - 0.05, y - 0.05], [x + 0.07, y - 0.03], [x + 0.10, y + 0.11]], '#b9dcec');
        ply(ctx, w, h, [[x - 0.05, y - 0.05], [x + 0.07, y - 0.03], [x + 0.04, y + 0.02], [x - 0.04, y + 0.01]], '#f4fbff');
      }
      for (let i = 0; i < 5; i++) {
        pline(ctx, w, h, [[0.08 + i * 0.2, 0.40], [0.14 + i * 0.2, 0.68], [0.06 + i * 0.2, 1]], '#3f8db5', 0.012);
      }
      speckle(ctx, w, h, 24, 'rgba(90,86,84,0.6)', 0.0, 1, 0.9, 1, 0.01, r);
    },
  },
  {
    id: 'windmill', name: 'Windmill',
    tags: ['man-made', 'rotating', 'wind', 'wood', 'hill', 'white', 'blades', 'open'],
    describe: 'A white stone windmill on a green rise, four lattice sails turning in a steady wind.',
    render(ctx, w, h) {
      const r = lcg(141);
      wash(ctx, w, h, '#86b9e0', '#cfe4f0');
      elp(ctx, w, h, 0.22, 0.20, 0.13, 0.055, 'rgba(255,255,255,0.8)');
      elp(ctx, w, h, 0.74, 0.14, 0.10, 0.045, 'rgba(255,255,255,0.7)');
      curve(ctx, w, h, [[0, 0.74], [0.3, 0.64], [0.6, 0.70], [1, 0.62]], '#5e9242', 0, 1);
      ply(ctx, w, h, [[0.40, 0.64], [0.60, 0.64], [0.565, 0.30], [0.435, 0.30]], '#f1ead9');
      ply(ctx, w, h, [[0.42, 0.31], [0.58, 0.31], [0.50, 0.19]], '#6b4330');
      box(ctx, w, h, 0.462, 0.46, 0.076, 0.055, '#6b4330');
      const cx = 0.50, cy = 0.27;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        const ex = cx + Math.cos(a) * 0.26, ey = cy + Math.sin(a) * 0.26 * (w / h);
        pline(ctx, w, h, [[cx, cy], [ex, ey]], '#4e3524', 0.016);
        pline(ctx, w, h, [[cx + Math.cos(a) * 0.09, cy + Math.sin(a) * 0.09 * (w / h)], [ex, ey]], 'rgba(250,246,232,0.85)', 0.034);
      }
      cir(ctx, w, h, cx, cy, 0.022, '#2f2018');
      speckle(ctx, w, h, 18, 'rgba(255,240,150,0.5)', 0, 1, 0.72, 1, 0.008, r);
    },
  },
  {
    id: 'suspension-bridge', name: 'Suspension Bridge',
    tags: ['steel', 'cables', 'red', 'span', 'tall towers', 'man-made', 'wind', 'huge'],
    describe: 'A vast red suspension bridge: two tall towers, sweeping main cables, vertical hangers, deck high over water.',
    render(ctx, w, h) {
      const r = lcg(151);
      wash(ctx, w, h, '#f3a85f', '#f6d6a6', '#9fb6c0');
      cir(ctx, w, h, 0.14, 0.24, 0.06, '#fff0c0');
      water(ctx, w, h, 0.78, 1, '#53718a', '#2b3f54', 4, r);
      for (const tx of [0.26, 0.74]) {
        box(ctx, w, h, tx - 0.022, 0.12, 0.044, 0.74, '#c1392b');
        box(ctx, w, h, tx - 0.05, 0.22, 0.10, 0.028, '#c1392b');
        box(ctx, w, h, tx - 0.05, 0.40, 0.10, 0.028, '#c1392b');
      }
      box(ctx, w, h, 0, 0.64, 1, 0.035, '#a9301f');
      ctx.strokeStyle = '#8e2a1c';
      ctx.lineWidth = Math.max(1.2, 0.012 * S(w, h));
      ctx.beginPath();
      ctx.moveTo(0, 0.30 * h);
      ctx.quadraticCurveTo(0.26 * w, 0.18 * h, 0.26 * w, 0.14 * h);
      ctx.moveTo(0.26 * w, 0.14 * h);
      ctx.quadraticCurveTo(0.5 * w, 0.62 * h, 0.74 * w, 0.14 * h);
      ctx.moveTo(0.74 * w, 0.14 * h);
      ctx.quadraticCurveTo(0.74 * w, 0.18 * h, 1 * w, 0.30 * h);
      ctx.stroke();
      for (let i = 1; i < 12; i++) {
        const t = i / 12, x = 0.26 + t * 0.48;
        const y = 0.14 * (1 - t) * (1 - t) + 2 * 0.62 * t * (1 - t) + 0.14 * t * t;
        pline(ctx, w, h, [[x, y], [x, 0.645]], 'rgba(142,42,28,0.8)', 0.005);
      }
      box(ctx, w, h, 0, 0.86, 1, 0.14, '#2b3f54');
    },
  },
  {
    id: 'coral-reef', name: 'Coral Reef',
    tags: ['underwater', 'colour', 'branching', 'fish', 'warm water', 'teeming', 'pink', 'soft'],
    describe: 'A coral reef underwater: branching pink and orange coral, darting fish, shafts of light through blue water.',
    render(ctx, w, h) {
      const r = lcg(161);
      wash(ctx, w, h, '#1b7fb0', '#0b4a74');
      for (let i = 0; i < 4; i++) {
        ply(ctx, w, h, [[0.1 + i * 0.22, 0], [0.2 + i * 0.22, 0], [0.34 + i * 0.22, 1], [0.18 + i * 0.22, 1]], 'rgba(170,230,255,0.10)');
      }
      box(ctx, w, h, 0, 0.84, 1, 0.16, '#d8cba4');
      const corals = [
        [0.14, 0.86, '#f06292'], [0.32, 0.88, '#ffb74d'], [0.50, 0.85, '#ba68c8'],
        [0.68, 0.89, '#f4645a'], [0.86, 0.86, '#ffd166'],
      ];
      for (const [x, y, c] of corals) {
        for (let b = 0; b < 5; b++) {
          const a = -Math.PI / 2 + (b - 2) * 0.42;
          const len = 0.14 + r() * 0.12;
          pline(ctx, w, h, [[x, y], [x + Math.cos(a) * len * 0.5, y + Math.sin(a) * len],
            [x + Math.cos(a) * len * 0.9, y + Math.sin(a) * len * 1.6]], c, 0.018);
        }
      }
      elp(ctx, w, h, 0.42, 0.90, 0.12, 0.05, '#7ec8a0');
      const fish = [[0.24, 0.40], [0.56, 0.30], [0.70, 0.52], [0.40, 0.58], [0.84, 0.38]];
      for (const [x, y] of fish) {
        elp(ctx, w, h, x, y, 0.035, 0.022, '#ffe082');
        ply(ctx, w, h, [[x - 0.035, y], [x - 0.065, y - 0.025], [x - 0.065, y + 0.025]], '#ffb300');
      }
    },
  },
  {
    id: 'mountain-peak', name: 'Snow Peak',
    tags: ['mountain', 'snow', 'cold', 'jagged', 'high', 'grey', 'thin air', 'sharp'],
    describe: 'A jagged snow-covered mountain peak against thin cold sky — rock ridges, white summit, no vegetation.',
    render(ctx, w, h) {
      const r = lcg(171);
      wash(ctx, w, h, '#4d78a8', '#b9d2e4');
      clouds(ctx, w, h, r, 0.08, 0.22, 2, 0.30);
      ply(ctx, w, h, [[0, 1], [0.22, 0.52], [0.40, 0.72], [0.50, 1]], '#6b7d93');
      ply(ctx, w, h, [[0.22, 0.52], [0.30, 0.60], [0.22, 0.60], [0.16, 0.62]], '#eef6fb');
      ply(ctx, w, h, [[0.30, 1], [0.52, 0.18], [0.60, 0.34], [0.70, 0.22], [0.95, 1]], '#55637a');
      ply(ctx, w, h, [[0.52, 0.18], [0.63, 0.40], [0.52, 0.36], [0.44, 0.44]], '#f6fbff');
      ply(ctx, w, h, [[0.70, 0.22], [0.78, 0.44], [0.70, 0.38], [0.64, 0.42]], '#eaf4fb');
      ply(ctx, w, h, [[0.52, 0.18], [0.95, 1], [0.66, 1]], '#3f4b5e');
      for (let i = 0; i < 6; i++) {
        pline(ctx, w, h, [[0.4 + i * 0.07, 0.56 + i * 0.02], [0.46 + i * 0.07, 0.86 + i * 0.01]], 'rgba(240,250,255,0.5)', 0.008);
      }
      box(ctx, w, h, 0, 0.96, 1, 0.04, '#e9f2f8');
    },
  },
  {
    id: 'lake-island', name: 'Island in a Still Lake',
    tags: ['water', 'calm', 'mirror', 'quiet', 'small', 'tree', 'dusk', 'flat'],
    describe: 'A single small island with one tree in a glassy still lake at dusk, perfectly reflected.',
    render(ctx, w, h) {
      const r = lcg(181);
      wash(ctx, w, h, '#f6c9a0', '#f0dcc6');
      cir(ctx, w, h, 0.72, 0.26, 0.045, '#fff5d9');
      ply(ctx, w, h, [[0, 0.52], [0.18, 0.44], [0.42, 0.50], [0.68, 0.43], [1, 0.50], [1, 0.54], [0, 0.54]], '#9c8a9b');
      water(ctx, w, h, 0.54, 1, '#8fa4b8', '#5e7187', 0, r);
      elp(ctx, w, h, 0.42, 0.56, 0.14, 0.035, '#4d6b4a');
      pline(ctx, w, h, [[0.42, 0.55], [0.42, 0.40]], '#4a3627', 0.012);
      elp(ctx, w, h, 0.42, 0.355, 0.075, 0.07, '#3f6b3d');
      elp(ctx, w, h, 0.42, 0.62, 0.11, 0.025, 'rgba(50,80,52,0.5)');
      pline(ctx, w, h, [[0.42, 0.63], [0.42, 0.76]], 'rgba(74,54,39,0.45)', 0.012);
      elp(ctx, w, h, 0.42, 0.80, 0.065, 0.06, 'rgba(63,107,61,0.4)');
      for (let i = 0; i < 5; i++) {
        pline(ctx, w, h, [[0.1 + r() * 0.7, 0.66 + i * 0.07], [0.3 + r() * 0.6, 0.66 + i * 0.07]], 'rgba(255,255,255,0.28)', 0.005);
      }
    },
  },
  {
    id: 'cave', name: 'Cave Chamber',
    tags: ['underground', 'dark', 'dripping', 'enclosed', 'stalactites', 'echo', 'cold', 'wet'],
    describe: 'A limestone cave chamber: stalactites above, stalagmites below, black still water, dripping echoes.',
    render(ctx, w, h) {
      const r = lcg(191);
      wash(ctx, w, h, '#120f1a', '#1d1826');
      ply(ctx, w, h, [[0.30, 0], [0.52, 0], [0.74, 1], [0.44, 1]], 'rgba(220,235,255,0.09)');
      for (let i = 0; i < 11; i++) {
        const x = i * 0.095 + 0.02, len = 0.14 + r() * 0.26;
        ply(ctx, w, h, [[x - 0.045, 0], [x + 0.045, 0], [x, len]], '#5b4a52');
        ply(ctx, w, h, [[x - 0.02, 0], [x + 0.012, 0], [x, len * 0.8]], '#7b6771');
      }
      box(ctx, w, h, 0, 0, 1, 0.06, '#3c3038');
      for (let i = 0; i < 6; i++) {
        const x = 0.08 + i * 0.17, len = 0.10 + r() * 0.16;
        ply(ctx, w, h, [[x - 0.05, 0.80], [x + 0.05, 0.80], [x, 0.80 - len]], '#4a3d44');
      }
      water(ctx, w, h, 0.80, 1, '#15323a', '#081419', 3, r);
      elp(ctx, w, h, 0.56, 0.82, 0.16, 0.035, 'rgba(160,220,235,0.18)');
    },
  },
  {
    id: 'railway-station', name: 'Railway Station',
    tags: ['man-made', 'steel', 'tracks', 'converging', 'busy', 'glass roof', 'noise', 'bright'],
    describe: 'A great glass-roofed railway terminus: a steel barrel vault full of daylight, rails converging down the platform, a train waiting.',
    render(ctx, w, h) {
      const r = lcg(201);
      wash(ctx, w, h, '#e4ecf3', '#b8c3cf');
      // the vault, seen down its length
      elp(ctx, w, h, 0.5, 0.74, 0.47, 0.60, '#eef5fb', Math.PI, Math.PI * 2);
      // glazing bars radiating from the springing line
      ctx.strokeStyle = 'rgba(104,118,136,0.55)';
      ctx.lineWidth = Math.max(0.8, 0.004 * S(w, h));
      for (let i = 1; i < 12; i++) {
        const a = Math.PI + (i / 12) * Math.PI;
        ctx.beginPath();
        ctx.moveTo((0.5 + Math.cos(a) * 0.10) * w, (0.74 + Math.sin(a) * 0.13) * h);
        ctx.lineTo((0.5 + Math.cos(a) * 0.47) * w, (0.74 + Math.sin(a) * 0.60) * h);
        ctx.stroke();
      }
      // receding ribs: the depth cue
      for (let i = 0; i < 7; i++) {
        const t = i / 7, k = 1 - t * 0.80;
        elps(ctx, w, h, 0.5, 0.74, 0.47 * k, 0.60 * k,
          `rgba(72,86,104,${(0.85 - t * 0.55).toFixed(2)})`, 0.011 - t * 0.0055, Math.PI, Math.PI * 2);
      }
      elp(ctx, w, h, 0.5, 0.74, 0.085, 0.11, '#ffffff', Math.PI, Math.PI * 2);
      // platform floor and its edges
      box(ctx, w, h, 0, 0.74, 1, 0.26, '#aeb5bd');
      ply(ctx, w, h, [[0, 0.80], [0.42, 0.745], [0.42, 0.775], [0, 0.90]], '#cdd3da');
      ply(ctx, w, h, [[1, 0.80], [0.58, 0.745], [0.58, 0.775], [1, 0.90]], '#cdd3da');
      ply(ctx, w, h, [[0.42, 0.745], [0.58, 0.745], [0.78, 1], [0.22, 1]], '#6f7681');
      // rails
      for (const off of [-1, 1]) {
        pline(ctx, w, h, [[0.5 + off * 0.016, 0.75], [0.5 + off * 0.17, 1]], '#e6ebf0', 0.008);
      }
      for (let i = 0; i < 7; i++) {
        const t = i / 7, y = 0.76 + t * t * 0.24, sp = 0.03 + t * t * 0.23;
        pline(ctx, w, h, [[0.5 - sp, y], [0.5 + sp, y]], 'rgba(78,64,50,0.8)', 0.005 + t * 0.006);
      }
      // the train, waiting at the far platform
      box(ctx, w, h, 0.555, 0.56, 0.135, 0.19, '#1f6b4a');
      box(ctx, w, h, 0.57, 0.59, 0.105, 0.055, '#bfe4f2');
      box(ctx, w, h, 0.555, 0.70, 0.135, 0.028, '#e8c33f');
      cir(ctx, w, h, 0.575, 0.675, 0.011, '#fff2b0');
      cir(ctx, w, h, 0.668, 0.675, 0.011, '#fff2b0');
      // hanging lamps
      for (const x of [0.28, 0.72]) {
        pline(ctx, w, h, [[x, 0.20], [x, 0.30]], '#5d6775', 0.004);
        cir(ctx, w, h, x, 0.32, 0.022, '#fff0bc');
      }
      speckle(ctx, w, h, 8, 'rgba(40,48,60,0.45)', 0.1, 0.9, 0.84, 0.97, 0.012, r);
    },
  },
  {
    id: 'ferris-wheel', name: 'Ferris Wheel',
    tags: ['circle', 'rotating', 'lights', 'fairground', 'tall', 'man-made', 'spokes', 'festive'],
    describe: 'A lit ferris wheel at a fairground at night: a great spoked circle of coloured lights turning slowly.',
    render(ctx, w, h) {
      const r = lcg(211);
      wash(ctx, w, h, '#160f2c', '#3a1f44');
      starfield(ctx, w, h, 30, 0.6, r);
      const cx = 0.5, cy = 0.42, rad = 0.33;
      ply(ctx, w, h, [[cx - 0.02, cy], [cx + 0.02, cy], [cx + 0.17, 0.92], [cx + 0.11, 0.92]], '#4c4258');
      ply(ctx, w, h, [[cx - 0.02, cy], [cx + 0.02, cy], [cx - 0.11, 0.92], [cx - 0.17, 0.92]], '#4c4258');
      elps(ctx, w, h, cx, cy, rad, rad * (w / h), '#d9cfe4', 0.012);
      elps(ctx, w, h, cx, cy, rad * 0.86, rad * 0.86 * (w / h), 'rgba(217,207,228,0.5)', 0.006);
      const cols = ['#ffd166', '#f4645a', '#5ec3f0', '#9fe88a', '#c58cf0', '#ffa94d'];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const ex = cx + Math.cos(a) * rad, ey = cy + Math.sin(a) * rad * (w / h);
        pline(ctx, w, h, [[cx, cy], [ex, ey]], 'rgba(200,190,215,0.55)', 0.004);
        cir(ctx, w, h, ex, ey, 0.022, cols[i % 6]);
      }
      cir(ctx, w, h, cx, cy, 0.035, '#e8d9f2');
      box(ctx, w, h, 0, 0.90, 1, 0.10, '#1b1326');
      speckle(ctx, w, h, 14, 'rgba(255,220,140,0.7)', 0, 1, 0.9, 0.98, 0.008, r);
    },
  },
  {
    id: 'hot-spring', name: 'Terraced Hot Spring',
    tags: ['water', 'hot', 'steam', 'terraces', 'mineral', 'sulphur', 'turquoise', 'smell'],
    describe: 'Terraced mineral hot springs: stepped turquoise pools on white rock, steam rising, a sulphur smell.',
    render(ctx, w, h) {
      const r = lcg(221);
      wash(ctx, w, h, '#c8b89e', '#e7dcc6');
      for (let i = 0; i < 12; i++) {
        ctx.fillStyle = `rgba(255,255,255,${(0.05 + r() * 0.1).toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse((0.15 + r() * 0.7) * w, (0.08 + r() * 0.3) * h, 0.14 * w, 0.09 * h, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      box(ctx, w, h, 0, 0.42, 1, 0.58, '#efe6d2');
      const tiers = [[0.50, 0.52, 0.30, 0.070], [0.42, 0.66, 0.38, 0.085], [0.56, 0.82, 0.44, 0.095]];
      for (let i = 0; i < tiers.length; i++) {
        const [x, y, rx, ry] = tiers[i];
        elp(ctx, w, h, x, y + 0.02, rx * 1.1, ry * 1.1, '#dccfb3');
        elp(ctx, w, h, x, y, rx, ry, i === 1 ? '#2fb3b8' : '#49c8c4');
        elp(ctx, w, h, x, y - ry * 0.25, rx * 0.6, ry * 0.4, 'rgba(190,245,245,0.55)');
      }
      elp(ctx, w, h, 0.18, 0.46, 0.10, 0.035, '#7fd8d2');
      speckle(ctx, w, h, 12, 'rgba(255,255,255,0.35)', 0.2, 0.8, 0.30, 0.52, 0.016, r);
    },
  },
  {
    id: 'rice-terraces', name: 'Rice Terraces',
    tags: ['green', 'stepped', 'curves', 'wet', 'farmed', 'humid', 'layered', 'man-made'],
    describe: 'Flooded rice terraces stepping down a hillside in bright green curved bands, each rimmed with water.',
    render(ctx, w, h) {
      const r = lcg(231);
      wash(ctx, w, h, '#b7d2dd', '#dcebe6');
      ply(ctx, w, h, [[0, 0.30], [0.3, 0.18], [0.65, 0.26], [1, 0.16], [1, 0.34], [0, 0.40]], '#56705a');
      const greens = ['#6fae4a', '#8cc85c', '#5f9c42', '#a2d472', '#73b74e', '#8ec95e', '#619f44'];
      for (let i = 0; i < 7; i++) {
        const y = 0.34 + i * 0.095;
        curve(ctx, w, h, [[0, y + 0.03], [0.3, y - 0.03], [0.65, y + 0.04], [1, y - 0.02]], greens[i], 0, 1);
        curve(ctx, w, h, [[0, y + 0.03], [0.3, y - 0.03], [0.65, y + 0.04], [1, y - 0.02]], 'rgba(170,220,235,0.85)', 0.009);
      }
      speckle(ctx, w, h, 20, 'rgba(255,255,255,0.22)', 0, 1, 0.5, 1, 0.009, r);
    },
  },
  {
    id: 'obelisk', name: 'Obelisk on a Plaza',
    tags: ['stone', 'needle', 'tall', 'thin', 'plaza', 'carved', 'man-made', 'single'],
    describe: 'A tall thin granite obelisk standing alone on a wide paved plaza, carved, pointing straight up.',
    render(ctx, w, h) {
      const r = lcg(241);
      wash(ctx, w, h, '#4e8fd0', '#bcd9ef');
      clouds(ctx, w, h, r, 0.10, 0.26, 3, 0.55);
      box(ctx, w, h, 0, 0.72, 1, 0.28, '#cfc7b5');
      for (let i = -5; i <= 5; i++) {
        pline(ctx, w, h, [[0.5 + i * 0.03, 0.74], [0.5 + i * 0.34, 1]], 'rgba(130,120,104,0.45)', 0.004);
      }
      for (let i = 0; i < 4; i++) pline(ctx, w, h, [[0, 0.76 + i * 0.07], [1, 0.76 + i * 0.07]], 'rgba(130,120,104,0.3)', 0.004);
      box(ctx, w, h, 0.41, 0.66, 0.18, 0.08, '#9e9484');
      box(ctx, w, h, 0.44, 0.60, 0.12, 0.07, '#b2a894');
      ply(ctx, w, h, [[0.465, 0.62], [0.535, 0.62], [0.522, 0.14], [0.478, 0.14]], '#d9ccb0');
      ply(ctx, w, h, [[0.478, 0.14], [0.522, 0.14], [0.50, 0.06]], '#f0e2c0');
      ply(ctx, w, h, [[0.503, 0.62], [0.535, 0.62], [0.522, 0.14], [0.505, 0.14]], '#b6a88c');
      for (let i = 0; i < 9; i++) {
        pline(ctx, w, h, [[0.484, 0.20 + i * 0.045], [0.498, 0.20 + i * 0.045]], 'rgba(110,96,70,0.5)', 0.005);
      }
    },
  },
  {
    id: 'amphitheatre', name: 'Roman Amphitheatre',
    tags: ['stone', 'oval', 'tiers', 'ruin', 'arches', 'arena', 'ancient', 'concentric'],
    describe: 'A ruined Roman amphitheatre from above: concentric oval tiers of stone seating around a sandy arena.',
    render(ctx, w, h) {
      const r = lcg(251);
      wash(ctx, w, h, '#8aa15f', '#6c8549');
      speckle(ctx, w, h, 40, 'rgba(120,145,80,0.6)', 0, 1, 0, 1, 0.02, r);
      const tiers = [[0.47, '#9a8f74'], [0.41, '#b3a789'], [0.35, '#c6b995'], [0.29, '#a79b80']];
      for (const [rx, c] of tiers) elp(ctx, w, h, 0.5, 0.52, rx, rx * 0.72 * (w / h), c);
      elp(ctx, w, h, 0.5, 0.52, 0.22, 0.22 * 0.72 * (w / h), '#ddc89a');
      elp(ctx, w, h, 0.5, 0.52, 0.14, 0.14 * 0.72 * (w / h), '#c2a46f');
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        pline(ctx, w, h, [
          [0.5 + Math.cos(a) * 0.23, 0.52 + Math.sin(a) * 0.23 * 0.72 * (w / h)],
          [0.5 + Math.cos(a) * 0.46, 0.52 + Math.sin(a) * 0.46 * 0.72 * (w / h)],
        ], 'rgba(96,86,66,0.5)', 0.004);
      }
      elps(ctx, w, h, 0.5, 0.52, 0.47, 0.47 * 0.72 * (w / h), '#6e6450', 0.009);
      ply(ctx, w, h, [[0.80, 0.22], [0.97, 0.14], [0.99, 0.40], [0.86, 0.44]], 'rgba(109,133,73,0.85)');
    },
  },
  {
    id: 'dam', name: 'Concrete Dam',
    tags: ['concrete', 'curved', 'huge', 'water', 'man-made', 'grey', 'roaring', 'wall'],
    describe: 'A huge curved concrete dam wall holding back a reservoir, white water blasting from the spillways.',
    render(ctx, w, h) {
      const r = lcg(261);
      wash(ctx, w, h, '#9db6c6', '#c6d6df');
      water(ctx, w, h, 0.18, 0.34, '#2d6d8e', '#1d4c68', 3, r);
      ply(ctx, w, h, [[0, 0.10], [0.20, 0.30], [0.16, 1], [0, 1]], '#5d5a50');
      ply(ctx, w, h, [[1, 0.10], [0.80, 0.30], [0.84, 1], [1, 1]], '#4e4c44');
      ctx.fillStyle = '#d6d2c8';
      ctx.beginPath();
      ctx.moveTo(0.16 * w, 0.32 * h);
      ctx.quadraticCurveTo(0.5 * w, 0.44 * h, 0.84 * w, 0.32 * h);
      ctx.lineTo(0.80 * w, 0.90 * h);
      ctx.quadraticCurveTo(0.5 * w, 1.0 * h, 0.20 * w, 0.90 * h);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#eeeae0';
      ctx.beginPath();
      ctx.moveTo(0.16 * w, 0.30 * h);
      ctx.quadraticCurveTo(0.5 * w, 0.42 * h, 0.84 * w, 0.30 * h);
      ctx.lineTo(0.84 * w, 0.345 * h);
      ctx.quadraticCurveTo(0.5 * w, 0.465 * h, 0.16 * w, 0.345 * h);
      ctx.closePath(); ctx.fill();
      for (let i = 0; i < 7; i++) {
        pline(ctx, w, h, [[0.22 + i * 0.096, 0.40], [0.21 + i * 0.096, 0.94]], 'rgba(150,146,136,0.55)', 0.005);
      }
      for (const x of [0.38, 0.62]) {
        ply(ctx, w, h, [[x - 0.035, 0.44], [x + 0.035, 0.44], [x + 0.075, 1], [x - 0.075, 1]], '#f6f9fb');
      }
      water(ctx, w, h, 0.95, 1, '#8fb6c8', '#5e8699', 0, r);
    },
  },
  {
    id: 'refinery', name: 'Oil Refinery',
    tags: ['industrial', 'pipes', 'metal', 'flame', 'tanks', 'smell', 'man-made', 'complex'],
    describe: 'An oil refinery: steel tanks and columns, a tangle of pipes, a flare stack burning off gas, chemical smell.',
    render(ctx, w, h) {
      const r = lcg(271);
      wash(ctx, w, h, '#6b6a74', '#9d9289');
      box(ctx, w, h, 0, 0.82, 1, 0.18, '#4a4650');
      for (const [x, tw, th] of [[0.06, 0.16, 0.22], [0.26, 0.13, 0.17], [0.66, 0.15, 0.20]]) {
        box(ctx, w, h, x, 0.82 - th, tw, th, '#c3c7cc');
        elp(ctx, w, h, x + tw / 2, 0.82 - th, tw / 2, 0.025, '#e2e6ea');
        pline(ctx, w, h, [[x, 0.82 - th * 0.5], [x + tw, 0.82 - th * 0.5]], 'rgba(110,116,124,0.7)', 0.005);
      }
      for (const [x, cw, top] of [[0.44, 0.055, 0.34], [0.52, 0.045, 0.44], [0.86, 0.05, 0.40]]) {
        box(ctx, w, h, x, top, cw, 0.82 - top, '#aeb4ba');
        for (let i = 0; i < 4; i++) pline(ctx, w, h, [[x, top + 0.08 + i * 0.12], [x + cw, top + 0.08 + i * 0.12]], 'rgba(90,96,104,0.8)', 0.005);
        box(ctx, w, h, x - 0.008, top - 0.02, cw + 0.016, 0.02, '#8d939a');
      }
      box(ctx, w, h, 0.345, 0.16, 0.028, 0.66, '#9aa0a6');
      ply(ctx, w, h, [[0.345, 0.16], [0.373, 0.16], [0.385, 0.08], [0.36, 0.02], [0.335, 0.09]], '#ff8a3c');
      ply(ctx, w, h, [[0.350, 0.15], [0.368, 0.15], [0.372, 0.09], [0.358, 0.05], [0.344, 0.10]], '#ffd95e');
      for (let i = 0; i < 4; i++) pline(ctx, w, h, [[0.02, 0.70 + i * 0.035], [0.98, 0.70 + i * 0.035]], i % 2 ? '#8e949c' : '#777d85', 0.008);
      speckle(ctx, w, h, 16, 'rgba(230,232,236,0.3)', 0, 1, 0.02, 0.3, 0.02, r);
    },
  },
  {
    id: 'wheat-field', name: 'Wheat Field',
    tags: ['gold', 'flat', 'open', 'dry', 'rustling', 'horizon', 'warm', 'farmed'],
    describe: 'An open golden wheat field under a huge pale sky, stalks rustling, a flat empty horizon.',
    render(ctx, w, h) {
      const r = lcg(281);
      wash(ctx, w, h, '#7fb6e0', '#d9eaf4');
      elp(ctx, w, h, 0.26, 0.20, 0.17, 0.055, 'rgba(255,255,255,0.85)');
      elp(ctx, w, h, 0.68, 0.13, 0.13, 0.045, 'rgba(255,255,255,0.7)');
      box(ctx, w, h, 0, 0.56, 1, 0.44, '#d9a93f');
      ctx.fillStyle = lg(ctx, 0, 0.56 * h, 0, h, [[0, '#e8c05c'], [1, '#b8862c']]);
      ctx.fillRect(0, 0.56 * h, w, 0.44 * h);
      pline(ctx, w, h, [[0, 0.56], [1, 0.56]], 'rgba(120,88,24,0.4)', 0.004);
      ctx.strokeStyle = 'rgba(248,224,150,0.85)';
      for (let i = 0; i < 60; i++) {
        const x = r(), y = 0.60 + r() * 0.40, len = 0.06 + r() * 0.10;
        ctx.lineWidth = Math.max(0.8, 0.004 * S(w, h));
        ctx.beginPath();
        ctx.moveTo(x * w, (y + len) * h);
        ctx.quadraticCurveTo((x + 0.012) * w, y * h, (x + 0.004) * w, (y - 0.02) * h);
        ctx.stroke();
      }
      speckle(ctx, w, h, 30, 'rgba(120,84,20,0.25)', 0, 1, 0.6, 1, 0.006, r);
    },
  },
  {
    id: 'iceberg', name: 'Iceberg',
    tags: ['ice', 'floating', 'cold', 'white', 'sea', 'hidden mass', 'blue', 'isolated'],
    describe: 'An iceberg in a grey sea, white above the waterline and a far larger pale blue mass hanging below it.',
    render(ctx, w, h) {
      const r = lcg(291);
      wash(ctx, w, h, '#8d9aa6', '#c0cbd4');
      ply(ctx, w, h, [[0.30, 0.48], [0.40, 0.22], [0.52, 0.32], [0.62, 0.18], [0.74, 0.48]], '#f4fbff');
      ply(ctx, w, h, [[0.52, 0.32], [0.62, 0.18], [0.74, 0.48], [0.56, 0.48]], '#d3e9f5');
      box(ctx, w, h, 0, 0.48, 1, 0.52, '#2d5570');
      ctx.fillStyle = lg(ctx, 0, 0.48 * h, 0, h, [[0, '#4b7b96'], [1, '#143548']]);
      ctx.fillRect(0, 0.48 * h, w, 0.52 * h);
      ply(ctx, w, h, [[0.26, 0.48], [0.80, 0.48], [0.88, 0.66], [0.70, 0.90], [0.36, 0.94], [0.16, 0.70]], 'rgba(150,215,240,0.55)');
      ply(ctx, w, h, [[0.34, 0.48], [0.60, 0.48], [0.66, 0.68], [0.48, 0.82], [0.30, 0.64]], 'rgba(200,240,255,0.4)');
      pline(ctx, w, h, [[0, 0.48], [1, 0.48]], 'rgba(255,255,255,0.75)', 0.006);
      speckle(ctx, w, h, 10, 'rgba(255,255,255,0.4)', 0, 1, 0.5, 0.56, 0.008, r);
    },
  },
  {
    id: 'tornado', name: 'Tornado',
    tags: ['wind', 'funnel', 'grey', 'violent', 'flat land', 'loud', 'spiral', 'moving'],
    describe: 'A tornado funnel twisting down from a black storm cloud to flat open farmland, debris flying out of its base.',
    render(ctx, w, h) {
      const r = lcg(301);
      wash(ctx, w, h, '#3a3b48', '#8a8469', '#a39c6c');
      ctx.fillStyle = '#23242e';
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(w, 0); ctx.lineTo(w, 0.30 * h);
      ctx.bezierCurveTo(0.7 * w, 0.40 * h, 0.3 * w, 0.20 * h, 0, 0.34 * h);
      ctx.closePath(); ctx.fill();
      // the funnel: wide where it leaves the cloud, roped where it touches down
      ctx.fillStyle = '#4e5060';
      ctx.beginPath();
      ctx.moveTo(0.28 * w, 0.30 * h);
      ctx.bezierCurveTo(0.38 * w, 0.54 * h, 0.46 * w, 0.62 * h, 0.47 * w, 0.84 * h);
      ctx.lineTo(0.60 * w, 0.84 * h);
      ctx.bezierCurveTo(0.63 * w, 0.60 * h, 0.60 * w, 0.50 * h, 0.68 * w, 0.30 * h);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(126,128,142,0.9)';
      ctx.beginPath();
      ctx.moveTo(0.34 * w, 0.30 * h);
      ctx.bezierCurveTo(0.42 * w, 0.54 * h, 0.49 * w, 0.62 * h, 0.50 * w, 0.84 * h);
      ctx.lineTo(0.56 * w, 0.84 * h);
      ctx.bezierCurveTo(0.58 * w, 0.60 * h, 0.56 * w, 0.50 * h, 0.60 * w, 0.30 * h);
      ctx.closePath(); ctx.fill();
      // the spiral banding that makes it read as rotating
      for (let i = 0; i < 8; i++) {
        const t = i / 8;
        const cx = 0.46 + t * 0.07, cy = 0.33 + t * 0.50, rx = 0.19 * (1 - t * 0.80);
        elps(ctx, w, h, cx, cy, rx, rx * 0.26, 'rgba(226,228,238,0.45)', 0.006);
      }
      box(ctx, w, h, 0, 0.84, 1, 0.16, '#7c7546');
      pline(ctx, w, h, [[0, 0.84], [1, 0.84]], 'rgba(44,40,26,0.6)', 0.005);
      elp(ctx, w, h, 0.53, 0.845, 0.19, 0.045, 'rgba(150,145,128,0.75)');
      speckle(ctx, w, h, 26, 'rgba(48,43,28,0.8)', 0.25, 0.9, 0.58, 0.88, 0.008, r);
    },
  },
  {
    id: 'jungle-river', name: 'Jungle River from Above',
    tags: ['green', 'winding', 'humid', 'dense', 'brown water', 'aerial', 'snaking', 'tropical'],
    describe: 'Looking down on a wide brown river snaking through unbroken dark green rainforest canopy.',
    render(ctx, w, h) {
      const r = lcg(311);
      wash(ctx, w, h, '#214d24', '#143417');
      for (let i = 0; i < 150; i++) {
        const x = r(), y = r();
        cir(ctx, w, h, x, y, 0.012 + r() * 0.018, r() < 0.5 ? 'rgba(52,110,48,0.85)' : 'rgba(30,76,32,0.9)');
      }
      ctx.strokeStyle = '#7d6a3e';
      ctx.lineWidth = 0.13 * S(w, h);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0.10 * w, -0.02 * h);
      ctx.bezierCurveTo(0.46 * w, 0.26 * h, 0.08 * w, 0.52 * h, 0.44 * w, 0.72 * h);
      ctx.bezierCurveTo(0.70 * w, 0.86 * h, 0.72 * w, 0.94 * h, 0.96 * w, 1.02 * h);
      ctx.stroke();
      ctx.strokeStyle = '#a08c52';
      ctx.lineWidth = 0.085 * S(w, h);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(214,198,150,0.45)';
      ctx.lineWidth = 0.02 * S(w, h);
      ctx.stroke();
      speckle(ctx, w, h, 20, 'rgba(126,180,80,0.5)', 0, 1, 0, 1, 0.012, r);
    },
  },
  {
    id: 'ski-slope', name: 'Ski Slope',
    tags: ['snow', 'white', 'cold', 'slope', 'chairlift', 'pines', 'bright', 'tracks'],
    describe: 'A groomed white ski slope with dark pines along its edges and a chairlift running up the hill.',
    render(ctx, w, h) {
      const r = lcg(321);
      wash(ctx, w, h, '#3f7fc4', '#a9d2ef');
      ply(ctx, w, h, [[0, 0.44], [0.22, 0.26], [0.5, 0.40], [0.76, 0.24], [1, 0.42], [1, 0.56], [0, 0.56]], '#e8f2f8');
      curve(ctx, w, h, [[0, 0.60], [0.3, 0.50], [0.65, 0.58], [1, 0.48]], '#f6fbfe', 0, 1);
      for (let i = 0; i < 7; i++) pine(ctx, w, h, 0.06 + i * 0.16, 0.74 + (i % 2) * 0.05, 0.16, 0.045, '#1f4530');
      for (let i = 0; i < 5; i++) pine(ctx, w, h, 0.14 + i * 0.2, 0.98, 0.20, 0.055, '#163826');
      pline(ctx, w, h, [[0.08, 0.92], [0.92, 0.36]], '#3b3440', 0.005);
      for (const t of [0.2, 0.45, 0.7]) {
        const x = 0.08 + t * 0.84, y = 0.92 - t * 0.56;
        pline(ctx, w, h, [[x, y], [x, y + 0.05]], '#3b3440', 0.004);
        box(ctx, w, h, x - 0.022, y + 0.05, 0.044, 0.035, '#d7453c');
      }
      for (const [x, y] of [[0.14, 0.86], [0.92, 0.30]]) {
        pline(ctx, w, h, [[x, y], [x, y - 0.14]], '#4a4452', 0.012);
      }
      curve(ctx, w, h, [[0.34, 1], [0.42, 0.84], [0.36, 0.72], [0.44, 0.62]], 'rgba(150,185,210,0.7)', 0.007);
      speckle(ctx, w, h, 12, 'rgba(255,255,255,0.6)', 0, 1, 0.1, 0.4, 0.006, r);
    },
  },
  {
    id: 'mosque', name: 'Domed Mosque',
    tags: ['dome', 'minarets', 'sand stone', 'sacred', 'symmetry', 'warm', 'arches', 'man-made'],
    describe: 'A sandstone mosque at dusk: one great dome flanked by two slim minarets, arched entrance, warm symmetry.',
    render(ctx, w, h) {
      const r = lcg(331);
      wash(ctx, w, h, '#4c3a72', '#d58a63', '#f0c08a');
      cir(ctx, w, h, 0.945, 0.095, 0.030, '#fff3d0');
      box(ctx, w, h, 0, 0.84, 1, 0.16, '#6a4a48');
      for (const mx of [0.17, 0.83]) {
        box(ctx, w, h, mx - 0.028, 0.26, 0.056, 0.58, '#e7cfa8');
        box(ctx, w, h, mx - 0.038, 0.40, 0.076, 0.03, '#c9ab7e');
        elp(ctx, w, h, mx, 0.26, 0.042, 0.055, '#e7cfa8', Math.PI, Math.PI * 2);
        pline(ctx, w, h, [[mx, 0.21], [mx, 0.15]], '#c9ab7e', 0.008);
        cir(ctx, w, h, mx, 0.14, 0.014, '#f6e0b4');
      }
      box(ctx, w, h, 0.26, 0.56, 0.48, 0.28, '#f0d9b2');
      elp(ctx, w, h, 0.50, 0.56, 0.20, 0.24, '#ddc094', Math.PI, Math.PI * 2);
      elp(ctx, w, h, 0.50, 0.56, 0.20, 0.24, '#edd4a6', Math.PI * 1.0, Math.PI * 1.55);
      pline(ctx, w, h, [[0.50, 0.32], [0.50, 0.25]], '#c9ab7e', 0.009);
      cir(ctx, w, h, 0.50, 0.24, 0.016, '#fbe9bf');
      elp(ctx, w, h, 0.50, 0.84, 0.065, 0.16, '#6b4b3c', Math.PI, Math.PI * 2);
      for (const ax of [0.33, 0.67]) elp(ctx, w, h, ax, 0.84, 0.035, 0.10, '#b1906a', Math.PI, Math.PI * 2);
      speckle(ctx, w, h, 12, 'rgba(255,230,180,0.45)', 0, 1, 0.86, 1, 0.008, r);
    },
  },
  {
    id: 'pagoda', name: 'Tiered Pagoda',
    tags: ['tiers', 'red', 'wood', 'stacked', 'eaves', 'man-made', 'quiet', 'symmetry'],
    describe: 'A five-tiered wooden pagoda with upturned red eaves stepping inward as it rises, a spire on top.',
    render(ctx, w, h) {
      const r = lcg(341);
      wash(ctx, w, h, '#d8e5e0', '#9fb9a6');
      clouds(ctx, w, h, r, 0.08, 0.20, 3, 0.55);
      box(ctx, w, h, 0, 0.88, 1, 0.12, '#5e6f52');
      elp(ctx, w, h, 0.14, 0.78, 0.13, 0.10, 'rgba(60,92,60,0.75)');
      elp(ctx, w, h, 0.88, 0.80, 0.12, 0.09, 'rgba(60,92,60,0.75)');
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const y = 0.84 - i * 0.15;
        const halfBody = 0.17 - t * 0.075;
        const halfEave = 0.26 - t * 0.115;
        box(ctx, w, h, 0.5 - halfBody, y - 0.11, halfBody * 2, 0.11, '#c6552f');
        box(ctx, w, h, 0.5 - halfBody * 0.6, y - 0.09, halfBody * 1.2, 0.055, '#5b2d1c');
        ctx.fillStyle = '#8c2f22';
        ctx.beginPath();
        ctx.moveTo((0.5 - halfEave) * w, (y - 0.115) * h);
        ctx.quadraticCurveTo(0.5 * w, (y - 0.195) * h, (0.5 + halfEave) * w, (y - 0.115) * h);
        ctx.quadraticCurveTo(0.5 * w, (y - 0.145) * h, (0.5 - halfEave) * w, (y - 0.115) * h);
        ctx.closePath(); ctx.fill();
        pline(ctx, w, h, [[0.5 - halfEave, y - 0.115], [0.5 - halfEave - 0.015, y - 0.145]], '#8c2f22', 0.009);
        pline(ctx, w, h, [[0.5 + halfEave, y - 0.115], [0.5 + halfEave + 0.015, y - 0.145]], '#8c2f22', 0.009);
      }
      pline(ctx, w, h, [[0.5, 0.12], [0.5, 0.03]], '#d8c070', 0.009);
      for (let i = 0; i < 3; i++) elps(ctx, w, h, 0.5, 0.06 + i * 0.022, 0.022 - i * 0.005, 0.012, '#d8c070', 0.006);
    },
  },
  {
    id: 'stone-circle', name: 'Standing Stone Circle',
    tags: ['stone', 'ring', 'ancient', 'grass', 'upright', 'rough', 'grey', 'open'],
    describe: 'A ring of rough grey standing stones with lintels on open grassland at dawn, uprights in a circle.',
    render(ctx, w, h) {
      const r = lcg(351);
      wash(ctx, w, h, '#f3c489', '#d8d6b0', '#7f9456');
      cir(ctx, w, h, 0.22, 0.26, 0.05, '#fff4d2');
      box(ctx, w, h, 0, 0.50, 1, 0.50, '#86a05a');
      curve(ctx, w, h, [[0, 0.52], [0.4, 0.48], [0.7, 0.52], [1, 0.49]], '#6f8c4c', 0, 1);
      const ring = [];
      for (let i = 0; i < 11; i++) {
        const a = Math.PI * 0.08 + (i / 11) * Math.PI * 1.84;
        ring.push([0.5 + Math.cos(a) * 0.38, 0.70 + Math.sin(a) * 0.18]);
      }
      ring.sort((a, b) => a[1] - b[1]);
      for (const [x, y] of ring) {
        const sc = 0.7 + (y - 0.52) * 2.2;
        const sh = 0.24 * sc, sw = 0.048 * sc;
        elp(ctx, w, h, x + 0.02, y, sw * 1.6, sw * 0.5, 'rgba(50,62,34,0.4)');
        ply(ctx, w, h, [[x - sw, y], [x + sw, y], [x + sw * 0.84, y - sh], [x - sw * 0.9, y - sh * 0.95]], '#9b9589');
        ply(ctx, w, h, [[x + sw * 0.2, y], [x + sw, y], [x + sw * 0.84, y - sh], [x + sw * 0.1, y - sh * 0.97]], '#79736a');
      }
      speckle(ctx, w, h, 24, 'rgba(110,136,70,0.6)', 0, 1, 0.55, 1, 0.012, r);
    },
  },
  {
    id: 'sea-arch', name: 'Sea Arch',
    tags: ['rock', 'natural arch', 'waves', 'salt', 'cliff', 'hole', 'spray', 'coast'],
    describe: 'A natural rock arch standing in the surf off a coastline, waves breaking through the opening.',
    render(ctx, w, h) {
      const r = lcg(361);
      wash(ctx, w, h, '#f6d49a', '#f0a97a', '#b78aa0');
      water(ctx, w, h, 0.66, 1, '#3d6a86', '#1d3b52', 5, r);
      ply(ctx, w, h, [[0, 0.46], [0.16, 0.40], [0.22, 0.70], [0, 0.72]], '#5c4a46');
      ctx.fillStyle = '#6b564d';
      ctx.beginPath();
      ctx.moveTo(0.34 * w, 0.92 * h);
      ctx.lineTo(0.36 * w, 0.44 * h);
      ctx.lineTo(0.50 * w, 0.30 * h);
      ctx.lineTo(0.72 * w, 0.38 * h);
      ctx.lineTo(0.80 * w, 0.92 * h);
      ctx.lineTo(0.68 * w, 0.92 * h);
      ctx.lineTo(0.66 * w, 0.66 * h);
      ctx.bezierCurveTo(0.62 * w, 0.52 * h, 0.50 * w, 0.52 * h, 0.47 * w, 0.66 * h);
      ctx.lineTo(0.46 * w, 0.92 * h);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(40,30,28,0.3)';
      ctx.beginPath();
      ctx.moveTo(0.66 * w, 0.66 * h);
      ctx.bezierCurveTo(0.62 * w, 0.52 * h, 0.50 * w, 0.52 * h, 0.47 * w, 0.66 * h);
      ctx.lineTo(0.50 * w, 0.66 * h);
      ctx.bezierCurveTo(0.53 * w, 0.56 * h, 0.61 * w, 0.56 * h, 0.63 * w, 0.66 * h);
      ctx.closePath(); ctx.fill();
      elp(ctx, w, h, 0.40, 0.90, 0.13, 0.045, 'rgba(255,255,255,0.75)');
      elp(ctx, w, h, 0.74, 0.86, 0.10, 0.035, 'rgba(255,255,255,0.6)');
      speckle(ctx, w, h, 20, 'rgba(255,255,255,0.6)', 0.3, 0.85, 0.78, 0.95, 0.011, r);
    },
  },
  {
    id: 'salt-flat', name: 'Cracked Salt Flat',
    tags: ['white', 'flat', 'cracked', 'dry', 'vast', 'mirror', 'empty', 'hexagons'],
    describe: 'An endless cracked white salt flat, polygon crust underfoot, distant purple mountains on the horizon.',
    render(ctx, w, h) {
      const r = lcg(371);
      wash(ctx, w, h, '#6fa3d8', '#dce9f2');
      clouds(ctx, w, h, r, 0.10, 0.26, 3, 0.55);
      ply(ctx, w, h, [[0, 0.46], [0.18, 0.36], [0.34, 0.44], [0.52, 0.34], [0.72, 0.42], [0.88, 0.35], [1, 0.44], [1, 0.50], [0, 0.50]], '#8b7aa8');
      box(ctx, w, h, 0, 0.50, 1, 0.50, '#f4f3ef');
      ctx.fillStyle = lg(ctx, 0, 0.50 * h, 0, h, [[0, '#e6ecef'], [0.2, '#fbfbf8'], [1, '#dedbd2']]);
      ctx.fillRect(0, 0.50 * h, w, 0.50 * h);
      ctx.strokeStyle = 'rgba(150,146,134,0.8)';
      for (let row = 0; row < 7; row++) {
        const y = 0.52 + row * row * 0.011 + row * 0.03;
        const step = 0.07 + row * 0.035;
        for (let x = -0.1; x < 1.1; x += step) {
          ctx.lineWidth = Math.max(0.7, (0.002 + row * 0.0008) * S(w, h));
          ctx.beginPath();
          ctx.moveTo((x + (row % 2) * step * 0.5) * w, y * h);
          ctx.lineTo((x + (row % 2) * step * 0.5 + step * 0.5) * w, (y + 0.035 + row * 0.012) * h);
          ctx.lineTo((x + (row % 2) * step * 0.5 + step) * w, y * h);
          ctx.stroke();
        }
        ctx.lineWidth = Math.max(0.7, 0.002 * S(w, h));
        ctx.beginPath(); ctx.moveTo(0, y * h); ctx.lineTo(w, y * h); ctx.stroke();
      }
      pline(ctx, w, h, [[0, 0.50], [1, 0.50]], 'rgba(255,255,255,0.9)', 0.005);
    },
  },
  {
    id: 'geyser', name: 'Erupting Geyser',
    tags: ['water', 'vertical jet', 'steam', 'hot', 'sulphur', 'sudden', 'white', 'noise'],
    describe: 'A geyser erupting: a narrow column of boiling water shooting straight up out of pale mineral ground, steam everywhere.',
    render(ctx, w, h) {
      const r = lcg(381);
      wash(ctx, w, h, '#2f6fa8', '#9ec7e2');
      for (let i = 0; i < 14; i++) {
        ctx.fillStyle = `rgba(255,255,255,${(0.07 + r() * 0.1).toFixed(2)})`;
        ctx.beginPath();
        ctx.ellipse((0.3 + r() * 0.42) * w, (0.04 + r() * 0.34) * h, 0.16 * w, 0.10 * h, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      box(ctx, w, h, 0, 0.78, 1, 0.22, '#cdc4ad');
      curve(ctx, w, h, [[0, 0.82], [0.3, 0.78], [0.7, 0.81], [1, 0.78]], '#e3dcc6', 0, 1);
      elp(ctx, w, h, 0.5, 0.82, 0.16, 0.045, '#9d9480');
      elp(ctx, w, h, 0.5, 0.82, 0.10, 0.028, '#5d7f86');
      ply(ctx, w, h, [[0.455, 0.82], [0.545, 0.82], [0.57, 0.30], [0.50, 0.08], [0.43, 0.30]], 'rgba(255,255,255,0.92)');
      ply(ctx, w, h, [[0.478, 0.82], [0.522, 0.82], [0.535, 0.34], [0.50, 0.16], [0.465, 0.34]], '#ffffff');
      for (let i = 0; i < 10; i++) {
        const y = 0.16 + r() * 0.5;
        elp(ctx, w, h, 0.5 + (r() - 0.5) * 0.26, y, 0.06 + r() * 0.05, 0.035, 'rgba(255,255,255,0.42)');
      }
      speckle(ctx, w, h, 22, 'rgba(255,255,255,0.7)', 0.32, 0.68, 0.6, 0.84, 0.01, r);
    },
  },
  {
    id: 'runway', name: 'Airport Runway',
    tags: ['tarmac', 'straight lines', 'lights', 'flat', 'man-made', 'dusk', 'markings', 'noise'],
    describe: 'An airport runway at dusk: black tarmac with white centre dashes converging, rows of edge lights, a jet on approach.',
    render(ctx, w, h) {
      const r = lcg(391);
      wash(ctx, w, h, '#2a3a60', '#c47a58', '#e9a46c');
      box(ctx, w, h, 0, 0.52, 1, 0.48, '#3c3f46');
      ply(ctx, w, h, [[0.44, 0.52], [0.56, 0.52], [1.1, 1], [-0.1, 1]], '#23262b');
      for (let i = 0; i < 7; i++) {
        const t = i / 7, y = 0.54 + t * t * 0.46, hh = 0.012 + t * 0.045, ww = 0.012 + t * 0.03;
        box(ctx, w, h, 0.5 - ww / 2, y, ww, hh, '#f3f1e6');
      }
      for (let i = 0; i < 8; i++) {
        const t = i / 8, y = 0.54 + t * t * 0.44, sp = 0.07 + t * t * 0.52;
        cir(ctx, w, h, 0.5 - sp, y, 0.009 + t * 0.006, '#ffd36a');
        cir(ctx, w, h, 0.5 + sp, y, 0.009 + t * 0.006, '#ffd36a');
      }
      box(ctx, w, h, 0, 0.50, 1, 0.025, '#4a4e57');
      ply(ctx, w, h, [[0.56, 0.26], [0.78, 0.30], [0.82, 0.325], [0.60, 0.325]], '#e8eaee');
      ply(ctx, w, h, [[0.64, 0.30], [0.70, 0.22], [0.73, 0.22], [0.70, 0.30]], '#c9ced6');
      ply(ctx, w, h, [[0.66, 0.325], [0.72, 0.39], [0.75, 0.39], [0.72, 0.325]], '#c9ced6');
      cir(ctx, w, h, 0.57, 0.295, 0.009, '#fff0b0');
      speckle(ctx, w, h, 10, 'rgba(255,220,150,0.6)', 0, 1, 0.46, 0.52, 0.006, r);
    },
  },
  {
    id: 'subway-tunnel', name: 'Subway Tunnel',
    tags: ['tube', 'underground', 'dark', 'rails', 'rings', 'enclosed', 'metal', 'rumble'],
    describe: 'A round subway tunnel receding into darkness, concrete rings, two steel rails, a far-off light.',
    render(ctx, w, h) {
      wash(ctx, w, h, '#191622', '#0d0b12');
      for (let i = 7; i >= 0; i--) {
        const t = i / 7;
        const rx = 0.06 + t * 0.56, ry = rx * (w / h) * 0.9;
        const shade = Math.round(26 + (1 - t) * 10 + t * 56);
        elp(ctx, w, h, 0.5, 0.46, rx, ry, `rgb(${shade},${shade - 4},${shade + 8})`);
        elps(ctx, w, h, 0.5, 0.46, rx, ry, 'rgba(10,8,14,0.85)', 0.008);
      }
      elp(ctx, w, h, 0.5, 0.46, 0.05, 0.05 * (w / h) * 0.9, '#fff0bb');
      cir(ctx, w, h, 0.5, 0.46, 0.028, '#ffffff');
      ply(ctx, w, h, [[0.5, 0.46], [1.0, 1.0], [0, 1.0]], '#23202c');
      for (const off of [-1, 1]) {
        pline(ctx, w, h, [[0.5 + off * 0.012, 0.47], [0.5 + off * 0.40, 1]], '#b9c0ca', 0.009);
      }
      for (let i = 0; i < 8; i++) {
        const t = i / 8, y = 0.50 + t * t * 0.50, sp = 0.03 + t * t * 0.46;
        pline(ctx, w, h, [[0.5 - sp, y], [0.5 + sp, y]], 'rgba(62,52,42,0.9)', 0.006 + t * 0.006);
      }
      for (let i = 0; i < 5; i++) {
        cir(ctx, w, h, 0.5 - (0.08 + i * 0.1), 0.40 - i * 0.012, 0.008, 'rgba(255,214,140,0.8)');
      }
    },
  },
  {
    id: 'wind-farm', name: 'Wind Farm',
    tags: ['turbines', 'white', 'rotating', 'green hills', 'tall', 'man-made', 'wind', 'repeating'],
    describe: 'Rows of tall white wind turbines on green rolling hills, three slender blades each, turning steadily.',
    render(ctx, w, h) {
      const r = lcg(401);
      wash(ctx, w, h, '#63a8dd', '#d4e9f5');
      clouds(ctx, w, h, r, 0.08, 0.22, 3, 0.55);
      curve(ctx, w, h, [[0, 0.70], [0.3, 0.60], [0.6, 0.68], [1, 0.58]], '#79a94e', 0, 1);
      curve(ctx, w, h, [[0, 0.86], [0.35, 0.76], [0.7, 0.88], [1, 0.78]], '#5c8d3c', 0, 1);
      const turbines = [[0.18, 0.66, 1.0], [0.46, 0.62, 0.84], [0.74, 0.67, 0.92], [0.90, 0.60, 0.62]];
      for (const [x, baseY, sc] of turbines) {
        const top = baseY - 0.42 * sc;
        ply(ctx, w, h, [[x - 0.011 * sc, baseY], [x + 0.011 * sc, baseY], [x + 0.006 * sc, top], [x - 0.006 * sc, top]], '#f4f7f9');
        const rad = 0.17 * sc;
        for (let b = 0; b < 3; b++) {
          const a = (b / 3) * Math.PI * 2 + 0.5;
          pline(ctx, w, h, [[x, top], [x + Math.cos(a) * rad, top + Math.sin(a) * rad * (w / h)]], '#fbfdfe', 0.013 * sc);
        }
        cir(ctx, w, h, x, top, 0.014 * sc, '#cfd8de');
      }
    },
  },
  {
    id: 'shipwreck', name: 'Sunken Shipwreck',
    tags: ['underwater', 'rusted', 'tilted', 'dark', 'wreck', 'silt', 'cold', 'broken'],
    describe: 'A broken ship lying tilted on a dark seabed, hull rusted and split, silt clouding the cold water.',
    render(ctx, w, h) {
      const r = lcg(411);
      wash(ctx, w, h, '#0d3a44', '#04161d');
      ply(ctx, w, h, [[0.2, 0], [0.33, 0], [0.5, 1], [0.3, 1]], 'rgba(130,210,220,0.07)');
      box(ctx, w, h, 0, 0.84, 1, 0.16, '#30362e');
      curve(ctx, w, h, [[0, 0.88], [0.3, 0.84], [0.7, 0.88], [1, 0.84]], '#3b4136', 0, 1);
      ctx.save();
      ctx.translate(0.5 * w, 0.70 * h);
      ctx.rotate(-0.22);
      ctx.translate(-0.5 * w, -0.70 * h);
      ply(ctx, w, h, [[0.16, 0.66], [0.78, 0.63], [0.84, 0.74], [0.24, 0.80]], '#5c4034');
      ply(ctx, w, h, [[0.16, 0.66], [0.78, 0.63], [0.76, 0.675], [0.18, 0.705]], '#7c5542');
      ply(ctx, w, h, [[0.52, 0.63], [0.54, 0.63], [0.58, 0.30], [0.55, 0.30]], '#4b3a30');
      pline(ctx, w, h, [[0.56, 0.34], [0.30, 0.46]], '#4b3a30', 0.006);
      pline(ctx, w, h, [[0.56, 0.34], [0.76, 0.50]], '#4b3a30', 0.006);
      box(ctx, w, h, 0.34, 0.56, 0.16, 0.08, '#6a4a3a');
      for (let i = 0; i < 5; i++) cir(ctx, w, h, 0.26 + i * 0.09, 0.70, 0.013, '#2a1e18');
      ctx.restore();
      for (let i = 0; i < 10; i++) {
        cir(ctx, w, h, 0.62 + (r() - 0.5) * 0.14, 0.14 + r() * 0.42, 0.008 + r() * 0.01, 'rgba(190,235,240,0.35)');
      }
      speckle(ctx, w, h, 28, 'rgba(180,215,220,0.18)', 0, 1, 0, 1, 0.009, r);
    },
  },
  {
    id: 'observatory', name: 'Mountaintop Observatory',
    tags: ['dome', 'white', 'stars', 'high', 'cold', 'slit', 'man-made', 'quiet'],
    describe: 'A white domed observatory on a bare mountaintop under a sky thick with stars, its shutter slit standing open.',
    render(ctx, w, h) {
      const r = lcg(421);
      wash(ctx, w, h, '#050818', '#0e1830');
      starfield(ctx, w, h, 110, 0.74, r);
      // a soft band of denser stars rather than a hard diagonal streak
      ctx.save();
      ctx.translate(0.5 * w, 0.28 * h);
      ctx.rotate(0.22);
      ctx.fillStyle = 'rgba(150,172,230,0.10)';
      ctx.beginPath(); ctx.ellipse(0, 0, 0.62 * w, 0.09 * h, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      for (let i = 0; i < 70; i++) {
        const t = r();
        const x = t * w, y = (0.16 + t * 0.26 + (r() - 0.5) * 0.12) * h;
        ctx.fillStyle = `rgba(226,234,255,${(0.3 + r() * 0.6).toFixed(2)})`;
        ctx.beginPath(); ctx.arc(x, y, 0.0035 * S(w, h) * (0.6 + r()), 0, Math.PI * 2); ctx.fill();
      }
      ply(ctx, w, h, [[0, 1], [0.24, 0.72], [0.5, 0.78], [0.78, 0.70], [1, 1]], '#0f1320');
      box(ctx, w, h, 0.37, 0.66, 0.26, 0.14, '#cfd6df');
      box(ctx, w, h, 0.37, 0.64, 0.26, 0.03, '#eef2f6');
      elp(ctx, w, h, 0.50, 0.65, 0.17, 0.19, '#e6ecf2', Math.PI, Math.PI * 2);
      elp(ctx, w, h, 0.50, 0.65, 0.17, 0.19, '#aeb9c5', Math.PI * 1.5, Math.PI * 2);
      ply(ctx, w, h, [[0.478, 0.655], [0.522, 0.655], [0.515, 0.47], [0.485, 0.47]], '#0c0f1a');
      pline(ctx, w, h, [[0.50, 0.60], [0.66, 0.40]], 'rgba(220,235,255,0.35)', 0.012);
      for (const [x, y] of [[0.30, 0.86], [0.70, 0.88]]) cir(ctx, w, h, x, y, 0.011, '#ffcf6a');
      box(ctx, w, h, 0, 0.97, 1, 0.03, '#070a12');
    },
  },
  {
    id: 'bazaar', name: 'Covered Bazaar',
    tags: ['market', 'crowded', 'striped awnings', 'warm', 'spices', 'narrow', 'colour', 'noise'],
    describe: 'A narrow covered bazaar lane: striped awnings overhead, hanging lamps, stalls of colour, spice smell, crowds.',
    render(ctx, w, h) {
      const r = lcg(431);
      wash(ctx, w, h, '#8a5a30', '#c58b4a');
      box(ctx, w, h, 0, 0.78, 1, 0.22, '#6d4a2c');
      for (let i = 0; i < 6; i++) {
        const stripes = ['#d9443c', '#f0ead6', '#2e7fa8', '#f0ead6', '#e8a33d', '#f0ead6'];
        const x = i * 0.175 - 0.01;
        for (let s = 0; s < 6; s++) {
          ply(ctx, w, h, [
            [x + s * 0.028, 0.06], [x + (s + 1) * 0.028, 0.06],
            [x + (s + 1) * 0.028 + 0.012, 0.28], [x + s * 0.028 + 0.012, 0.28],
          ], stripes[(s + i) % 6]);
        }
      }
      box(ctx, w, h, 0, 0.26, 1, 0.035, '#5b3a22');
      for (let i = 0; i < 5; i++) {
        const x = 0.10 + i * 0.2;
        pline(ctx, w, h, [[x, 0.29], [x, 0.38]], '#4a2f1b', 0.005);
        ply(ctx, w, h, [[x - 0.028, 0.40], [x + 0.028, 0.40], [x + 0.018, 0.48], [x - 0.018, 0.48]], '#ffcf5e');
        cir(ctx, w, h, x, 0.44, 0.022, 'rgba(255,224,140,0.45)');
      }
      const stalls = ['#c0392b', '#2e8b57', '#e8a33d', '#8e44ad', '#2e7fa8'];
      for (let i = 0; i < 5; i++) {
        const x = 0.04 + i * 0.2;
        box(ctx, w, h, x, 0.60, 0.15, 0.20, '#7a5230');
        box(ctx, w, h, x, 0.58, 0.15, 0.035, stalls[i]);
        for (let b = 0; b < 3; b++) cir(ctx, w, h, x + 0.032 + b * 0.042, 0.56, 0.019, stalls[(i + b + 1) % 5]);
      }
      for (let i = 0; i < 7; i++) {
        const x = 0.06 + i * 0.14;
        ply(ctx, w, h, [[x - 0.028, 1], [x + 0.028, 1], [x + 0.020, 0.80], [x - 0.020, 0.80]], '#2b1c10');
        cir(ctx, w, h, x, 0.785, 0.022, '#3b2616');
      }
      speckle(ctx, w, h, 10, 'rgba(255,210,130,0.3)', 0, 1, 0.3, 0.6, 0.016, r);
    },
  },
  {
    id: 'zen-garden', name: 'Raked Zen Garden',
    tags: ['gravel', 'raked lines', 'rocks', 'still', 'quiet', 'beige', 'concentric', 'minimal'],
    describe: 'A raked gravel zen garden: pale gravel combed into concentric lines around three mossy standing rocks.',
    render(ctx, w, h) {
      const r = lcg(441);
      wash(ctx, w, h, '#ded3bb', '#cdbf9f');
      box(ctx, w, h, 0, 0, 1, 0.1, '#6e5a42');
      const rocks = [[0.30, 0.52, 0.11], [0.62, 0.40, 0.075], [0.72, 0.70, 0.095]];
      ctx.strokeStyle = 'rgba(176,162,132,0.95)';
      for (const [rx, ry, rr] of rocks) {
        for (let k = 1; k <= 6; k++) {
          ctx.lineWidth = Math.max(0.8, 0.0045 * S(w, h));
          ctx.beginPath();
          ctx.ellipse(rx * w, ry * h, (rr + k * 0.035) * w, (rr + k * 0.035) * w * 0.92, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      for (let i = 0; i < 9; i++) {
        pline(ctx, w, h, [[0.02, 0.14 + i * 0.1], [0.14, 0.14 + i * 0.1]], 'rgba(176,162,132,0.95)', 0.0045);
      }
      for (const [rx, ry, rr] of rocks) {
        elp(ctx, w, h, rx, ry + rr * 0.5, rr * 1.2, rr * 0.4, 'rgba(120,108,86,0.35)');
        ply(ctx, w, h, [
          [rx - rr, ry + rr * 0.5], [rx - rr * 0.8, ry - rr * 0.5], [rx - rr * 0.1, ry - rr * 1.05],
          [rx + rr * 0.8, ry - rr * 0.4], [rx + rr, ry + rr * 0.5],
        ], '#6d6a62');
        ply(ctx, w, h, [
          [rx - rr * 0.1, ry - rr * 1.05], [rx + rr * 0.8, ry - rr * 0.4],
          [rx + rr, ry + rr * 0.5], [rx + rr * 0.2, ry + rr * 0.5],
        ], '#54524c');
        elp(ctx, w, h, rx - rr * 0.3, ry - rr * 0.55, rr * 0.4, rr * 0.22, '#6f8c4a');
      }
      speckle(ctx, w, h, 60, 'rgba(255,255,255,0.22)', 0, 1, 0.12, 1, 0.005, r);
    },
  },
  {
    id: 'lunar-surface', name: 'Lunar Surface',
    tags: ['grey', 'craters', 'airless', 'black sky', 'dust', 'silent', 'earthrise', 'sterile'],
    describe: 'The cratered grey surface of the Moon: fine dust, hard shadows, black airless sky, Earth hanging above the horizon.',
    render(ctx, w, h) {
      const r = lcg(451);
      ctx.fillStyle = '#04040a';
      ctx.fillRect(0, 0, w, h);
      starfield(ctx, w, h, 70, 0.6, r);
      cir(ctx, w, h, 0.74, 0.22, 0.085, '#2f6fc0');
      ctx.save();
      ctx.beginPath(); ctx.arc(0.74 * w, 0.22 * h, 0.085 * S(w, h), 0, Math.PI * 2); ctx.clip();
      elp(ctx, w, h, 0.70, 0.19, 0.045, 0.035, '#4f9e5c');
      elp(ctx, w, h, 0.79, 0.26, 0.035, 0.025, '#59a868');
      elp(ctx, w, h, 0.72, 0.27, 0.05, 0.02, 'rgba(255,255,255,0.65)');
      elp(ctx, w, h, 0.78, 0.17, 0.04, 0.018, 'rgba(255,255,255,0.55)');
      ctx.restore();
      cir(ctx, w, h, 0.74, 0.22, 0.09, 'rgba(120,180,255,0.12)');
      ply(ctx, w, h, [[0, 0.56], [0.3, 0.52], [0.62, 0.56], [1, 0.52], [1, 1], [0, 1]], '#8d8a86');
      ctx.fillStyle = lg(ctx, 0, 0.52 * h, 0, h, [[0, '#a9a6a1'], [1, '#6c6a67']]);
      ctx.fillRect(0, 0.56 * h, w, 0.44 * h);
      ply(ctx, w, h, [[0, 0.56], [0.3, 0.52], [0.62, 0.56], [1, 0.52], [1, 0.58], [0, 0.60]], '#9b9893');
      const craters = [[0.22, 0.74, 0.12], [0.56, 0.68, 0.075], [0.80, 0.84, 0.10], [0.40, 0.90, 0.09], [0.66, 0.94, 0.06], [0.08, 0.62, 0.05]];
      for (const [x, y, rr] of craters) {
        elp(ctx, w, h, x, y, rr, rr * 0.42, '#605e5b');
        elp(ctx, w, h, x, y - rr * 0.06, rr * 0.86, rr * 0.33, '#8b8884');
        elps(ctx, w, h, x, y, rr, rr * 0.42, 'rgba(210,207,202,0.55)', 0.005);
      }
      speckle(ctx, w, h, 40, 'rgba(60,58,56,0.5)', 0, 1, 0.58, 1, 0.006, r);
    },
  },
  {
    id: 'hedge-maze', name: 'Hedge Maze',
    tags: ['green', 'grid', 'walls', 'puzzle', 'aerial', 'formal', 'enclosed', 'right angles'],
    describe: 'A formal hedge maze seen from above: dark clipped green walls in right-angled corridors around a centre.',
    render(ctx, w, h) {
      const r = lcg(461);
      wash(ctx, w, h, '#9fc06a', '#86a954');
      box(ctx, w, h, 0.03, 0.03, 0.94, 0.94, '#b4cf84');
      const N = 7;
      const cell = 0.94 / N;
      ctx.strokeStyle = '#22511f';
      ctx.lineCap = 'square';
      ctx.lineWidth = Math.max(2, 0.028 * S(w, h));
      const seg = (x0, y0, x1, y1) => {
        ctx.beginPath();
        ctx.moveTo((0.03 + x0 * cell) * w, (0.03 + y0 * cell) * h);
        ctx.lineTo((0.03 + x1 * cell) * w, (0.03 + y1 * cell) * h);
        ctx.stroke();
      };
      seg(0, 0, N, 0); seg(0, N, N, N); seg(0, 0, 0, N); seg(N, 0, N, N);
      for (let i = 0; i < 26; i++) {
        const x = Math.floor(r() * N), y = Math.floor(r() * N);
        if (r() < 0.5) seg(x, y, Math.min(N, x + 1 + Math.floor(r() * 2)), y);
        else seg(x, y, x, Math.min(N, y + 1 + Math.floor(r() * 2)));
      }
      seg(2, 2, 5, 2); seg(5, 2, 5, 5); seg(5, 5, 2, 5); seg(2, 5, 2, 3.2);
      box(ctx, w, h, 0.42, 0.42, 0.16, 0.16, '#d9cf9e');
      cir(ctx, w, h, 0.50, 0.50, 0.035, '#5fa0c8');
      speckle(ctx, w, h, 20, 'rgba(34,81,31,0.2)', 0.05, 0.95, 0.05, 0.95, 0.008, r);
    },
  },
  {
    id: 'clock-tower', name: 'Clock Tower',
    tags: ['tower', 'clock face', 'brick', 'tall', 'man-made', 'bells', 'hands', 'vertical'],
    describe: 'A tall brick clock tower with a big pale clock face and black hands, a spire above, bells inside.',
    render(ctx, w, h) {
      const r = lcg(471);
      wash(ctx, w, h, '#5e7fa8', '#c3d3e0');
      clouds(ctx, w, h, r, 0.06, 0.18, 2, 0.5);
      elp(ctx, w, h, 0.18, 0.24, 0.14, 0.05, 'rgba(255,255,255,0.7)');
      box(ctx, w, h, 0, 0.90, 1, 0.10, '#4e5a4a');
      box(ctx, w, h, 0.36, 0.26, 0.28, 0.64, '#9e5a46');
      box(ctx, w, h, 0.36, 0.26, 0.09, 0.64, '#b46a52');
      ctx.strokeStyle = 'rgba(80,42,32,0.35)';
      for (let i = 0; i < 13; i++) {
        ctx.lineWidth = Math.max(0.7, 0.0035 * S(w, h));
        ctx.beginPath(); ctx.moveTo(0.36 * w, (0.30 + i * 0.05) * h); ctx.lineTo(0.64 * w, (0.30 + i * 0.05) * h); ctx.stroke();
      }
      box(ctx, w, h, 0.33, 0.235, 0.34, 0.035, '#7d4434');
      box(ctx, w, h, 0.345, 0.195, 0.31, 0.04, '#8c4c3a');
      ply(ctx, w, h, [[0.345, 0.195], [0.655, 0.195], [0.50, 0.04]], '#3f4e5c');
      cir(ctx, w, h, 0.50, 0.035, 0.014, '#e8c35e');
      cir(ctx, w, h, 0.50, 0.44, 0.115, '#2d2a28');
      cir(ctx, w, h, 0.50, 0.44, 0.10, '#f3ead3');
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        pline(ctx, w, h, [
          [0.50 + Math.cos(a) * 0.082, 0.44 + Math.sin(a) * 0.082 * (w / h)],
          [0.50 + Math.cos(a) * 0.095, 0.44 + Math.sin(a) * 0.095 * (w / h)],
        ], '#3b3630', 0.006);
      }
      pline(ctx, w, h, [[0.50, 0.44], [0.50 + 0.05, 0.44 - 0.035]], '#2b2824', 0.011);
      pline(ctx, w, h, [[0.50, 0.44], [0.50 - 0.02, 0.44 + 0.085]], '#2b2824', 0.009);
      cir(ctx, w, h, 0.50, 0.44, 0.012, '#2b2824');
      box(ctx, w, h, 0.455, 0.72, 0.09, 0.18, '#5c3426');
      elp(ctx, w, h, 0.50, 0.72, 0.045, 0.045, '#5c3426', Math.PI, Math.PI * 2);
    },
  },
  {
    id: 'oasis', name: 'Desert Oasis',
    tags: ['palms', 'water', 'green', 'sand', 'hot', 'shade', 'small', 'relief'],
    describe: 'A small blue pool ringed by palm trees in the middle of hot open desert — sudden green in all that sand.',
    render(ctx, w, h) {
      const r = lcg(481);
      wash(ctx, w, h, '#64aede', '#e8d8ae');
      curve(ctx, w, h, [[0, 0.52], [0.3, 0.46], [0.65, 0.52], [1, 0.47]], '#e2b878', 0, 1);
      curve(ctx, w, h, [[0, 0.70], [0.4, 0.62], [0.8, 0.72], [1, 0.66]], '#efcf96', 0, 1);
      box(ctx, w, h, 0, 0.84, 1, 0.16, '#dcb272');
      elp(ctx, w, h, 0.52, 0.80, 0.26, 0.085, '#8e7b4e');
      elp(ctx, w, h, 0.52, 0.79, 0.23, 0.07, '#2d8fae');
      elp(ctx, w, h, 0.48, 0.775, 0.12, 0.03, 'rgba(180,235,245,0.55)');
      const palms = [[0.26, 0.74, 1.0], [0.38, 0.70, 0.8], [0.70, 0.72, 0.95], [0.80, 0.69, 0.7]];
      for (const [x, baseY, sc] of palms) {
        const top = baseY - 0.34 * sc;
        ctx.strokeStyle = '#6a4a2c';
        ctx.lineWidth = Math.max(1, 0.015 * sc * S(w, h));
        ctx.beginPath();
        ctx.moveTo(x * w, baseY * h);
        ctx.quadraticCurveTo((x - 0.03 * sc) * w, (baseY - 0.18 * sc) * h, ((x - 0.01 * sc)) * w, top * h);
        ctx.stroke();
        for (let f = 0; f < 6; f++) {
          const a = Math.PI + (f / 5) * Math.PI;
          const ex = x - 0.01 * sc + Math.cos(a) * 0.14 * sc;
          const ey = top + Math.sin(a) * 0.09 * sc + 0.03 * sc;
          ctx.strokeStyle = '#2f7a3e';
          ctx.lineWidth = Math.max(1, 0.013 * sc * S(w, h));
          ctx.beginPath();
          ctx.moveTo((x - 0.01 * sc) * w, top * h);
          ctx.quadraticCurveTo(((x - 0.01 * sc + ex) / 2) * w, (top - 0.06 * sc) * h, ex * w, ey * h);
          ctx.stroke();
        }
      }
      speckle(ctx, w, h, 18, 'rgba(160,112,58,0.25)', 0, 1, 0.86, 1, 0.008, r);
    },
  },
];

/* ------------------------------------------------------------------ *
 * Selection. This is the part the statistics depend on.
 * ------------------------------------------------------------------ */

/** How many candidates a ranking trial shows, and the resulting chance rate. */
export const CANDIDATES = 5;
export const CHANCE = 1 / CANDIDATES;

export const byId = (id) => TARGETS.find((t) => t.id === id) || null;

/**
 * Draw one trial's worth of targets.
 *
 * - The TRUE target is uniform over the whole pool (randomInt, crypto-backed).
 * - The DECOYS are drawn uniformly WITHOUT REPLACEMENT from the pool minus the
 *   true target, so a decoy can never be the true target and no target can
 *   appear twice in the grid.
 * - The DISPLAY ORDER is shuffled independently of which member is the true
 *   target, so position in the grid carries no information. (Fisher-Yates from
 *   core/rng.js, which is unbiased.)
 *
 * With `count` candidates the probability of ranking the true target first by
 * guessing alone is exactly 1/count — 20% at the default of 5. Nothing in here
 * looks at the viewer's history: there is no adaptive difficulty anywhere.
 *
 * Math.random is not used. Not here, not anywhere that touches a scored draw.
 */
export function chooseTargetSet(pool = TARGETS, count = CANDIDATES) {
  if (!Array.isArray(pool) || pool.length < count) {
    throw new Error(`chooseTargetSet: pool needs at least ${count} targets`);
  }
  const target = pool[randomInt(pool.length)];
  const rest = pool.filter((t) => t.id !== target.id);
  const decoys = sample(rest, count - 1);
  const order = shuffle([target, ...decoys]);
  return { target, decoys, order };
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/**
 * Paint a target into a canvas element, sizing its backing store for the
 * device pixel ratio. Safe to call repeatedly; renders are deterministic so
 * the result is identical every time.
 */
export function paintTarget(canvas, target, dpr) {
  const ratio = Math.min(dpr || globalThis.devicePixelRatio || 1, 2.5);
  const cssW = canvas.clientWidth || canvas.width || 240;
  const cssH = canvas.clientHeight || canvas.height || 170;
  const pw = Math.max(1, Math.round(cssW * ratio));
  const ph = Math.max(1, Math.round(cssH * ratio));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.save();
  target.render(ctx, pw, ph);
  ctx.restore();
  return canvas;
}

/** Sanity check used by the test script: no duplicate ids, enough targets. */
export function poolIntegrity(pool = TARGETS) {
  const ids = pool.map((t) => t.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const missing = pool.filter((t) => !t.name || !t.describe || typeof t.render !== 'function' || !t.tags?.length);
  return { size: pool.length, dupes, malformed: missing.map((t) => t.id) };
}
