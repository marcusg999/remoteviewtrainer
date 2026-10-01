/**
 * Floating score text, anchored to a 3D point and projected to screen.
 * DOM rather than sprites: text stays pin-sharp at any DPR, and the chunky
 * outline the reference uses is three lines of CSS instead of a shader.
 *
 * Measured off the reference footage: the number rises and fades over ~400ms.
 */
import * as THREE from 'three';
import { easeOutCubic, easeOutBack, clamp01 } from '../juice/easing.js';

const RISE = 0.42; // seconds, matches the reference
const _v = new THREE.Vector3();

export class FloatText {
  constructor(layer, camera) {
    this.layer = layer;
    this.camera = camera;
    this.items = [];
    this.pool = [];
  }

  _acquire() {
    const el = this.pool.pop() || document.createElement('div');
    el.className = 'float-text';
    this.layer.appendChild(el);
    return el;
  }

  /**
   * @param {THREE.Vector3} world anchor point
   * @param {string} text
   * @param {object} o { kind: 'hit'|'miss'|'mult'|'chips'|'plain', dur, drift }
   */
  spawn(world, text, o = {}) {
    const el = this._acquire();
    el.textContent = text;
    el.dataset.kind = o.kind || 'plain';
    const item = {
      el,
      world: world.clone(),
      t: 0,
      dur: o.dur ?? RISE,
      drift: o.drift ?? 0.55,
      jitter: (Math.random() - 0.5) * 26,
    };
    this.items.push(item);
    // Position it now. Waiting for the next update tick leaves it at the
    // layer's top-left corner for one frame, which is very visible.
    this._place(item, 0);
    return el;
  }

  _place(it, k) {
      _v.copy(it.world).project(this.camera);
      const w = this.layer.clientWidth, h = this.layer.clientHeight;
      const x = (_v.x * 0.5 + 0.5) * w + it.jitter;
      const y = (-_v.y * 0.5 + 0.5) * h - easeOutCubic(k) * it.drift * h * 0.18;

      // pop in with overshoot, then shrink slightly as it fades
      const pop = k < 0.22 ? easeOutBack(k / 0.22, 2.6) : 1;
      const shrink = k > 0.6 ? 1 - (k - 0.6) / 0.4 * 0.22 : 1;
      const alpha = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35;

      it.el.style.transform =
        `translate(-50%,-50%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${(pop * shrink).toFixed(3)})`;
      it.el.style.opacity = alpha.toFixed(3);
      // behind-camera guard
      it.el.style.visibility = _v.z > 1 ? 'hidden' : 'visible';
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = clamp01(it.t / it.dur);
      this._place(it, k);

      if (k >= 1) {
        this.layer.removeChild(it.el);
        this.pool.push(it.el);
        this.items.splice(i, 1);
      }
    }
  }

  clear() {
    for (const it of this.items) {
      if (it.el.parentNode) this.layer.removeChild(it.el);
      this.pool.push(it.el);
    }
    this.items.length = 0;
  }
}
