/**
 * GPU particle bursts: one BufferGeometry, one draw call, recycled slots.
 * Allocating meshes per burst would stutter on a phone, which is exactly when
 * the bursts fire hardest.
 */
import * as THREE from 'three';
import { randomFloat } from '../core/rng.js';

const MAX = 900;

const VERT = `
  attribute vec3 aVel;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aSpin;
  uniform float uTime;
  uniform float uPixelRatio;
  varying float vAge;
  varying vec3 vColor;
  varying float vSpin;
  void main(){
    float age = (uTime - aBirth) / aLife;
    vAge = age;
    vColor = aColor;
    vSpin = aSpin;
    if (age < 0.0 || age > 1.0) { gl_Position = vec4(2.0,2.0,2.0,1.0); gl_PointSize = 0.0; return; }
    float t = age * aLife;
    vec3 p = position + aVel * t + vec3(0.0, -2.4, 0.0) * 0.5 * t * t;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float shrink = 1.0 - age * age;
    gl_PointSize = aSize * shrink * uPixelRatio * (260.0 / -mv.z);
  }
`;

const FRAG = `
  varying float vAge;
  varying vec3 vColor;
  varying float vSpin;
  void main(){
    // square confetti, rotated — matches the reference's chunky bits
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vSpin + vAge * 9.0), s = sin(vSpin + vAge * 9.0);
    uv = mat2(c, -s, s, c) * uv;
    if (abs(uv.x) > 0.34 || abs(uv.y) > 0.34) discard;
    float a = 1.0 - smoothstep(0.65, 1.0, vAge);
    gl_FragColor = vec4(vColor, a);
  }
`;

export class Particles {
  constructor(scene, pixelRatio = 1) {
    this.n = MAX;
    this.cursor = 0;
    this.time = 0;

    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX * 3);
    const vel = new Float32Array(MAX * 3);
    const col = new Float32Array(MAX * 3);
    const birth = new Float32Array(MAX).fill(-1e9);
    const life = new Float32Array(MAX).fill(1);
    const size = new Float32Array(MAX).fill(1);
    const spin = new Float32Array(MAX);

    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1));
    g.setAttribute('aLife', new THREE.BufferAttribute(life, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aSpin', new THREE.BufferAttribute(spin, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.geo = g;
    scene.add(this.points);
  }

  /**
   * @param {THREE.Vector3} origin
   * @param {object} o { count, speed, spread, colors:[hex], size, life, up }
   */
  burst(origin, o = {}) {
    const count = o.count ?? 24;
    const speed = o.speed ?? 2.6;
    const spread = o.spread ?? 1.0;
    const colors = o.colors ?? [0xffd27f, 0xff8a5c, 0xfff2d0];
    const size = o.size ?? 9;
    const life = o.life ?? 0.9;
    const up = o.up ?? 1.4;

    const a = this.geo.attributes;
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;

      a.position.array[idx * 3 + 0] = origin.x;
      a.position.array[idx * 3 + 1] = origin.y;
      a.position.array[idx * 3 + 2] = origin.z;

      const th = randomFloat() * Math.PI * 2;
      const ph = (randomFloat() - 0.5) * spread;
      const sp = speed * (0.45 + randomFloat() * 0.85);
      a.aVel.array[idx * 3 + 0] = Math.cos(th) * Math.cos(ph) * sp;
      a.aVel.array[idx * 3 + 1] = (Math.abs(Math.sin(ph)) + up) * sp * 0.6;
      a.aVel.array[idx * 3 + 2] = Math.sin(th) * Math.cos(ph) * sp;

      const c = new THREE.Color(colors[Math.floor(randomFloat() * colors.length)]);
      a.aColor.array[idx * 3 + 0] = c.r;
      a.aColor.array[idx * 3 + 1] = c.g;
      a.aColor.array[idx * 3 + 2] = c.b;

      a.aBirth.array[idx] = this.time;
      a.aLife.array[idx] = life * (0.7 + randomFloat() * 0.6);
      a.aSize.array[idx] = size * (0.6 + randomFloat() * 0.8);
      a.aSpin.array[idx] = randomFloat() * Math.PI * 2;
    }
    for (const k of ['position', 'aVel', 'aColor', 'aBirth', 'aLife', 'aSize', 'aSpin']) {
      a[k].needsUpdate = true;
    }
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}
