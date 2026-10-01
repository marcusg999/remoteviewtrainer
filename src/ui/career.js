/**
 * The career log.
 *
 * The pooled figure is the only one worth reading, so it leads. Everything
 * else exists to stop the player fooling themselves: the running z-trace shows
 * how much a single lucky session moves the needle, and the call-bias panel
 * shows that the non-random thing in the room is almost always the guesser.
 */
import { career, allSessions, zTrace, wipe, exportJson } from '../core/store.js';
import { summarize, verdict, chi2Sf } from '../core/stats.js';
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
  if (trace.length < 2) return '';
  const pad = { l: 26, r: 8, t: 10, b: 16 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const zs = trace.map((p) => p.z);
  const lim = Math.max(3, Math.ceil(Math.max(...zs.map(Math.abs)) + 0.5));
  const X = (i) => pad.l + (i / (trace.length - 1)) * iw;
  const Y = (z) => pad.t + ih / 2 - (z / lim) * (ih / 2);

  const line = trace.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.z).toFixed(1)}`).join('');
  const area = `${line}L${X(trace.length - 1).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;
  const last = trace[trace.length - 1];

  // the +-1.96 band: inside it, a result is ordinary
  const band = `<rect x="${pad.l}" y="${Y(1.96).toFixed(1)}" width="${iw}" height="${(Y(-1.96) - Y(1.96)).toFixed(1)}" fill="rgba(109,100,128,.14)"/>`;

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img"
     aria-label="Running z-score across ${trace.length} sessions, currently ${last.z.toFixed(2)}">
    ${band}
    <line x1="${pad.l}" y1="${Y(0)}" x2="${w - pad.r}" y2="${Y(0)}" stroke="#4b4260" stroke-width="1"/>
    <text x="2" y="${Y(1.96) + 4}" fill="#6d6480" font-size="9" font-family="monospace">+1.96</text>
    <text x="2" y="${Y(-1.96) + 4}" fill="#6d6480" font-size="9" font-family="monospace">−1.96</text>
    <text x="2" y="${Y(0) + 4}" fill="#6d6480" font-size="9" font-family="monospace">0</text>
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

export function renderCareer(host, { onBack, onPlay }) {
  const c = career('zener');
  const sessions = c.sessions;
  const v = verdict(c);
  const trace = zTrace('zener');
  const sym = symbolStats(sessions);

  const bias = uniformityChi2(SYMBOLS.map((s) => sym.calls[s]));
  const biasP = chi2Sf(bias.chi2, bias.df);
  const totalCalls = bias.n;

  host.innerHTML = `
    <div class="topbar">
      <button class="iconbtn" data-act="back" aria-label="Back">&#8592;</button>
      <div class="stat"><div class="k">Sessions</div><div class="v t-mono">${sessions.length}</div></div>
      <div class="stat"><div class="k">Trials</div><div class="v t-mono">${c.trials}</div></div>
      <div class="stat"><div class="k">Hits</div><div class="v t-mono">${c.hits}</div></div>
      <div class="stat ${c.trials ? (c.z >= 1.96 ? 'good' : c.z <= -1.96 ? 'bad' : '') : ''}">
        <div class="k">Pooled z</div><div class="v t-mono">${c.trials ? sign(c.z) : '—'}</div></div>
    </div>

    <div class="scroll">
      <div class="sheet">
        <h2 class="outlined">Career Log</h2>
        <p class="lede">${c.empty
          ? 'No trials recorded yet. Run a Zener set and it will appear here.'
          : `Pooled across ${sessions.length} session${sessions.length === 1 ? '' : 's'} at 20% chance. The pooled figure is the one to read.`}</p>

        ${c.empty ? `<div class="row"><button class="btn" data-act="play">Run your first set</button></div>` : `
        <div class="verdict ${v.tone}">${v.label}</div>

        <div class="statgrid">
          <div class="cell"><div class="k">Hit rate</div><div class="v">${(c.rate * 100).toFixed(2)}%</div></div>
          <div class="cell"><div class="k">Expected</div><div class="v">${c.expected.toFixed(1)}</div></div>
          <div class="cell"><div class="k">z-score</div><div class="v">${sign(c.z, 3)}</div></div>
          <div class="cell"><div class="k">Exact p (1-tail)</div><div class="v">${fmtP(c.pExact)}</div></div>
          <div class="cell"><div class="k">p (2-tail)</div><div class="v">${fmtP(c.pTwoTailed)}</div></div>
          <div class="cell"><div class="k">95% CI on rate</div><div class="v">${(c.ci.lo * 100).toFixed(1)}–${(c.ci.hi * 100).toFixed(1)}%</div></div>
        </div>

        ${trace.length > 1 ? `
        <h3 class="sub-h">Running z across sessions</h3>
        <p class="sub-note">The shaded band is the ordinary range. A single lucky set moves this a long way early on and almost nothing later — that is the point of it.</p>
        <div class="chart">${zTraceSvg(trace)}</div>` : ''}

        ${sym.any ? `
        <h3 class="sub-h">Your call bias</h3>
        <p class="sub-note">How often you named each symbol, against the 20% a uniform guesser would produce. People are poor random generators, and this is usually the only non-random thing in the room.</p>
        <div class="bias">
          ${SYMBOLS.map((s) => {
            const pct = totalCalls ? (sym.calls[s] / totalCalls) * 100 : 0;
            const dev = pct - 20;
            const hitRate = sym.shown[s] ? (sym.hits[s] / sym.shown[s]) * 100 : null;
            return `<div class="bias-row">
              <img class="bias-sym" src="${symbolChip(s)}" alt="${SYMBOL_LABEL[s]}" width="22" height="22">
              <div class="bias-name">${SYMBOL_LABEL[s]}</div>
              <div class="bias-bar"><i style="width:${Math.min(100, pct * 2.5).toFixed(1)}%"></i><u style="left:50%"></u></div>
              <div class="bias-pct t-mono">${pct.toFixed(1)}%</div>
              <div class="bias-dev t-mono ${Math.abs(dev) > 4 ? 'off' : ''}">${sign(dev, 1)}</div>
              <div class="bias-hit t-mono">${hitRate == null ? '—' : hitRate.toFixed(0) + '%'}</div>
            </div>`;
          }).join('')}
          <div class="bias-head">
            <span></span><span></span><span>share of your calls</span><span></span><span>vs 20%</span><span>hit rate</span>
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
            const flag = ss.z >= 1.96 ? 'good' : ss.z <= -1.96 ? 'bad' : '';
            return `<div class="srow">
              <span class="sdate t-mono">${new Date(s.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span class="shits t-mono">${s.hits}/${s.trials}</span>
              <span class="sz t-mono ${flag}">${sign(ss.z)}</span>
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
