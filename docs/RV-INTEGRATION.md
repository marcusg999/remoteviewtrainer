# Wiring up Remote Viewing

Everything below lives in files I own. The only changes needed in files I do
**not** own are in this document.

Files added:

| File | What it is |
| --- | --- |
| `src/modes/remoteview.js` | the mode: protocol, stages, scoring, report |
| `src/ui/sketchpad.js` | pointer-event sketch surface (mouse + touch + pen) |
| `src/data/targets.js` | 48-target pool + `chooseTargetSet()` (the fair draw) |
| `src/ui/rv.css` | all styles, every selector `.rv-*` prefixed |

`remoteview.js` imports `rv.css` itself, so **no `<link>` is needed in
`index.html`** — Vite inlines it into the bundle. Nothing else in the project
imports these files, so the mode is inert until you call it.

---

## 1. What you need to change in `index.html`

Add one screen section alongside `#zener`:

```html
<section id="rv" class="screen"></section>
```

It must be a plain `.screen` (not `pass-through`): the stage UI fills it and
needs pointer events on the whole surface.

## 2. What you need to change in `src/main.js`

### a. import

```js
import { RemoteViewRun, buildRevealBlock } from './modes/remoteview.js';
```

### b. add `'rv'` to the routing list

```js
for (const id of ['title', 'zener', 'rv', 'stats']) { ... }
```

### c. replace the `toast('Remote viewing session — in build')` branch

```js
else if (dest === 'rv') startRemoteView();
```

### d. the flow itself

```js
let rvRun = null;

async function startRemoteView() {
  if (rvRun) { rvRun.dispose(); rvRun = null; }
  if (run)   { run.dispose();   run = null; }      // tear the Zener run down
  floatText.clear();

  const host = document.getElementById('rv');
  host.innerHTML = '';
  show('rv');

  rvRun = new RemoteViewRun(ctx, {});               // ctx is the one you already build
  const { coordinate } = await rvRun.begin();       // seals the target — await before mounting
  rvRun.mountUI(host);

  const rep = await rvRun.finish();                 // resolves when the viewer commits
  if (!rep) return;                                 // null means dispose() ran first
  showRemoteViewResult(rep);
}
```

`finish()` **already calls `logSession()`** with
`{mode:'rv', trials:1, hits, chance:0.2, detail:{…}}`. Do **not** log it again
in `main.js` or the career log will double-count. If you would rather own the
logging, construct with `new RemoteViewRun(ctx, { autoLog: false })` and log it
yourself from the returned report.

### e. the result modal

`report()` returns the same shape as `ZenerRun.report()` — everything
`summarize()` gives plus `mode`, `results`, `durationMs`, `proof` — so your
existing `showResult()` scaffolding mostly works. The one RV-specific piece is
the reveal; `buildRevealBlock(report)` returns a detached element with the true
target drawn large, the viewer's ideogram and sketch, and which of the target's
tags they actually named:

```js
function showRemoteViewResult(rep) {
  const body = document.getElementById('result-body');
  body.innerHTML = `
    <div class="toprow">
      <span class="chip">Remote viewing &middot; <b>1 trial</b></span>
      <span class="chip">Chance <b>20%</b></span>
      <span class="chip">Coord <b>${rep.coordinate}</b></span>
    </div>
    <h2 class="outlined">${rep.hit ? 'Hit' : 'Miss'}</h2>
    <p class="lede">${rep.hit
      ? 'You ranked the sealed target first. One trial proves nothing — the career log is where this becomes a number.'
      : `You ranked the target ${rep.rankOfTarget ? rep.rankOfTarget + 'th' : 'nowhere'} of 5.`}</p>
  `;
  body.appendChild(buildRevealBlock(rep));
  body.insertAdjacentHTML('beforeend', `
    <p class="rv-fine">
      Sealed before you started as <code>${rep.proof[0].digest}</code>.
      Salt <code>${rep.proof[0].salt}</code>, payload <code>${rep.proof[0].payload}</code>.
      Recompute <code>SHA-256(salt + ":" + payload)</code> to check it.
    </p>
    <div class="row" style="margin-top:12px">
      <button class="btn" data-act="rv-again">New coordinate</button>
      <button class="btn ghost" data-act="stats">Career log</button>
      <button class="btn ghost" data-act="menu">Menu</button>
    </div>
  `);
  document.getElementById('result').classList.add('on');
}
```

Then add `rv-again` to the existing `#result` click handler:

```js
if (act === 'rv-again') await startRemoteView();
```

### f. back button and teardown

The mode does not draw its own back button — the stage footer is Back/Next for
the stages. Add a back affordance in your `#rv` chrome (or reuse the top-bar
icon button pattern) that does:

```js
if (rvRun) { rvRun.dispose(); rvRun = null; }
floatText.clear();
show('title');
```

`dispose()` resolves a pending `finish()` with `null`, so the `await` in
`startRemoteView()` unblocks and the `if (!rep) return;` guard above handles it.

### g. keyboard

The mode installs its own `keydown` listener (digits 1–5 rank candidates, Enter
advances a stage) and removes it in `dispose()`. Your existing handler already
starts with `if (screen !== 'zener') return;`, so there is no conflict. If you
later drop that guard, note that the RV handler ignores keys typed into an
`<input>`.

### h. career log

`core/store.js` already treats `'rv'` as a 0.2-chance mode and `career('rv')`
works unchanged. Zener and RV both sit at chance 0.2, and `career()` pools only
sessions that share a chance level, so a combined `career()` call mixes them —
that is a statistically valid pool of Bernoulli(0.2) trials, but if you want
them reported separately call `career('rv')` and `career('zener')`.

---

## 3. Options you can pass

```js
new RemoteViewRun(ctx, {
  pool: TARGETS,      // default: all 48
  candidates: 5,      // changing this changes CHANCE to 1/candidates
  ideogramMs: 9000,   // the soft window on stage I
  autoLog: true,      // finish() writes to the career log
  onStage: (id, i) => {},
  stages: STAGES,     // the default stage list, exported
});
```

`?turbo=N` in the URL divides `ideogramMs`, matching how the Zener run treats
turbo. It never touches the odds.

`ctx` fields are all optional: `{ scene, particles, floatText, director, tweens,
onUpdate }`. The mode uses `particles`, `floatText` and `director` only for the
commit moment, and calls `onUpdate(snapshot)` on every stage and ranking change
if you give it one. It never adds anything to `scene`.

---

## 4. Things I deliberately did not do

- **No change to `core/` or `scene/`.** `chooseTargetSet()` is in
  `src/data/targets.js` rather than `core/rng.js` so that nothing you own had to
  move; if you would rather it lived in `core/`, it is a pure function of
  `randomInt`/`sample`/`shuffle` and moves cleanly.
- **No career-log UI for RV.** `src/ui/career.js` is yours; RV sessions will
  appear in `allSessions()` with `mode: 'rv'` and `detail` carrying the
  coordinate, target id, first choice, rank of the target, the candidate ids,
  the impression count and the digest.
- **No `tools/play.mjs` change.** The RV harness I used is a throwaway in my
  scratchpad; it serves its test page through `page.route()` on the dev server's
  own origin so it needed no project file. If you want it kept, say so and I
  will fold it into `tools/play.mjs` as a `--rv` flag.

---

## 5. Integrity notes worth keeping in the README

- The 8-digit coordinate is generated **before** the target exists, so it cannot
  encode anything about it.
- Target, decoys and display order are all sealed with SHA-256 before the
  viewer records a single impression; the salt is published in the report.
- Decoys are drawn uniformly without replacement from the pool minus the true
  target; display order is shuffled independently. First-place chance is exactly
  1/5.
- No `Math.random` anywhere that affects an outcome. The single use in
  `remoteview.js` is particle-burst jitter and is labelled.
- Nothing reads the career log before choosing a target. There is no adaptive
  difficulty.
