/**
 * Zener card faces, drawn to canvas at runtime. No binary assets, and the
 * symbols stay crisp on a 3x-DPR phone as well as a desktop monitor.
 *
 * The five symbols are Zener's originals: circle, cross, waves, square, star.
 */

export const SYMBOLS = ['circle', 'cross', 'waves', 'square', 'star'];
export const SYMBOL_LABEL = {
  circle: 'Circle', cross: 'Cross', waves: 'Waves', square: 'Square', star: 'Star',
};

const CARD_W = 512;
const CARD_H = 716; // ~1:1.4, standard playing-card ratio

/** Aged ivory stock with a little grain and a warm edge burn. */
function drawStock(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, '#f6efdf');
  g.addColorStop(0.5, '#efe6d2');
  g.addColorStop(1, '#e3d7bf');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // edge burn: candlelight falls off toward the card's corners
  const v = ctx.createRadialGradient(w / 2, h / 2, w * 0.15, w / 2, h / 2, w * 0.82);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(78,54,28,0.30)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);

  // paper grain
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 13;
    d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.8;
  }
  ctx.putImageData(img, 0, 0);
}

function drawBorder(ctx, w, h) {
  ctx.strokeStyle = 'rgba(40,28,16,0.42)';
  ctx.lineWidth = 5;
  roundRect(ctx, 24, 24, w - 48, h - 48, 10);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(40,28,16,0.18)';
  ctx.lineWidth = 2;
  roundRect(ctx, 38, 38, w - 76, h - 76, 7);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The ink. Slightly off-black with a faint bleed, like a real print. */
function inkStyle(ctx, size) {
  ctx.strokeStyle = '#1b1a24';
  ctx.fillStyle = '#1b1a24';
  ctx.lineWidth = size * 0.085;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(30,25,45,0.32)';
  ctx.shadowBlur = size * 0.035;
}

/** Draw one symbol centred at (cx, cy) spanning `size`. Exported for the UI. */
export function drawSymbol(ctx, symbol, cx, cy, size) {
  ctx.save();
  inkStyle(ctx, size);
  const r = size / 2;
  switch (symbol) {
    case 'circle': {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'cross': {
      const a = r * 0.86;
      ctx.beginPath();
      ctx.moveTo(cx, cy - a); ctx.lineTo(cx, cy + a);
      ctx.moveTo(cx - a, cy); ctx.lineTo(cx + a, cy);
      ctx.stroke();
      break;
    }
    case 'waves': {
      // three stacked sine waves, the classic Zener "waves"
      const amp = r * 0.26, span = r * 0.86, gap = r * 0.52;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        for (let i = 0; i <= 64; i++) {
          const t = i / 64;
          const x = cx - span + t * span * 2;
          const y = cy + k * gap + Math.sin(t * Math.PI * 2) * amp;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'square': {
      const a = r * 0.72;
      ctx.beginPath();
      ctx.rect(cx - a, cy - a, a * 2, a * 2);
      ctx.stroke();
      break;
    }
    case 'star': {
      // 5-pointed open star, drawn as a continuous outline
      const R = r * 0.92, ri = R * 0.382;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const ang = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? R : ri;
        const x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      break;
    }
    default: break;
  }
  ctx.restore();
}

/** Full card face as a canvas. */
export function makeFaceCanvas(symbol, scale = 1) {
  const w = CARD_W * scale, h = CARD_H * scale;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  drawStock(ctx, w, h);
  drawBorder(ctx, w, h);
  drawSymbol(ctx, symbol, w / 2, h / 2, w * 0.56);
  return c;
}

/** Card back: a dark lattice with a faint sigil. Must not hint at the face. */
export function makeBackCanvas(scale = 1) {
  const w = CARD_W * scale, h = CARD_H * scale;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#3b2b52');
  g.addColorStop(0.5, '#52396e');
  g.addColorStop(1, '#2d2040');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // diagonal lattice
  ctx.strokeStyle = 'rgba(226,190,140,0.22)';
  ctx.lineWidth = Math.max(1, 2 * scale);
  const step = 26 * scale;
  for (let i = -h; i < w + h; i += step) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i + h, 0); ctx.lineTo(i, h); ctx.stroke();
  }

  // centre medallion
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.strokeStyle = '#e8c68a';
  ctx.lineWidth = 4 * scale;
  ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.21, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.165, 0, Math.PI * 2); ctx.stroke();
  // an eye-less vesica, deliberately not one of the five symbols
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w * 0.11, w * 0.055, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = 'rgba(232,198,138,0.7)';
  ctx.lineWidth = 5 * scale;
  roundRect(ctx, 20 * scale, 20 * scale, w - 40 * scale, h - 40 * scale, 10 * scale);
  ctx.stroke();

  const v = ctx.createRadialGradient(w / 2, h / 2, w * 0.1, w / 2, h / 2, w * 0.8);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  return c;
}

export const CARD_ASPECT = CARD_H / CARD_W;
