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
import { easeOutBack, easeOutQuint, easeOutCubic, damp, clamp01 } from '../juice/easing.js';

export const CARD_W = 1.0;
export const CARD_H = CARD_W * CARD_ASPECT;
const THICK = 0.014;

/**
 * Fraction of the flip at which the card has actually touched down.
 *
 * This was 0.78, which put the punch's peak about 100ms before the card
 * reached the table — at the peak the card was still a quarter unit in the
 * air and descending, and by the time it landed the punch had decayed away.
 * That is the same mistake as the original sin(pi*t) arc, just moved later:
 * the impulse spent on a frame where it means nothing.
 */
const LAND_AT = 0.94;

/**
 * The house punch curve, shared by the flip landing and the score pop.
 * It runs on its OWN clock rather than inside the flip's remaining fraction —
 * nesting it there gave it (1 - LAND_AT) * dur, which at 340ms was 75ms, less
 * than five frames.
 */
const PUNCH_DUR = 0.18;
const punchAt = (k) => easeOutBack(k, 3.4) * (1 - k);

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
    this.restRoll = (randomFloat() - 0.5) * 0.11;
    this.phase = randomFloat() * Math.PI * 2;
    this.bobSpeed = 0.75 + randomFloat() * 0.45;
    // Measured against the reference: its cards visibly displace on every
    // frame. At 1-2% of card height ours were technically moving and
    // perceptually still, which made the whole scene read as paused.
    this.bobAmp = 0.028 + randomFloat() * 0.018;
    this.rollPhase = randomFloat() * Math.PI * 2;
    this.rollSpeed = 0.8 + randomFloat() * 0.35;

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
    this.outcomeSet = true;   // stop the flip's brighten-into-land ramp
    const front = this.mesh.material[4];
    if (hit) {
      front.emissive = new THREE.Color(0x2fbf6a);
      front.emissiveIntensity = 0.35;
      front.color = new THREE.Color(0xffffff);
    } else {
      // pull the miss well down, so one glance reads the whole run
      front.emissive = new THREE.Color(0x000000);
      front.emissiveIntensity = 0;
      front.color = new THREE.Color(0x6e6a78);
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
   * Flip to face up (or down).
   *
   * The timing here is the whole reveal, so it is worth being precise about.
   * An earlier version used sin(pi*t) for the arc and the scale punch, which
   * peaks at t=0.5 — exactly when the card is edge-on and 1px wide. Every bit
   * of the motion happened on the frames the player cannot see, and an
   * ease-in-out spin then decelerated into the landing, so the card arrived
   * at rest height, rest scale, zero velocity. The most important moment in
   * the game eased to a stop.
   *
   * Now: the spin is front-loaded so the face crosses into view early, the
   * arc peaks after that crossing while the card is face-on, and the punch
   * happens on the LAND rather than mid-turn. `onLand` fires at that moment
   * so the reaction (shake, particles, text) can land with it.
   */
  flip(faceUp = true, dur = 0.34, onLand = null) {
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
    this.onLand = onLand;
    this.landed = false;
  }

  update(dt, time) {
    // flip
    if (this.flipping) {
      this.flipT = clamp01(this.flipT + dt / this.flipDur);
      const t = this.flipT;

      // front-loaded spin: the face crosses into view at roughly a third of
      // the duration instead of halfway through a symmetric ease
      this.spinY = this.flipFrom + this.flipDelta * easeOutQuint(t);

      // arc peaks at t~0.72, after the face is readable, not at the edge-on frame
      this.flipArc = Math.sin(Math.pow(t, 1.9) * Math.PI) * 0.30;

      // the land punch: nothing until the spin has resolved, then the card
      // slams past its rest scale and settles back
      // The face brightens into the landing. easeOutQuint finishes the spin
      // early, which otherwise leaves the card hanging with nothing happening.
      const front = this.mesh.material[4];
      if (!this.outcomeSet) {
        const glow = t < 0.45 ? 0 : t < LAND_AT
          ? (t - 0.45) / (LAND_AT - 0.45) * 0.45
          : 0.45 - ((t - LAND_AT) / (1 - LAND_AT)) * 0.27;
        front.emissive.setHex(0xffd9a0);
        front.emissiveIntensity = Math.max(0, glow);
      }

      if (t >= LAND_AT && !this.landed) {
        this.landed = true;
        this.landT = 0;          // punch starts here, on its own clock
        this.onLand?.();
      }

      if (this.flipT >= 1) {
        this.flipping = false;
        this.flipArc = 0;
        if (!this.landed) { this.landed = true; this.landT = 0; this.onLand?.(); }
      }
    }

    // land punch — runs past the end of the flip, so it gets its full window
    if (this.landT != null) {
      this.landT += dt;
      const k = clamp01(this.landT / PUNCH_DUR);
      this.flipScale = 1 + punchAt(k) * 0.14;
      if (k >= 1) { this.landT = null; this.flipScale = 1; }
    }

    // smoothed hover state
    this.lift = damp(this.lift, this.targetLift, 14, dt);
    this.scale = damp(this.scale, this.targetScale, 14, dt);
    this.pointerTilt.x = damp(this.pointerTilt.x, this.targetPointerTilt.x, 11, dt);
    this.pointerTilt.y = damp(this.pointerTilt.y, this.targetPointerTilt.y, 11, dt);

    // score pop
    let popScale = 1, popLift = 0;
    if (this.popT > 0) {
      this.popT += dt / PUNCH_DUR;
      if (this.popT >= 1) { this.popT = 0; }
      else {
        const punch = punchAt(this.popT);
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
    // an independent roll so no two cards ever sit parallel
    const roll = Math.sin(time * this.rollSpeed + this.rollPhase) * 0.03;
    g.rotation.set(
      lay + this.restTilt + sway * 0.5 + this.pointerTilt.y * 0.22,
      this.spinY + this.pointerTilt.x * 0.26,
      this.restRoll + sway + roll
    );
    const s = this.scale * (this.flipScale || 1) * popScale;
    g.scale.setScalar(s);
  }

  dispose() {
    this.mesh.geometry.dispose();
    // shared textures/materials are intentionally not disposed here
  }
}
