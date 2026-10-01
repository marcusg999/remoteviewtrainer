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
      box(ctx, w, h, 0.43, 0.70, 0.14, 0.30, '#3f6e58');
      curve(ctx, w, h, [[0.47, 1], [0.49, 0.88], [0.5, 0.78], [0.52, 0.70]], 'rgba(255,255,255,0.3)', 0.008);
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
    describe: 'Inside a gothic cathedral: receding pointed arches, a vast cold vertical space, a rose window of coloured glass.',
    render(ctx, w, h) {
      wash(ctx, w, h, '#1b1a2a', '#2e2a3c');
      for (let i = 0; i < 4; i++) {
        const k = i * 0.09, a = 0.9 - i * 0.18;
        ctx.fillStyle = `rgba(92,86,110,${a.toFixed(2)})`;
        for (const side of [0, 1]) {
          const x = side ? 1 - 0.06 - k : 0.06 + k;
          ctx.fillRect((x - 0.035) * w, (0.22 + k * 0.7) * h, 0.07 * w, (0.78 - k * 0.7) * h);
          ctx.beginPath();
          ctx.moveTo((x - 0.035) * w, (0.26 + k * 0.7) * h);
          ctx.lineTo(x * w, (0.14 + k * 0.8) * h);
          ctx.lineTo((x + 0.035) * w, (0.26 + k * 0.7) * h);
          ctx.closePath(); ctx.fill();
        }
      }
      ply(ctx, w, h, [[0.5, 0.06], [0.70, 0.40], [0.30, 0.40]], '#3a3550');
      const cols = ['#d84a4a', '#3f7fd4', '#e8c23d', '#4fb46b', '#9a5fd0', '#e2873a'];
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2, a1 = ((i + 1) / 12) * Math.PI * 2;
        ctx.fillStyle = cols[i % 6];
        ctx.beginPath(); ctx.moveTo(0.5 * w, 0.30 * h);
        ctx.ellipse(0.5 * w, 0.30 * h, 0.10 * w, 0.10 * w, 0, a0, a1);
        ctx.closePath(); ctx.fill();
      }
      cir(ctx, w, h, 0.5, 0.30, 0.028, '#fff3cd');
      ply(ctx, w, h, [[0.36, 1], [0.64, 1], [0.56, 0.44], [0.44, 0.44]], '#4b4560');
      ply(ctx, w, h, [[0.42, 1], [0.58, 1], [0.54, 0.46], [0.46, 0.46]], 'rgba(255,240,200,0.14)');
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
      speckle(ctx, w, h, 16, 'rgba(255,255,255,0.5)', 0, 1, 0, 0.3, 0.006, r);
    },
  },
