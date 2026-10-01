/**
 * The lab: a dim room with a felt-topped table, lit almost entirely by
 * candles. Everything here exists to make the reveal moment land — the room is
 * dark so that light has somewhere to go when the card turns.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { randomFloat } from '../core/rng.js';

/** Film grain + vignette + a slow warm/cool split. Cheap, sells the room. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uGrain: { value: 0.028 },
    uVignette: { value: 0.72 },
    uAberration: { value: 0.0016 },
    uExposure: { value: 1.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uVignette, uAberration, uExposure;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }

    void main(){
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d,d);

      // chromatic aberration grows toward the edge, like a cheap lab lens
      float a = uAberration * r2 * 4.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + d * a).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - d * a).b;

      col *= uExposure;

      // vignette
      float vig = smoothstep(1.25, 0.10, r2 * uVignette);
      col *= mix(0.58, 1.0, vig);

      // animated grain
      float g = hash(uv * vec2(1024.0, 1024.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Lab {
  constructor(canvas, quality = 'high') {
    this.quality = quality;
    this.clock = new THREE.Clock();
    this.time = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: quality !== 'low', powerPreference: 'high-performance',
      alpha: false, stencil: false,
    });
    this.renderer.setClearColor(0x05040a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05040a);
    this.scene.fog = new THREE.FogExp2(0x070510, 0.026);

    // Framing is set so the active card fills the middle third of the frame.
    // The card sits at y=0.62, z=0.35 and is 1.4 tall.
    // Table surface is y=0. The active card stands at z=-0.55, revealed cards
    // lie toward the player at z=+0.9. This angle shows both at once.
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.camera.position.set(0, 2.9, 4.05);
    this.camera.lookAt(0, 0.46, -0.15);
    this.cameraRig = { base: this.camera.position.clone(), target: new THREE.Vector3(0, 0.46, -0.15) };

    /** Portrait phones have a narrow horizontal field of view, so the card row
     *  has to be tighter and shorter or it runs off both edges. Modes read
     *  this rather than hard-coding landscape numbers. */
    this.layout = {
      portrait: false,
      tableauSpread: 0.50,
      tableauMax: 7,
      tableauScale: 0.37,
      tableauZ: 0.62,
    };

    this.candles = [];
    this._buildRoom();
    this._buildKeyLight();
    this._buildTable();
    this._buildCandles();
    this._buildPost();

    this.resize();
  }

  _buildRoom() {
    // Ambient is deliberately almost nothing — candles do the work.
    this.scene.add(new THREE.AmbientLight(0x2a2140, 0.30));

    const hemi = new THREE.HemisphereLight(0x3b2f55, 0x120c18, 0.26);
    this.scene.add(hemi);

    // back wall + side walls, far enough that fog eats them
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x17121f, roughness: 0.95, metalness: 0.0,
    });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(26, 12), wallMat);
    back.position.set(0, 3, -7.5);
    back.receiveShadow = true;
    this.scene.add(back);

    const left = new THREE.Mesh(new THREE.PlaneGeometry(18, 12), wallMat);
    left.position.set(-8.5, 3, -1); left.rotation.y = Math.PI / 2;
    this.scene.add(left);
    const right = left.clone();
    right.position.x = 8.5; right.rotation.y = -Math.PI / 2;
    this.scene.add(right);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 20),
      new THREE.MeshStandardMaterial({ color: 0x100b16, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -2.2;
    this.scene.add(floor);
  }

  _buildTable() {
    const g = new THREE.Group();

    // Green felt, the standard surface for this kind of testing.
    const feltTex = this._feltTexture();
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(11.0, 0.28, 7.6),
      new THREE.MeshStandardMaterial({
        color: 0x2f6b53, roughness: 0.9, metalness: 0.0, map: feltTex,
      })
    );
    top.position.y = -0.14;
    top.receiveShadow = true;
    g.add(top);

    // wooden rim
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(11.7, 0.34, 8.3),
      new THREE.MeshStandardMaterial({ color: 0x2e1d13, roughness: 0.7, metalness: 0.05 })
    );
    rim.position.y = -0.22;
    rim.receiveShadow = true;
    g.add(rim);

    this.table = g;
    this.scene.add(g);
    this.tableY = 0.02;
  }

  _feltTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#39785e';
    ctx.fillRect(0, 0, 512, 512);
    const img = ctx.getImageData(0, 0, 512, 512);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 26;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 3);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /**
   * A warm key above and slightly in front of the card position. Candles alone
   * leave the card face too dark to read, and an unreadable card ruins the
   * reveal — which is the whole moment this room exists to serve.
   */
  _buildKeyLight() {
    const key = new THREE.SpotLight(0xffe8c4, 48, 11, 0.74, 0.68, 1.5);
    key.position.set(0.6, 4.0, 2.6);
    key.target.position.set(0, 0.2, -0.2);
    if (this.quality === 'high') {
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.0022;
      key.shadow.camera.near = 0.5;
      key.shadow.camera.far = 12;
    }
    this.scene.add(key);
    this.scene.add(key.target);
    this.keyLight = key;

    // cool rim from behind separates the card from the dark wall
    const rim = new THREE.DirectionalLight(0x6f7ad0, 0.6);
    rim.position.set(-2.2, 2.4, -3.2);
    this.scene.add(rim);
    this.rimLight = rim;

    // low fill from the player's side; without it the revealed row goes black
    const fill = new THREE.PointLight(0xffc98a, 7.0, 7.5, 2.0);
    fill.position.set(0, 1.5, 3.1);
    this.scene.add(fill);
    this.fillLight = fill;
  }

  _buildCandles() {
    const spots = [
      { x: -2.55, z: -1.75, s: 0.80 },
      { x: 2.55, z: -1.75, s: 0.72 },
      { x: -0.10, z: -2.65, s: 0.58 },
    ];
    const waxMat = new THREE.MeshStandardMaterial({
      color: 0xcfc3a6, roughness: 0.78, emissive: 0x1a1105, emissiveIntensity: 0.14,
    });
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0xbfae8a, transparent: true, opacity: 0.72, depthWrite: false,
    });
    const glowTex = this._glowTexture();

    for (const sp of spots) {
      const grp = new THREE.Group();
      grp.position.set(sp.x, this.tableY, sp.z);

      const h = 0.85 * sp.s;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.13 * sp.s, 0.15 * sp.s, h, 16), waxMat);
      body.position.y = h / 2;
      body.castShadow = this.quality === 'high';
      grp.add(body);

      const flame = new THREE.Mesh(new THREE.SphereGeometry(0.075 * sp.s, 10, 12), flameMat);
      flame.scale.set(0.7, 1.7, 0.7);
      flame.position.y = h + 0.085 * sp.s;
      grp.add(flame);

      // additive halo: this is what makes the candle read as a light source
      // on the low tier, where the bloom pass is switched off entirely
      // the halo is deliberately modest: a candle should read as a light
      // source without out-shining the card the player is trying to read
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xd98f45, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5,
      }));
      glow.scale.setScalar(1.15 * sp.s);
      glow.position.y = flame.position.y;
      grp.add(glow);

      const light = new THREE.PointLight(0xffb45c, 5.2 * sp.s, 9, 1.85);
      light.position.y = h + 0.38;
      if (this.quality === 'high') {
        light.castShadow = true;
        light.shadow.mapSize.set(512, 512);
        light.shadow.bias = -0.004;
        light.shadow.camera.far = 12;
      }
      grp.add(light);

      this.scene.add(grp);
      this.candles.push({
        grp, light, flame, glow,
        base: 5.2 * sp.s,
        // each flame flickers on its own noise, or they pulse in lockstep and
        // the room reads as a single animated light instead of three candles
        seed: randomFloat() * 100,
        speed: 1.6 + randomFloat() * 1.4,
      });
    }
  }

  /** Soft radial falloff for the candle halo. */
  _glowTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    // The centre stop is deliberately not opaque: this sprite composites
    // additively on top of the flame mesh, and a solid core pushed the sum
    // to 255 while the card topped out at 230.
    g.addColorStop(0, 'rgba(255,224,170,0.32)');
    g.addColorStop(0.25, 'rgba(255,186,96,0.3)');
    g.addColorStop(0.6, 'rgba(255,150,60,0.11)');
    g.addColorStop(1, 'rgba(255,140,50,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  _buildPost() {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    if (this.quality !== 'low') {
      this.bloom = new UnrealBloomPass(
        new THREE.Vector2(size.x, size.y),
        this.quality === 'high' ? 0.34 : 0.26, // strength
        0.55,  // radius
        0.88   // threshold — only the flames themselves, not the lit felt
      );
      this.composer.addPass(this.bloom);
    }

    this.grade = new ShaderPass(GradeShader);
    if (this.quality === 'low') {
      this.grade.uniforms.uGrain.value = 0.03;
      this.grade.uniforms.uAberration.value = 0;
    }
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  /** Candle flicker. Driven by layered sines, which beats random jitter —
   *  real flames wander, they do not strobe. */
  _flicker(dt) {
    for (const c of this.candles) {
      const t = this.time * c.speed + c.seed;
      const n =
        Math.sin(t * 1.0) * 0.5 +
        Math.sin(t * 2.3 + 1.7) * 0.28 +
        Math.sin(t * 5.1 + 0.4) * 0.14 +
        Math.sin(t * 11.3 + 2.2) * 0.07;
      const k = 1 + n * 0.17;
      c.light.intensity = c.base * k;
      c.flame.scale.set(0.7 + n * 0.07, 1.7 + n * 0.24, 0.7 + n * 0.07);
      c.flame.position.x = Math.sin(t * 2.7) * 0.008;
      if (c.glow) {
        c.glow.scale.setScalar((0.95 + n * 0.14) * (c.base / 5.2));
        c.glow.material.opacity = 0.42 + n * 0.12;
      }
      c.light.position.x = Math.sin(t * 1.9) * 0.03;
      c.light.position.z = Math.cos(t * 2.4) * 0.03;
    }
  }

  setExposure(v) { this.grade.uniforms.uExposure.value = v; }
  setBloom(v) { if (this.bloom) this.bloom.strength = v; }

  resize() {
    const el = this.renderer.domElement;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    const portrait = h > w;
    this.layout.portrait = portrait;
    if (portrait) {
      // closer in, tighter row, fewer cards kept on the table
      this.layout.tableauSpread = 0.34;
      this.layout.tableauMax = 5;
      this.layout.tableauScale = 0.30;
      this.layout.tableauZ = 0.48;
      this.cameraRig.base.set(0, 2.52, 3.45);
      this.cameraRig.target.set(0, 0.74, -0.14);
    } else {
      this.layout.tableauSpread = 0.50;
      this.layout.tableauMax = 7;
      this.layout.tableauScale = 0.37;
      this.layout.tableauZ = 0.62;
      this.cameraRig.base.set(0, 2.95, 4.5);
      this.cameraRig.target.set(0, 0.60, -0.18);
    }
    this.onLayout?.(this.layout, this.cameraRig);
    const dprCap = this.quality === 'high' ? 2 : this.quality === 'medium' ? 1.5 : 1;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // a taller frame needs a wider vertical angle to keep the row in shot
    this.camera.fov = portrait ? 54 : 40;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    this.time += dt;
    this._flicker(dt);
    this.grade.uniforms.uTime.value = this.time;
  }

  render() { this.composer.render(); }

  dispose() {
    this.renderer.dispose();
    this.composer?.dispose?.();
  }
}
