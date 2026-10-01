/** A tiny tween runner. Everything animated goes through here so one clock
 *  drives the whole game and nothing drifts out of sync. */
import { clamp01, linear } from './easing.js';

export class Tweens {
  constructor() { this.items = []; }

  /**
   * @param {object} o  { from, to, dur, ease, delay, onUpdate, onComplete }
   * @returns {Promise<void>} resolves on completion (not on cancel)
   */
  add({ from = 0, to = 1, dur = 0.3, ease = linear, delay = 0, onUpdate, onComplete, tag }) {
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    this.items.push({ from, to, dur: Math.max(dur, 1e-6), ease, delay, onUpdate, onComplete, tag, t: 0, resolve });
    return done;
  }

  /** Remove tweens by tag without resolving them. */
  cancel(tag) {
    this.items = this.items.filter((i) => i.tag !== tag);
  }

  clear() { this.items.length = 0; }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.delay > 0) { it.delay -= dt; continue; }
      it.t += dt;
      const k = clamp01(it.t / it.dur);
      const e = it.ease(k);
      if (it.onUpdate) it.onUpdate(it.from + (it.to - it.from) * e, e, k);
      if (k >= 1) {
        this.items.splice(i, 1);
        if (it.onComplete) it.onComplete();
        it.resolve();
      }
    }
  }
}

export const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
