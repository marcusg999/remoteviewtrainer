/**
 * A single card in 3D.
 *
 * The feel rules, taken from watching the reference footage frame by frame:
 *  - no two cards sit at the same angle, and none sits at exactly zero
 *  - every card idles on its own phase, so a row breathes instead of pulsing
 *  - hover lifts AND tilts toward the pointer; a flat lift reads as a sprite
 *  - the flip arcs upward; a card that spins in place looks like a texture swap
 */
import * as THREE from 'three';
import { makeFaceCanvas, makeBackCanvas, CARD_ASPECT } from './cardArt.js';
import { randomFloat } from '../core/rng.js';
import { easeOutBack, easeInOutCubic, easeOutCubic, damp, clamp01 } from '../juice/easing.js';

export const CARD_W = 1.0;
export const CARD_H = CARD_W * CARD_ASPECT;
const THICK = 0.014;

/** Textures are shared across every card — 25 canvases would be absurd. */
const texCache = new Map();
function faceTexture(symbol) {
  if (!texCache.has(symbol)) {
    const t = new THREE.CanvasTexture(makeFaceCanvas(symbol));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texCache.set(symbol, t);
  }
  return texCache.get(symbol);
}
function backTexture() {
  if (!texCache.has('__back')) {
    const t = new THREE.CanvasTexture(makeBackCanvas());
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texCache.set('__back', t);
  }
  return texCache.get('__back');
}

export class Card {
  /** @param {string} symbol one of SYMBOLS */
  constructor(symbol) {
    this.symbol = symbol;
    this.faceUp = false;

    const edge = new THREE.MeshStandardMaterial({ color: 0xcfc4ab, roughness: 0.85 });
    const front = new THREE.MeshStandardMaterial({
      map: faceTexture(symbol), roughness: 0.62, metalness: 0.0,
    });
    const back = new THREE.MeshStandardMaterial({
      map: backTexture(), roughness: 0.55, metalness: 0.08,
    });
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(CARD_W, CARD_H, THICK),
      [edge, edge, edge, edge, front, back]
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;

    this.group = new THREE.Group();
    this.group.add(this.mesh);

    // resting pose: a card is never perfectly square to the table
    this.restTilt = (randomFloat() - 0.5) * 0.09;
    this.restRoll = (randomFloat() - 0.5) * 0.05;
    this.phase = randomFloat() * Math.PI * 2;
    this.bobSpeed = 0.75 + randomFloat() * 0.45;
    this.bobAmp = 0.012 + randomFloat() * 0.009;

    this.home = new THREE.Vector3();
    this.lift = 0;           // current hover/select lift
    this.targetLift = 0;
    this.scale = 1;
    this.targetScale = 1;
    this.flipT = 1;          // 0..1 through a flip
    this.flipping = false;
    this.spinY = Math.PI;    // start showing the back
    this.pointerTilt = new THREE.Vector2();
    this.targetPointerTilt = new THREE.Vector2();
    this.popT = 0;           // score pop
    this.dead = false;
  }

  setHome(x, y, z) { this.home.set(x, y, z); this.group.position.set(x, y, z); }

  /** Tint a retired card so the row reads as a record of the run. */
  setOutcome(hit) {
    this.outcome = hit;
    const front = this.mesh.material[4];
    if (hit) {
      front.emissive = new THREE.Color(0x1d5a2f);
      front.emissiveIntensity = 0.55;
    } else {
      front.color = new THREE.Color(0x8e8a96);
    }
    front.needsUpdate = true;
  }

  /** Hover/selection lift. Keeps the tilt so it still feels like an object. */
  setHover(on) { this.targetLift = on ? 0.14 : (this.selected ? 0.20 : 0); this.targetScale = on ? 1.06 : (this.selected ? 1.04 : 1); }
  setSelected(on) { this.selected = on; this.setHover(false); }

  /** Pointer-relative tilt, -1..1 on each axis. */
  aimAt(nx, ny) { this.targetPointerTilt.set(nx, ny); }

  /** The score pop: a hard punch out, a soft settle back. */
  pop() { this.popT = 0.0001; }

  /**
   * Flip to face up (or down). Arcs the card upward through the turn so it
   * reads as a physical motion rather than a texture swap.
   */
  flip(faceUp = true, dur = 0.52) {
    this.faceUp = faceUp;
    this.flipFrom = this.spinY;
    this.flipTo = faceUp ? 0 : Math.PI;
    // always turn the short way, and never 0-length
    let delta = this.flipTo - this.flipFrom;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    if (Math.abs(delta) < 1e-4) delta = Math.PI;
    this.flipDelta = delta;
    this.flipT = 0;
    this.flipDur = dur;
    this.flipping = true;
  }

  update(dt, time) {
    // flip
    if (this.flipping) {
      this.flipT = clamp01(this.flipT + dt / this.flipDur);
      const e = easeInOutCubic(this.flipT);
      this.spinY = this.flipFrom + this.flipDelta * e;
      // arc: peaks at the halfway point, where the card is edge-on
      this.flipArc = Math.sin(this.flipT * Math.PI) * 0.30;
      // a touch of scale through the turn sells the perspective
      this.flipScale = 1 + Math.sin(this.flipT * Math.PI) * 0.07;
      if (this.flipT >= 1) { this.flipping = false; this.flipArc = 0; this.flipScale = 1; }
    }

    // smoothed hover state
    this.lift = damp(this.lift, this.targetLift, 14, dt);
    this.scale = damp(this.scale, this.targetScale, 14, dt);
    this.pointerTilt.x = damp(this.pointerTilt.x, this.targetPointerTilt.x, 11, dt);
    this.pointerTilt.y = damp(this.pointerTilt.y, this.targetPointerTilt.y, 11, dt);

    // score pop
    let popScale = 1, popLift = 0;
    if (this.popT > 0) {
      this.popT += dt / 0.42;
      if (this.popT >= 1) { this.popT = 0; }
      else {
        const p = this.popT;
        // fast out, elastic-ish settle
        const punch = p < 0.22 ? easeOutBack(p / 0.22, 3.2) : 1 - easeOutCubic((p - 0.22) / 0.78);
        popScale = 1 + punch * 0.17;
        popLift = punch * 0.16;
      }
    }

    // idle float — out of phase per card
    const bob = Math.sin(time * this.bobSpeed + this.phase) * this.bobAmp;
    const sway = Math.sin(time * this.bobSpeed * 0.7 + this.phase * 1.3) * 0.018;

    const g = this.group;
    g.position.set(
      this.home.x,
      this.home.y + this.lift + bob + (this.flipArc || 0) + popLift,
      this.home.z - this.lift * 0.25
    );
    // retired cards lie back on the table; active cards stand up
    const lay = this.layFlat ? -0.95 : 0;
    g.rotation.set(
      lay + this.restTilt + sway * 0.5 + this.pointerTilt.y * 0.22,
      this.spinY + this.pointerTilt.x * 0.26,
      this.restRoll + sway
    );
    const s = this.scale * (this.flipScale || 1) * popScale;
    g.scale.setScalar(s);
  }

  dispose() {
    this.mesh.geometry.dispose();
    // shared textures/materials are intentionally not disposed here
  }
}
