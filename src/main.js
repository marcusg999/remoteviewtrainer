/**
 * Ganzfeld — bootstrap, screen routing, and the single render loop.
 */
import * as THREE from 'three';
import { Lab } from './scene/lab.js';
import { Particles } from './juice/particles.js';
import { CameraDirector } from './juice/shake.js';
import { Tweens } from './juice/tween.js';
import { FloatText } from './ui/floatText.js';
import { ZenerRun, TRIALS, CHANCE } from './modes/zener.js';
import { RemoteViewRun, buildRevealBlock } from './modes/remoteview.js';
import { SYMBOLS, SYMBOL_LABEL, drawSymbol } from './scene/cardArt.js';
import { logSession, career, allSessions, wipe, exportJson } from './core/store.js';
import { renderCareer } from './ui/career.js';
import { summarize, verdict } from './core/stats.js';
import * as audio from './juice/audio.js';

/* ---------- quality autodetect ---------- */
const PARAMS = new URLSearchParams(location.search);
/** Animations run at this multiple of normal speed. The harness uses ?turbo=4
 *  so a full 25-trial run fits in a test budget; it never changes the odds. */
export const TURBO = Math.max(1, parseFloat(PARAMS.get('turbo') || '1'));

function detectQuality() {
  const forced = PARAMS.get('q');
  if (forced) return forced;
  const saved = localStorage.getItem('psilab.quality');
  if (saved) return saved;
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const small = Math.min(window.innerWidth, window.innerHeight) < 500;
  if (mem <= 2 || cores <= 2) return 'low';
  if (small || mem <= 4) return 'medium';
  return 'high';
}

const canvas = document.getElementById('scene');
const fxLayer = document.getElementById('fx');
const uiLayer = document.getElementById('ui');

const quality = detectQuality();
const lab = new Lab(canvas, quality);
const tweens = new Tweens();
const particles = new Particles(lab.scene, Math.min(devicePixelRatio || 1, 2));
const floatText = new FloatText(fxLayer, lab.camera);
const director = new CameraDirector(
  lab.camera,
  lab.camera.position.clone(),
  new THREE.Vector3(0, 0.62, 0.1)
);

const ctx = { scene: lab.scene, lab, particles, floatText, director, tweens, onUpdate: onRunUpdate };

// Keep the camera director in step with the layout the Lab picks on resize.
lab.onLayout = (_layout, rig) => {
  director.base.copy(rig.base);
  director.look.copy(rig.target);
  director.zoomFocus.copy(rig.target);
};
lab.resize();

let run = null;
let screen = 'title';
let sceneVisible = true;

/* ---------- DOM ---------- */
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

uiLayer.innerHTML = `
  <section id="title" class="screen on">
    <p class="sub">Institute for Parapsychology</p>
    <h1 class="outlined">GANZFELD</h1>
    <p class="blurb">
      Twenty-five cards. Five symbols. One in five by chance.<br>
      Every target is drawn from the system's cryptographic generator and
      sealed before you guess. The odds here are real, and so are your results.
    </p>
    <div class="menu">
      <button class="btn" data-go="zener">Zener Run &mdash; 25 cards</button>
      <button class="btn ghost" data-go="rv">Remote Viewing Session</button>
      <button class="btn ghost" data-go="stats">Career Log</button>
    </div>
    <p class="hint" style="margin-top:18px">Keys 1&ndash;5 &middot; or tap</p>
  </section>

  <section id="zener" class="screen pass-through">
    <div class="topbar">
      <button class="iconbtn" id="z-back" title="Back">&#8592;</button>
      <div class="stat"><div class="k">Trial</div><div class="v t-mono" id="z-trial">0<small>/25</small></div></div>
      <div class="stat" id="z-hits-box"><div class="k">Hits</div><div class="v t-mono" id="z-hits">0<small>/5</small></div></div>
      <div class="stat" id="z-z-box"><div class="k">z-score</div><div class="v t-mono" id="z-z">&mdash;</div></div>
      <div class="stat"><div class="k">Streak</div><div class="v t-mono" id="z-streak">0</div></div>
      <button class="iconbtn" id="z-mute" title="Sound">&#9834;</button>
    </div>
    <div class="pips" id="z-pips"></div>
    <div class="spacer"></div>
    <p class="hint" id="z-hint">Name the card before it turns</p>
    <div class="picker" id="z-picker"></div>
  </section>

  <section id="rv" class="screen"></section>

  <section id="stats" class="screen"></section>

  <div class="modal" id="result"><div class="card-panel" id="result-body"></div></div>
`;

/* ---------- symbol picker ---------- */
const picker = document.getElementById('z-picker');
SYMBOLS.forEach((sym, i) => {
  const b = el('button', 'sym');
  b.dataset.sym = sym;
  b.setAttribute('aria-label', SYMBOL_LABEL[sym]);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const cx = c.getContext('2d');
  cx.strokeStyle = '#f5ecd9'; cx.fillStyle = '#f5ecd9';
  drawSymbolLight(cx, sym, 64, 64, 92);
  b.appendChild(c);
  b.appendChild(el('span', 'key', String(i + 1)));
  b.addEventListener('click', () => submitGuess(sym));
  b.addEventListener('pointerenter', () => { if (audio.ready()) audio.sfxHover(); });
  picker.appendChild(b);
});

/** The picker icons are light-on-dark, so they need their own ink colour. */
function drawSymbolLight(ctx, sym, cx, cy, size) {
  ctx.save();
  ctx.translate(cx, cy); ctx.translate(-cx, -cy);
  const prev = ctx.strokeStyle;
  drawSymbol(ctx, sym, cx, cy, size);
  // repaint with light ink using composite trick
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#f5ecd9';
  ctx.fillRect(0, 0, 128, 128);
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = prev;
  ctx.restore();
}

/* ---------- screen routing ---------- */
function show(name) {
  screen = name;
  for (const id of ['title', 'zener', 'rv', 'stats']) {
    document.getElementById(id).classList.toggle('on', id === name);
  }
  if (name === 'stats') renderStats();
  // The writing screens cover the canvas completely, so stop drawing the lab
  // behind them. It saves a phone's battery and keeps the main thread free
  // for the actual input the player is giving.
  sceneVisible = (name === 'title' || name === 'zener');
}

uiLayer.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (!go) return;
  audio.unlock(); audio.startAmbient();
  const dest = go.dataset.go;
  if (dest === 'zener') startZener();
  else if (dest === 'stats') show('stats');
  else if (dest === 'rv') startRemoteView();
});

document.getElementById('z-back').addEventListener('click', () => {
  teardownRuns();
  show('title');
});
document.getElementById('z-mute').addEventListener('click', (e) => {
  audio.unlock();
  const m = !audio.isMuted();
  audio.setMuted(m);
  e.currentTarget.innerHTML = m ? '&#128263;' : '&#9834;';
});

/* ---------- zener flow ---------- */
async function startZener() {
  teardownRuns();
  run = new ZenerRun(ctx, { closedDeck: false });
  onRunUpdate(run.snapshot());
  buildPips();
  show('zener');
  await run.nextTrial();
  setPickerEnabled(true);
}

function setPickerEnabled(on) {
  picker.querySelectorAll('.sym').forEach((b) => { b.style.pointerEvents = on ? 'auto' : 'none'; b.style.opacity = on ? '1' : '.55'; });
}

async function submitGuess(sym) {
  if (!run || run.busy || run.finished || !run.active) return;
  audio.unlock();
  setPickerEnabled(false);
  const picked = picker.querySelector(`[data-sym="${sym}"]`);
  picked?.classList.add('sel');
  const res = await run.guess(sym);
  picked?.classList.remove('sel');
  if (!res) { setPickerEnabled(true); return; }
  if (res.done) { await finishZener(); return; }
  await run.nextTrial();
  setPickerEnabled(true);
}

function buildPips() {
  const p = document.getElementById('z-pips');
  p.innerHTML = '';
  for (let i = 0; i < TRIALS; i++) p.appendChild(el('span', 'pip'));
}

function onRunUpdate(s) {
  document.getElementById('z-trial').innerHTML = `${s.index}<small>/${TRIALS}</small>`;
  document.getElementById('z-hits').innerHTML = `${s.hits}<small>/${Math.round(TRIALS * CHANCE)}</small>`;
  document.getElementById('z-streak').textContent = s.streak;
  const zEl = document.getElementById('z-z');
  zEl.textContent = s.index >= 5 ? (s.z >= 0 ? '+' : '') + s.z.toFixed(2) : '—';
  const zBox = document.getElementById('z-z-box');
  zBox.className = 'stat' + (s.index < 5 ? '' : s.z >= 1.64 ? ' good' : s.z <= -1.64 ? ' bad' : '');
  document.getElementById('z-hits-box').className =
    'stat' + (s.hits > s.index * CHANCE ? ' hot' : '');

  const pips = document.getElementById('z-pips').children;
  for (let i = 0; i < TRIALS; i++) {
    const c = pips[i]; if (!c) continue;
    c.className = 'pip' + (i < s.results.length ? (s.results[i].hit ? ' hit' : ' miss') : i === s.results.length ? ' now' : '');
  }
}

async function finishZener() {
  const rep = run.report();
  // Per-symbol tallies feed the call-bias panel in the career log.
  const callCounts = {}, targetCounts = {}, hitCounts = {};
  for (const s of SYMBOLS) { callCounts[s] = 0; targetCounts[s] = 0; hitCounts[s] = 0; }
  for (const r of rep.results) {
    callCounts[r.guess]++;
    targetCounts[r.target]++;
    if (r.hit) hitCounts[r.target]++;
  }
  logSession({
    mode: rep.mode, trials: TRIALS, hits: rep.hits, chance: CHANCE,
    detail: { bestStreak: rep.bestStreak, durationMs: rep.durationMs, callCounts, targetCounts, hitCounts },
  });
  audio.sfxResult(rep.z);
  director.addTrauma(rep.z >= 1.64 ? 0.5 : 0.15);
  if (rep.z >= 1.64) {
    particles.burst(new THREE.Vector3(0, 1.0, 0), {
      count: 120, speed: 4.4, spread: 2.0, size: 13, life: 1.5,
      colors: [0x49d17c, 0xe8a33d, 0xfff0cf, 0x2b9ae8],
    });
  }
  showResult(rep);
}

function showResult(rep) {
  const v = verdict(rep);
  const body = document.getElementById('result-body');
  const pct = (rep.rate * 100).toFixed(1);
  const proofLine = rep.proof?.[0];
  body.innerHTML = `
    <div class="toprow">
      <span class="chip">Zener &middot; <b>25 trials</b></span>
      <span class="chip">Chance <b>20%</b></span>
    </div>
    <h2 class="outlined">${rep.hits} of 25</h2>
    <p class="lede">Chance expects ${rep.expected.toFixed(0)}. You are ${rep.direction === 'exact' ? 'exactly at' : rep.direction === 'hitting' ? 'above' : 'below'} it.</p>

    <div class="bigscore">
      <div class="pill a t-mono">${rep.hits}</div>
      <div class="x">of</div>
      <div class="pill b t-mono">25</div>
    </div>

    <div class="verdict ${v.tone}">${v.label}</div>

    <div class="statgrid">
      <div class="cell"><div class="k">Hit rate</div><div class="v">${pct}%</div></div>
      <div class="cell"><div class="k">z-score</div><div class="v">${rep.z >= 0 ? '+' : ''}${rep.z.toFixed(2)}</div></div>
      <div class="cell"><div class="k">Exact p (1-tail)</div><div class="v">${fmtP(rep.pExact)}</div></div>
      <div class="cell"><div class="k">Best streak</div><div class="v">${rep.bestStreak}</div></div>
      <div class="cell"><div class="k">95% CI on rate</div><div class="v">${(rep.ci.lo * 100).toFixed(0)}–${(rep.ci.hi * 100).toFixed(0)}%</div></div>
      <div class="cell"><div class="k">Effect size</div><div class="v">${rep.effect >= 0 ? '+' : ''}${rep.effect.toFixed(2)}</div></div>
    </div>

    <div class="row">
      <button class="btn" data-act="again">Run again</button>
      <button class="btn ghost" data-act="stats">Career log</button>
      <button class="btn ghost" data-act="menu">Leave</button>
    </div>

    <div class="fineprint">
      <b>Pre-registered.</b> Each target was drawn from <code>crypto.getRandomValues</code>
      and sealed with SHA-256 before your guess was accepted. Trial 1 digest:
      <code>${proofLine ? proofLine.digest.slice(0, 32) + '…' : 'n/a'}</code>
      — salt <code>${proofLine ? proofLine.salt : 'n/a'}</code>, payload <code>${proofLine ? proofLine.payload : 'n/a'}</code>.
      Recompute <code>SHA-256(salt + ":" + payload)</code> to confirm the card could not have changed after you chose.
      ${rep.pNote ? `<br><br><b>Note.</b> ${rep.pNote}` : ''}
    </div>
  `;
  document.getElementById('result').classList.add('on');
}

document.getElementById('result').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  document.getElementById('result').classList.remove('on');
  const act = a.dataset.act;
  if (act === 'again') await startZener();
  else if (act === 'rv-again') await startRemoteView();
  else if (act === 'stats') { teardownRuns(); show('stats'); }
  else { teardownRuns(); show('title'); }
});

function fmtP(p) {
  if (p == null) return '—';
  if (p < 0.0001) return '< .0001';
  return p.toFixed(4).replace(/^0/, '');
}

/* ---------- remote viewing flow ---------- */
let rvRun = null;

async function startRemoteView() {
  teardownRuns();
  const host = document.getElementById('rv');
  host.innerHTML = '';
  show('rv');

  rvRun = new RemoteViewRun(ctx, {});
  // begin() seals the target before any UI exists, so nothing the viewer can
  // touch has been shown before the commitment is made.
  await rvRun.begin();
  rvRun.mountUI(host);

  const rep = await rvRun.finish();
  if (!rep) return;              // dispose() ran first
  showRemoteViewResult(rep);
}

function showRemoteViewResult(rep) {
  const body = document.getElementById('result-body');
  const proof = rep.proof?.[0];
  body.innerHTML = `
    <div class="toprow">
      <span class="chip">Remote viewing &middot; <b>1 trial</b></span>
      <span class="chip">Chance <b>20%</b></span>
      <span class="chip">Coord <b>${rep.coordinate}</b></span>
    </div>
    <h2 class="outlined">${rep.hit ? 'Hit' : 'Miss'}</h2>
    <p class="lede">${rep.hit
      ? 'You ranked the sealed target first. One trial proves nothing on its own — the career log is where this turns into a number.'
      : `You ranked the target ${ordinal(rep.rankOfTarget)} of 5. Chance puts it first one time in five.`}</p>
  `;
  body.appendChild(buildRevealBlock(rep));
  body.insertAdjacentHTML('beforeend', `
    <div class="row" style="margin-top:14px">
      <button class="btn" data-act="rv-again">New coordinate</button>
      <button class="btn ghost" data-act="stats">Career log</button>
      <button class="btn ghost" data-act="menu">Leave</button>
    </div>
    <div class="fineprint">
      <b>Pre-registered.</b> The target and the display order of all five candidates were
      sealed before the coordinate was shown to you.
      Digest <code>${proof ? proof.digest.slice(0, 32) + '…' : 'n/a'}</code>,
      salt <code>${proof ? proof.salt : 'n/a'}</code>,
      payload <code>${proof ? proof.payload : 'n/a'}</code>.
      Recompute <code>SHA-256(salt + ":" + payload)</code> to confirm neither could have
      changed after you ranked them.
    </div>
  `);
  document.getElementById('result').classList.add('on');
}

const ordinal = (n) => (n == null ? 'nowhere' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][n] || `${n}th`);

/** Tear down whichever run is live. Both modes own scene objects. */
function teardownRuns() {
  if (run) { run.dispose(); run = null; }
  if (rvRun) { rvRun.dispose(); rvRun = null; }
  floatText.clear();
}

/* ---------- career log ---------- */
function renderStats() {
  renderCareer(document.getElementById('stats'), {
    onBack: () => show('title'),
    onPlay: () => startZener(),
  });
}

/* ---------- toast ---------- */
let toastEl = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = el('div', '');
    Object.assign(toastEl.style, {
      position: 'absolute', left: '50%', bottom: '14%', transform: 'translateX(-50%)',
      background: 'rgba(23,19,32,.96)', border: '2px solid #3a3048', borderRadius: '12px',
      padding: '11px 18px', fontWeight: '800', fontSize: '14px', pointerEvents: 'none',
      boxShadow: '0 6px 0 #0d0a14', transition: 'opacity .3s', zIndex: 50,
    });
    uiLayer.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.style.opacity = '0'; }, 2000);
}

/* ---------- input ---------- */
addEventListener('keydown', (e) => {
  if (screen !== 'zener') return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 5) { audio.unlock(); submitGuess(SYMBOLS[n - 1]); }
  if (e.key === 'Escape') document.getElementById('z-back').click();
});

// pointer-relative card tilt
addEventListener('pointermove', (e) => {
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = (e.clientY / innerHeight) * 2 - 1;
  if (run?.active) run.active.aimAt(nx * 0.5, ny * 0.4);
});

addEventListener('resize', () => lab.resize());
addEventListener('orientationchange', () => setTimeout(() => lab.resize(), 200));

/* ---------- loop ---------- */
let last = performance.now();
let frames = 0, fpsAccum = 0;
function loop(now) {
  const raw = Math.min((now - last) / 1000, 0.05);
  last = now;
  const dt = raw * TURBO;

  tweens.update(dt);
  floatText.update(dt);

  if (!sceneVisible) {
    // Nothing of the lab is on screen; skip the whole 3D pass.
    requestAnimationFrame(loop);
    return;
  }

  lab.update(dt);
  director.update(dt);
  particles.update(dt);

  if (run) {
    const t = lab.time;
    if (run.active) run.active.update(dt, t);
    for (const e of run.tableau) e.card.update(dt, t);
  }

  lab.render();

  // adaptive quality: if we are clearly missing frames, shed load once
  frames++; fpsAccum += dt;
  if (fpsAccum >= 3) {
    const fps = frames / fpsAccum;
    if (fps < 34 && lab.bloom && lab.quality !== 'low') { lab.setBloom(0.3); lab.bloom = null; }
    frames = 0; fpsAccum = 0;
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// first gesture unlocks audio anywhere on the page
const unlockOnce = () => { audio.unlock(); audio.startAmbient(); removeEventListener('pointerdown', unlockOnce); };
addEventListener('pointerdown', unlockOnce);

/**
 * Read-only test seam for the play harness, so it can wait on real state
 * instead of guessing at sleep durations. It exposes no way to set a target,
 * see one before the reveal, or influence a result.
 */
window.__ganzfeld = {
  ready: () => !!(run && !run.busy && run.active && !run.finished),
  finished: () => !!(run && run.finished),
  resultOpen: () => !!document.querySelector('#result.on'),
  index: () => (run ? run.index : -1),
  screen: () => screen,
  rvStage: () => (rvRun ? { i: rvRun.stageIndex, id: rvRun.stages[rvRun.stageIndex]?.id } : null),
  quality,
};

console.log(`[ganzfeld] quality=${quality}`);
