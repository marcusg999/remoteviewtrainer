/**
 * Camera shake + push-in.
 *
 * The reference pushes the camera *in* on the big moment rather than only
 * shaking it, which is what makes the climax feel like the game leaning
 * toward you. Both live here so they compose.
 */
import * as THREE from 'three';
import { randomFloat } from '../core/rng.js';
import { clamp01, easeOutCubic, easeOutQuint, damp } from './easing.js';

export class CameraDirector {
  constructor(camera, basePos, lookAt) {
    this.camera = camera;
    this.base = basePos.clone();
    this.look = lookAt.clone();
    this.trauma = 0;        // 0..1, decays; shake is trauma^2 so small hits stay subtle
    this.seed = randomFloat() * 1000;
    this.zoom = 0;          // 0..1 push-in amount
    this.targetZoom = 0;
    this.zoomFocus = lookAt.clone();
    this.offset = new THREE.Vector3();
    this.t = 0;
    this.sway = true;
  }

  /** @param {number} amount 0..1 */
  addTrauma(amount) { this.trauma = Math.min(1, this.trauma + amount); }

  /** Push in toward `focus`. amount 0..1. */
  pushIn(amount, focus = null, speed = 6) {
    this.targetZoom = amount;
    this.zoomSpeed = speed;
    if (focus) this.zoomFocus.copy(focus);
  }
  release(speed = 3) { this.targetZoom = 0; this.zoomSpeed = speed; }

  update(dt) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.35);
    this.zoom = damp(this.zoom, this.targetZoom, this.zoomSpeed ?? 6, dt);

    // base position, pulled toward the focus point by the zoom
    const pos = this.base.clone();
    if (this.zoom > 0.001) {
      const dir = this.zoomFocus.clone().sub(pos);
      pos.addScaledVector(dir, this.zoom * 0.42);
    }

    // a very slow handheld drift keeps the frame alive between moves
    if (this.sway) {
      pos.x += Math.sin(this.t * 0.23 + this.seed) * 0.035;
      pos.y += Math.sin(this.t * 0.31 + this.seed * 1.7) * 0.022;
    }

    // shake, trauma-squared, on independent noise per axis
    const s = this.trauma * this.trauma;
    if (s > 0.0001) {
      const f = this.t * 34 + this.seed;
      pos.x += (Math.sin(f * 1.0) + Math.sin(f * 2.7 + 1.1)) * 0.5 * s * 0.22;
      pos.y += (Math.sin(f * 1.3 + 2.0) + Math.sin(f * 3.1 + 0.3)) * 0.5 * s * 0.18;
      pos.z += Math.sin(f * 1.7 + 4.0) * s * 0.1;
    }

    this.camera.position.copy(pos);

    const look = this.look.clone().lerp(this.zoomFocus, this.zoom * 0.6);
    if (s > 0.0001) {
      look.x += Math.sin(this.t * 41 + this.seed) * s * 0.05;
      look.y += Math.sin(this.t * 37 + this.seed * 2) * s * 0.04;
    }
    this.camera.lookAt(look);
    if (s > 0.0001) this.camera.rotateZ(Math.sin(this.t * 29 + this.seed) * s * 0.035);
  }
}
