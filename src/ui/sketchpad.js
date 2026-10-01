/**
 * Sketchpad — the pen input for the remote-viewing stages.
 *
 * Pointer Events only, so one code path covers mouse, stylus and finger. The
 * canvas sets `touch-action:none` (see rv.css) and the pad calls
 * setPointerCapture, which is what stops a drawing gesture from scrolling or
 * rubber-banding the page on a phone.
 *
 * Strokes are stored as arrays of points in NORMALISED coordinates (0..1), not
 * device pixels, for three reasons:
 *   - undo is just popping the stroke list and repainting;
 *   - a rotate or resize repaints the same drawing at the new size instead of
 *     stretching a bitmap;
 *   - the stored session detail stays small and resolution-independent.
 *
 * Line width tracks pointer speed (and pressure when the device reports it) so
 * a quick reflexive ideogram stroke looks like one.
 *
 *   const pad = new Sketchpad({ ink:'#f5ecd9', minWidth:1.6, maxWidth:5 });
 *   host.appendChild(pad.el);
 *   pad.mount();                 // start observing size; paints the paper
 *   pad.undo(); pad.clear();
 *   pad.isEmpty(); pad.strokeCount();
 *   pad.toDataURL();             // 'data:image/png;base64,...'
 *   pad.toJSON();                // { w, h, strokes:[[[x,y,p],...]] }
 *   pad.dispose();
 */

const DPR = () => Math.min(globalThis.devicePixelRatio || 1, 2.5);

export class Sketchpad {
  /**
   * @param {object} o
   *   ink        stroke colour
   *   paper      background colour (opaque, so toDataURL is readable)
   *   grid       draw a faint guide grid
   *   minWidth   thinnest line, in px at CSS scale
   *   maxWidth   thickest line
   *   onChange   called after any stroke / undo / clear
   *   label      accessible label
   */
  constructor(o = {}) {
    this.ink = o.ink || '#f5ecd9';
    this.paper = o.paper || '#120f1b';
    this.grid = o.grid !== false;
    this.minWidth = o.minWidth ?? 1.4;
    this.maxWidth = o.maxWidth ?? 5.2;
    this.onChange = o.onChange || null;

    this.strokes = [];      // [[ [x,y,pressure], ... ], ...] normalised
    this.current = null;
    this.activeId = null;
    this.disposed = false;

    this.el = document.createElement('div');
    this.el.className = 'rv-pad';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'rv-pad-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', o.label || 'Sketch area');
    this.el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._onDown = this._down.bind(this);
    this._onMove = this._move.bind(this);
    this._onUp = this._up.bind(this);
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);
    this.canvas.addEventListener('pointerleave', this._onUp);
    // Belt and braces for older touch stacks that still scroll on touchmove.
    this.canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  /** Begin observing size and paint the blank paper. Call once mounted in DOM. */
  mount() {
    if (this.disposed) return this;
    this._resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this._resize());
      this.ro.observe(this.canvas);
    } else {
      this._onWinResize = () => this._resize();
      window.addEventListener('resize', this._onWinResize);
    }
    return this;
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(r.width || this.canvas.clientWidth || 300));
    const cssH = Math.max(1, Math.round(r.height || this.canvas.clientHeight || 180));
    const d = DPR();
    const pw = Math.round(cssW * d), ph = Math.round(cssH * d);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.cssW = cssW; this.cssH = cssH; this.dpr = d;
    this.repaint();
  }

  /* ---------- input ---------- */

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      (e.clientX - r.left) / Math.max(1, r.width),
      (e.clientY - r.top) / Math.max(1, r.height),
      // Chrome reports 0.5 for a mouse and 0 for "unknown"; treat 0 as 0.5.
      e.pressure > 0 ? e.pressure : 0.5,
    ];
  }

  _down(e) {
    if (this.disposed || this.activeId !== null) return;
    e.preventDefault();
    this.activeId = e.pointerId;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    this.current = [this._pt(e)];
    this.strokes.push(this.current);
  }

  _move(e) {
    if (this.activeId !== e.pointerId || !this.current) return;
    e.preventDefault();
    // Coalesced events give smooth lines on high-rate pens without extra cost.
    const evts = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const list = evts && evts.length ? evts : [e];
    for (const ev of list) {
      const p = this._pt(ev);
      const last = this.current[this.current.length - 1];
      // Drop sub-pixel noise so stored strokes stay small.
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.cssW < 0.8) continue;
      this.current.push(p);
    }
    this.repaint();
  }

  _up(e) {
    if (this.activeId !== e.pointerId) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    this.activeId = null;
    if (this.current && this.current.length === 1) {
      // A tap is a dot: duplicate the point so the renderer draws something.
      this.current.push([this.current[0][0] + 0.0005, this.current[0][1], this.current[0][2]]);
    }
    this.current = null;
    this.repaint();
    this.onChange?.(this);
  }

  /* ---------- commands ---------- */

  undo() {
    if (!this.strokes.length) return false;
    this.strokes.pop();
    this.repaint();
    this.onChange?.(this);
    return true;
  }

  clear() {
    if (!this.strokes.length) { this.repaint(); return false; }
    this.strokes = [];
    this.current = null;
    this.repaint();
    this.onChange?.(this);
    return true;
  }

  isEmpty() { return this.strokes.length === 0; }
  strokeCount() { return this.strokes.length; }
  /** Rough measure of how much ink is down — used to gate "you drew nothing". */
  inkLength() {
    let total = 0;
    for (const s of this.strokes) {
      for (let i = 1; i < s.length; i++) total += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]);
    }
    return total;
  }

  /* ---------- painting ---------- */

  repaint() {
    if (this.disposed) return;
    const { ctx } = this;
    const w = this.canvas.width, h = this.canvas.height;
    if (!w || !h) return;
    const d = this.dpr || DPR();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.paper;
    ctx.fillRect(0, 0, w, h);

    if (this.grid) {
      ctx.strokeStyle = 'rgba(201,162,106,0.10)';
      ctx.lineWidth = Math.max(1, d * 0.5);
      const step = w / 6;
      ctx.beginPath();
      for (let x = step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      const stepY = h / 4;
      for (let y = stepY; y < h; y += stepY) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    }

    ctx.strokeStyle = this.ink;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of this.strokes) this._strokePath(s, w, h, d);
  }

  _strokePath(s, w, h, d) {
    const { ctx } = this;
    if (s.length < 2) return;
    // Draw segment by segment so the width can vary along the stroke.
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i];
      const dist = Math.hypot((b[0] - a[0]) * w, (b[1] - a[1]) * h) / d;
      // Fast strokes thin out, slow ones thicken — plus pen pressure.
      const speedK = Math.max(0, 1 - Math.min(1, dist / 26));
      const press = (a[2] + b[2]) / 2;
      const lw = this.minWidth + (this.maxWidth - this.minWidth) * (0.45 * speedK + 0.55 * press);
      ctx.lineWidth = Math.max(0.6, lw * d);
      ctx.beginPath();
      ctx.moveTo(a[0] * w, a[1] * h);
      if (i + 1 < s.length) {
        const c = s[i + 1];
        ctx.quadraticCurveTo(b[0] * w, b[1] * h, ((b[0] + c[0]) / 2) * w, ((b[1] + c[1]) / 2) * h);
      } else {
        ctx.lineTo(b[0] * w, b[1] * h);
      }
      ctx.stroke();
    }
  }

  /* ---------- export ---------- */

  /** PNG data URL of exactly what is on screen. Opaque, so it reads anywhere. */
  toDataURL(type = 'image/png', quality) {
    try { return this.canvas.toDataURL(type, quality); } catch { return null; }
  }

  /** Vector form: tiny, replayable, and what the session actually stores. */
  toJSON() {
    return {
      w: this.cssW || 0,
      h: this.cssH || 0,
      strokes: this.strokes.map((s) => s.map(([x, y, p]) => [
        +x.toFixed(4), +y.toFixed(4), +p.toFixed(2),
      ])),
    };
  }

  /** Replay a toJSON() payload. Used to restore a stage the viewer went back to. */
  fromJSON(data) {
    this.strokes = Array.isArray(data?.strokes) ? data.strokes.map((s) => s.slice()) : [];
    this.repaint();
    return this;
  }

  dispose() {
    this.disposed = true;
    this.ro?.disconnect();
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('pointerleave', this._onUp);
    this.el.remove();
  }
}

/**
 * The toolbar that goes with a pad: UNDO / CLEAR, as big as a thumb.
 * Returned element is already wired to `pad`.
 */
export function padTools(pad, extra = []) {
  const bar = document.createElement('div');
  bar.className = 'rv-padtools';
  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn small ghost rv-padbtn ${cls || ''}`.trim();
    b.textContent = label;
    b.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    bar.appendChild(b);
    return b;
  };
  mk('Undo', 'rv-undo', () => pad.undo());
  mk('Clear', 'rv-clear', () => pad.clear());
  for (const x of extra) mk(x.label, x.cls, x.onClick);
  return bar;
}
