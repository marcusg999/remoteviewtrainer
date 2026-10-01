/**
 * The career log.
 *
 * The pooled figure is the only one worth reading, so it leads. Everything
 * else exists to stop the player fooling themselves: the running z-trace shows
 * how much a single lucky session moves the needle, and the call-bias panel
 * shows that the non-random thing in the room is almost always the guesser.
 */
import { career, allSessions, zTrace, wipe, exportJson } from '../core/store.js';
import { summarize, verdict, chi2Sf, MIN_TRIALS_FOR_INFERENCE } from '../core/stats.js';
import { SYMBOLS, SYMBOL_LABEL, drawSymbol } from '../scene/cardArt.js';

const fmtP = (p) => (p == null ? '—' : p < 0.0001 ? '< .0001' : p.toFixed(4).replace(/^0/, ''));
const sign = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);

/** Chi-square goodness of fit against a uniform call distribution, df = k-1. */
function uniformityChi2(counts) {
  const n = counts.reduce((a, b) => a + b, 0);
  if (!n) return { chi2: 0, df: counts.length - 1, n: 0 };
  const exp = n / counts.length;
  const chi2 = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
  return { chi2, df: counts.length - 1, n };
}

/** Running z over sessions, drawn as an SVG path with a zero line. */
function zTraceSvg(trace, w = 520, h = 112) {
  if (!trace.length) return '';
  const pad = { l: 44, r: 10, t: 12, b: 16 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const zs = trace.map((p) => p.z);
  const lim = Math.max(3, Math.ceil(Math.max(...zs.map(Math.abs)) + 0.5));
  const X = (i) => (trace.length === 1 ? pad.l + iw / 2 : pad.l + (i / (trace.length - 1)) * iw);
  const Y = (z) => pad.t + ih / 2 - (z / lim) * (ih / 2);

  const line = trace.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.z).toFixed(1)}`).join('');
  const area = trace.length === 1 ? ''
    : `${line}L${X(trace.length - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;
  const last = trace[trace.length - 1];

  // the +-1.96 band: inside it, a result is ordinary
  const band = `<rect x="${pad.l}" y="${Y(1.96).toFixed(1)}" width="${iw}" height="${(Y(-1.96) - Y(1.96)).toFixed(1)}" fill="rgba(109,100,128,.14)"/>`;

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img"
     aria-label="Running z-score across ${trace.length} sessions, currently ${last.z.toFixed(2)}">
    ${band}
    <line x1="${pad.l}" y1="${Y(0)}" x2="${w - pad.r}" y2="${Y(0)}" stroke="#4b4260" stroke-width="1"/>
    <text x="2" y="${Y(1.96) + 4}" fill="#8a8099" font-size="11" font-family="monospace">+1.96</text>
    <text x="2" y="${Y(-1.96) + 4}" fill="#8a8099" font-size="11" font-family="monospace">−1.96</text>
    <text x="2" y="${Y(0) + 4}" fill="#8a8099" font-size="11" font-family="monospace">0</text>
    <path d="${area}" fill="rgba(232,163,61,.14)"/>
    <path d="${line}" fill="none" stroke="#e8a33d" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(trace.length - 1).toFixed(1)}" cy="${Y(last.z).toFixed(1)}" r="4" fill="#e8a33d" stroke="#171320" stroke-width="2"/>
  </svg>`;
}

/** Small symbol glyph for the bias table. */
function symbolChip(sym) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  drawSymbol(ctx, sym, 32, 32, 46);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#c9a26a';
  ctx.fillRect(0, 0, 64, 64);
  return c.toDataURL();
}

/** Aggregate per-symbol calls, appearances and hits across all logged sessions. */
function symbolStats(sessions) {
  const calls = Object.fromEntries(SYMBOLS.map((s) => [s, 0]));
  const shown = Object.fromEntries(SYMBOLS.map((s) => [s, 0]));
  const hits = Object.fromEntries(SYMBOLS.map((s) => [s, 0]));
  let any = false;
  for (const s of sessions) {
    const d = s.detail || {};
    if (!d.callCounts) continue;
    any = true;
    for (const k of SYMBOLS) {
      calls[k] += d.callCounts[k] || 0;
      shown[k] += (d.targetCounts && d.targetCounts[k]) || 0;
      hits[k] += (d.hitCounts && d.hitCounts[k]) || 0;
    }
  }
  return { calls, shown, hits, any };
}

/** Which modes the log is currently pooling. Both are 1-in-5. */
const VIEWS = [
  { id: 'all', label: 'All', modes: null },
  { id: 'zener', label: 'Zener', modes: ['zener', 'zener-closed'] },
  { id: 'rv', label: 'Remote viewing', modes: ['rv'] },
];
let viewId = 'all';

export function renderCareer(host, { onBack, onPlay }) {
  // The log used to read career('zener') only, so a player could run fifty
  // remote-viewing sessions and be told "No trials recorded yet" while every
  // one of them sat in storage. Their own record was invisible.
  const view = VIEWS.find((x) => x.id === viewId) || VIEWS[0];
  const c = career(view.modes);
  const sessions = c.sessions;
  const v = verdict(c);
  const trace = zTrace(view.modes);
  const sym = symbolStats(sessions);
  // Nothing derived is shown below the inference threshold — see
  // MIN_TRIALS_FOR_INFERENCE. The verdict used to be gated on its own while
  // the grid beside it printed a hit rate and an interval regardless.
  const enough = c.trials >= MIN_TRIALS_FOR_INFERENCE;
  const counts = {
    all: allSessions().length,
    zener: allSessions().filter((s) => s.mode !== 'rv').length,
    rv: allSessions().filter((s) => s.mode === 'rv').length,
  };

  const bias = uniformityChi2(SYMBOLS.map((s) => sym.calls[s]));
  const biasP = chi2Sf(bias.chi2, bias.df);
  const totalCalls = bias.n;

  host.innerHTML = `
    <div class="topbar">
      <button class="iconbtn" data-act="back" aria-label="Back">&#8592;</button>
      <div class="stat"><div class="k">Sessions</div><div class="v t-mono">${sessions.length}</div></div>
      <div class="stat"><div class="k">Trials</div><div class="v t-mono">${c.trials}</div></div>
      <div class="stat"><div class="k">Hits</div><div class="v t-mono">${c.hits}</div></div>
    </div>

    <div class="scroll">
      <div class="sheet">
        <h2 class="outlined">Career Log</h2>
        <div class="viewtabs" role="tablist">
          ${VIEWS.map((x) => `<button class="vtab${x.id === viewId ? ' on' : ''}" data-view="${x.id}"
             role="tab" aria-selected="${x.id === viewId}">${x.label}<span class="n">${counts[x.id]}</span></button>`).join('')}
        </div>
        <p class="lede">${c.empty
          ? 'No trials recorded yet. Run a Zener set and it will appear here.'
          : `Pooled across ${sessions.length} session${sessions.length === 1 ? '' : 's'} at 20% chance. The pooled figure is the one to read.`}</p>

        ${c.empty ? `<div class="row"><button class="btn" data-act="play">Run your first set</button></div>` : `
        <div class="verdict ${v.tone}">
          <span class="vl">${v.label}</span>
          ${enough ? `<span class="vz t-mono">z ${sign(c.z)}</span>` : ''}
        </div>

        ${!enough ? `
        <div class="tooearly">
          <b class="t-mono">${c.hits} of ${c.trials}</b>
          <span>${MIN_TRIALS_FOR_INFERENCE - c.trials} more trial${MIN_TRIALS_FOR_INFERENCE - c.trials === 1 ? '' : 's'}
          before any of this means anything. A z-score and a confidence interval
          exist at this sample size and both would mislead you &mdash; one hit in one
          trial is z&nbsp;=&nbsp;+2.00 every single time.</span>
        </div>` : `
        <div class="statgrid">
          <div class="cell"><div class="k">Hit rate</div><div class="v">${(c.rate * 100).toFixed(2)}%</div></div>
          <div class="cell"><div class="k">Expected</div><div class="v">${c.expected.toFixed(1)}</div></div>
          <div class="cell"><div class="k">Exact p (1-tail)</div><div class="v">${fmtP(c.pExact)}</div></div>
          <div class="cell"><div class="k">p (2-tail)</div><div class="v">${fmtP(c.pTwoTailed)}</div></div>
          <div class="cell"><div class="k">95% CI on rate</div><div class="v">${(c.ci.lo * 100).toFixed(1)}–${(c.ci.hi * 100).toFixed(1)}%</div></div>
        </div>`}

        ${trace.length ? `
        <h3 class="sub-h">Running z across sessions</h3>
        <p class="sub-note">The shaded band is the ordinary range. A single lucky set moves this a long way early on and almost nothing later — that is the point of it.</p>
        <div class="chart">${zTraceSvg(trace)}</div>` : ''}

        ${sym.any && view.id !== 'rv' ? `
        <h3 class="sub-h">Your call bias</h3>
        <p class="sub-note">${view.id === 'all' && counts.rv ? '<b>Zener sessions only</b> &mdash; remote viewing has no symbol calls. ' : ''}How often you named each symbol, against the 20% a uniform guesser would produce. People are poor random generators, and this is usually the only non-random thing in the room.</p>
        <div class="bias">
          ${SYMBOLS.map((s) => {
            const pct = totalCalls ? (sym.calls[s] / totalCalls) * 100 : 0;
            const dev = pct - 20;
            // NB: this denominator is target APPEARANCES, not your calls —
            // "caught 1 of the 3 times Waves came up", not "right a third of
            // the time I said Waves". The column is labelled accordingly.
            const hitRate = sym.shown[s] ? (sym.hits[s] / sym.shown[s]) * 100 : null;
            return `<div class="bias-row">
              <img class="bias-sym" src="${symbolChip(s)}" alt="${SYMBOL_LABEL[s]}" width="22" height="22">
              <div class="bias-name">${SYMBOL_LABEL[s]}</div>
              <div class="bias-bar"><i class="${dev < 0 ? 'neg' : 'pos'}" style="left:${dev < 0 ? (50 - Math.min(50, Math.abs(dev) * 2.5)).toFixed(1) : 50}%;width:${Math.min(50, Math.abs(dev) * 2.5).toFixed(1)}%"></i><u style="left:50%"></u></div>
              <div class="bias-pct t-mono">${pct.toFixed(1)}%</div>
              <div class="bias-dev t-mono ${Math.abs(dev) > 4 ? 'off' : ''}">${sign(dev, 1)}</div>
              <div class="bias-hit t-mono" title="${sym.hits[s]} of the ${sym.shown[s]} times this symbol came up">${hitRate == null ? '—' : `${sym.hits[s]}/${sym.shown[s]}`}</div>
            </div>`;
          }).join('')}
          <div class="bias-head">
            <span></span><span></span><span>share of your calls</span><span></span><span>vs 20%</span><span>caught when shown</span>
          </div>
        </div>
        <p class="sub-note">
          Uniformity of your calls: &chi;&sup2; = ${bias.chi2.toFixed(2)} on ${bias.df} df, p = ${fmtP(biasP)}
          ${biasP < 0.05
            ? '— your calls are <b>not</b> uniform. That says nothing about psi; it is a fact about you.'
            : '— consistent with calling uniformly.'}
        </p>` : ''}

        <h3 class="sub-h">Sessions</h3>
        <div class="sessions">
          ${sessions.slice().reverse().slice(0, 40).map((s) => {
            const ss = summarize(s.hits, s.trials, s.chance);
            // Every 1-of-1 remote-viewing hit is exactly z = +2.00, so
            // colouring it the same green as a genuinely significant 25-trial
            // set is the precise self-deception this screen warns about.
            const small = s.trials < MIN_TRIALS_FOR_INFERENCE;
            const flag = small ? '' : ss.z >= 1.96 ? 'good' : ss.z <= -1.96 ? 'bad' : '';
            return `<div class="srow">
              <span class="sdate t-mono">${new Date(s.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span class="smode">${s.mode === 'rv' ? 'RV' : 'Z'}</span>
              <span class="shits t-mono">${s.hits}/${s.trials}</span>
              <span class="sz t-mono ${flag}">${small ? '—' : sign(ss.z)}</span>
            </div>`;
          }).join('')}
        </div>

        <p class="fineprint">
          A z of +1.96 or more turns up by chance in about 1 run in 40. Run forty sets and you
          should expect to see one; it is not evidence of anything on its own. That is why the
          pooled figure leads, and why this log cannot be edited one session at a time.
        </p>`}

        <div class="row" style="margin-top:16px">
          <button class="btn" data-act="play">New run</button>
          <button class="btn ghost small" data-act="export">Export JSON</button>
          ${c.empty ? '' : '<button class="btn ghost small" data-act="wipe">Wipe log</button>'}
        </div>
      </div>
    </div>
  `;

  host.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    viewId = b.dataset.view;
    renderCareer(host, { onBack, onPlay });
  }));
  host.querySelector('[data-act="back"]').addEventListener('click', onBack);
  host.querySelectorAll('[data-act="play"]').forEach((b) => b.addEventListener('click', onPlay));
  host.querySelector('[data-act="export"]').addEventListener('click', () => {
    const blob = new Blob([exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ganzfeld-career.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  host.querySelector('[data-act="wipe"]')?.addEventListener('click', () => {
    // No confirm() — the artifact viewer makes it return false — so this is a
    // two-step button instead.
    const b = host.querySelector('[data-act="wipe"]');
    if (b.dataset.armed) { wipe(); renderCareer(host, { onBack, onPlay }); return; }
    b.dataset.armed = '1';
    b.textContent = 'Erase everything?';
    b.classList.add('danger');
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Wipe log'; b.classList.remove('danger'); } }, 4000);
  });
}
