/**
 * Layout audit: find elements that a short viewport breaks.
 *
 * Written after .rv-evidence was reported as "stuck behind the lower
 * elements". The stage is a column flex container, the strip was itself a
 * scroll container (so its implied min-height is 0), and with the default
 * flex-shrink:1 a short screen crushed it to 18px while its children went on
 * being laid out at full size. Playing the game never showed it, because at a
 * desktop height everything fits.
 *
 * The decisive check is empirical rather than heuristic: for every candidate,
 * set flex-shrink:0, re-measure, and put it back. If the height jumps, flex
 * was squeezing it. That distinguishes a genuinely long scrolling list (which
 * does not move) from a box being crushed (which springs open).
 *
 *   node tools/layout-audit.mjs                     # dev server, default grid
 *   node tools/layout-audit.mjs --url=... --json    # any build, machine output
 *   node tools/layout-audit.mjs --only=rv-ranking   # one state
 *
 * Exit code 1 if anything is crushed, clipped or spilling.
 */
import { chromium, devices } from 'playwright';

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const URL = arg('url', 'http://localhost:5173/?q=low&turbo=8');
const ONLY = arg('only', null);
const JSON_OUT = process.argv.includes('--json');
const EXEC = arg('chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');

/** Worst-case-first. Safari's chrome can leave ~518px on a 390x844 phone. */
const VIEWPORTS = (arg('viewports', '320x480,320x568,390x518,390x620,390x724,430x844'))
  .split(',').map((s) => { const [w, h] = s.split('x').map(Number); return { w, h }; });

/* ---------- the in-page probe ---------- */
function auditPage() {
  const out = { crushed: [], spill: [], overlap: [], clippedText: [], offscreen: [], pageOverflowX: 0 };
  const sel = (el) => {
    if (el.id) return '#' + el.id;
    const c = (el.className && String(el.className).trim().split(/\s+/)[0]) || '';
    return el.tagName.toLowerCase() + (c ? '.' + c : '');
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    // an element inside a screen that is off counts as hidden
    return !el.closest('.screen:not(.on), .modal:not(.on)');
  };

  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();

    /* 1. crushed by flex: set flex-shrink:0 and see if it springs open.
          Only for a box that does NOT want to grow. A designated scroller
          (.rv-stage, .scroll) is flex-grow:1 — it is meant to absorb the
          space and scroll, and springs open under this probe for an entirely
          correct reason. The bug class is flex-grow:0 with flex-shrink:1:
          a fixed-size box being squeezed against its will, which is exactly
          what .rv-evidence was. */
    const parent = el.parentElement;
    const pcs = parent && getComputedStyle(parent);
    const inFlexColumn = pcs && pcs.display.includes('flex') && pcs.flexDirection.startsWith('column');
    const clips = cs.overflowY !== 'visible';
    const squeezedNotGrowing = cs.flexGrow === '0' && cs.flexShrink !== '0';
    if (inFlexColumn && squeezedNotGrowing && clips && el.scrollHeight - el.clientHeight > 8) {
      const before = r.height;
      const prev = el.style.flexShrink;
      el.style.flexShrink = '0';
      const after = el.getBoundingClientRect().height;
      el.style.flexShrink = prev;
      if (after - before > 12) {
        out.crushed.push({ sel: sel(el), shownPx: Math.round(before), wouldBePx: Math.round(after),
                           contentPx: el.scrollHeight, lostPx: Math.round(after - before) });
      }
    }

    /* 2. content spilling past a box that cannot be scrolled to reveal it.
          A scroller whose children stick out is just a scroller; that is what
          scrolling is. Only flag content that is permanently unreachable:
          overflow hidden, or an auto/scroll box with no scroll range. */
    const canScrollToIt = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2;
    if ((clips || cs.overflowX !== 'visible') && !canScrollToIt) {
      let worst = 0;
      for (const kid of el.children) {
        if (!vis(kid)) continue;
        const kr = kid.getBoundingClientRect();
        worst = Math.max(worst, Math.round(kr.bottom - r.bottom));
      }
      if (worst > 4) out.spill.push({ sel: sel(el), spillPx: worst, boxPx: Math.round(r.height) });
    }

    /* 3. two in-flow siblings painting over each other. "Stuck behind the
          lower elements" is literally this, so check it directly rather than
          only inferring it from a crushed box. Positioned elements are
          excluded: overlays are supposed to overlap. */
    // Pure inline boxes are excluded: an inline element's rect is the union of
    // its line boxes, so two <code> tags flowing in the same paragraph overlap
    // vertically with nothing wrong. Only block-level siblings are checked.
    const blockish = (c) => !c.display.startsWith('inline') && c.display !== 'contents';
    if ((cs.position === 'static' || cs.position === 'relative') && blockish(cs)) {
      let sib = el.nextElementSibling;
      while (sib) {
        const scs = getComputedStyle(sib);
        if (vis(sib) && (scs.position === 'static' || scs.position === 'relative') && blockish(scs)) {
          const sr = sib.getBoundingClientRect();
          const over = Math.round(Math.min(r.bottom, sr.bottom) - Math.max(r.top, sr.top));
          const sideBySide = r.right <= sr.left + 1 || sr.right <= r.left + 1;
          if (over > 4 && !sideBySide) {
            out.overlap.push({ sel: sel(el), with: sel(sib), overlapPx: over });
          }
          break;                       // the next one only
        }
        sib = sib.nextElementSibling;
      }
    }

    /* 4. a label clipped horizontally rather than wrapping. */
    if (cs.overflowX === 'hidden' && el.scrollWidth - el.clientWidth > 2 && el.children.length === 0
        && (el.textContent || '').trim()) {
      out.clippedText.push({ sel: sel(el), text: el.textContent.trim().slice(0, 32),
                             hiddenPx: el.scrollWidth - el.clientWidth });
    }

    /* 5. a control the viewport cannot reach. A scrollable ancestor makes it
          reachable, so only flag ones with no way to scroll to them. */
    if (/^(BUTTON|A|INPUT)$/.test(el.tagName) && r.width > 0) {
      const below = r.top - innerHeight;
      if (below > 0 || r.bottom < 0) {
        let scrollable = false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 4) { scrollable = true; break; }
        }
        if (!scrollable) out.offscreen.push({ sel: sel(el), text: (el.textContent || '').trim().slice(0, 28),
                                              offBy: Math.round(below > 0 ? below : -r.bottom) });
      }
    }
  }
  out.pageOverflowX = Math.max(0, document.documentElement.scrollWidth - innerWidth);
  return out;
}

/* ---------- drive the app into each state ---------- */
const drawOn = async (p, selector) => {
  const pad = p.locator(selector).first();
  await pad.scrollIntoViewIfNeeded();
  const b = await pad.boundingBox();
  if (!b) throw new Error('no pad for ' + selector);
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await p.mouse.move(cx - b.width * 0.3, cy - b.height * 0.2);
  await p.mouse.down();
  await p.mouse.move(cx + b.width * 0.3, cy + b.height * 0.2, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(350);
};

const playZenerRun = async (p) => {
  for (let i = 0; i < 25; i++) {
    await p.waitForFunction('window.__ganzfeld.ready() || window.__ganzfeld.resultOpen()', null, { timeout: 25000 });
    if (await p.evaluate(() => window.__ganzfeld.resultOpen())) return;
    await p.locator('#z-picker .sym').nth(i % 5).tap({ force: true });
    await p.waitForTimeout(140);
  }
  await p.waitForFunction('window.__ganzfeld.resultOpen()', null, { timeout: 30000 });
};

const rvToRanking = async (p) => {
  await drawOn(p, '#rv .rv-stage.on .rv-pad-canvas');
  await p.tap('#rv-next'); await p.waitForTimeout(400);
  for (const n of [0, 1, 2]) {
    const c = p.locator('#rv .rv-stage.on .rv-chip').nth(n);
    if (await c.count()) await c.tap();
  }
  await p.tap('#rv-next'); await p.waitForTimeout(500);
  await drawOn(p, '#rv .rv-stage.on .rv-pad-canvas');
  await p.tap('#rv-next'); await p.waitForTimeout(1400);
};

const STATES = {
  'title':        async () => {},
  'zener':        async (p) => { await p.locator('#title .menu .btn').nth(0).tap();
                                 await p.waitForFunction('window.__ganzfeld.ready()', null, { timeout: 25000 }); },
  'zener-result': async (p) => { await p.locator('#title .menu .btn').nth(0).tap(); await playZenerRun(p); await p.waitForTimeout(900); },
  'rv-ideogram':  async (p) => { await p.locator('#title .menu .btn').nth(1).tap(); await p.waitForTimeout(1600); },
  'rv-sensory':   async (p) => { await p.locator('#title .menu .btn').nth(1).tap(); await p.waitForTimeout(1600);
                                 await drawOn(p, '#rv .rv-stage.on .rv-pad-canvas'); await p.tap('#rv-next'); await p.waitForTimeout(500); },
  'rv-sketch':    async (p) => { await p.locator('#title .menu .btn').nth(1).tap(); await p.waitForTimeout(1600);
                                 await drawOn(p, '#rv .rv-stage.on .rv-pad-canvas'); await p.tap('#rv-next'); await p.waitForTimeout(400);
                                 await p.tap('#rv-next'); await p.waitForTimeout(500); },
  'rv-ranking':   async (p) => { await p.locator('#title .menu .btn').nth(1).tap(); await p.waitForTimeout(1600); await rvToRanking(p); },
  'rv-result':    async (p) => { await p.locator('#title .menu .btn').nth(1).tap(); await p.waitForTimeout(1600); await rvToRanking(p);
                                 await p.locator('#rv .rv-cand').first().tap(); await p.waitForTimeout(400);
                                 await p.tap('#rv-next'); await p.waitForTimeout(1800); },
  'credits':      async (p) => { await p.locator('#title .linkbtn').tap(); await p.waitForTimeout(900); },
  'stats-empty':  async (p) => { await p.locator('#title .menu .btn').nth(2).tap(); await p.waitForTimeout(900); },
  'stats-full':   async (p) => { await p.locator('#title .menu .btn').nth(0).tap(); await playZenerRun(p);
                                 await p.tap('#result [data-act="stats"]'); await p.waitForTimeout(1200); },
  'stats-zener':  async (p) => { await p.locator('#title .menu .btn').nth(0).tap(); await playZenerRun(p);
                                 await p.tap('#result [data-act="stats"]'); await p.waitForTimeout(1000);
                                 await p.locator('#stats [data-view="zener"]').tap(); await p.waitForTimeout(800); },
};

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const findings = [];
for (const vp of VIEWPORTS) {
  for (const [name, setup] of Object.entries(STATES)) {
    if (ONLY && name !== ONLY) continue;
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    try {
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForTimeout(2400);
      await page.evaluate(() => { try { localStorage.removeItem('psilab.career.v1'); } catch {} });
      await setup(page);
      await page.waitForTimeout(500);
      const r = await page.evaluate(auditPage);
      const n = r.crushed.length + r.spill.length + r.overlap.length + r.clippedText.length + r.offscreen.length + (r.pageOverflowX > 0 ? 1 : 0);
      if (n) findings.push({ viewport: `${vp.w}x${vp.h}`, state: name, ...r });
      if (!JSON_OUT) console.log(`${n ? 'FAIL' : 'ok  '}  ${String(vp.w + 'x' + vp.h).padEnd(8)} ${name.padEnd(13)} ${n ? n + ' issue(s)' : ''}`);
    } catch (e) {
      if (!JSON_OUT) console.log(`SKIP  ${String(vp.w + 'x' + vp.h).padEnd(8)} ${name.padEnd(13)} (${e.message.slice(0, 60)})`);
    }
    await ctx.close();
  }
}
await browser.close();

if (JSON_OUT) { console.log(JSON.stringify(findings, null, 1)); }
else if (findings.length) {
  console.log('\n================ FINDINGS ================');
  // group identical issues across viewports so one bug reads as one bug
  const byKey = new Map();
  for (const f of findings) {
    const add = (kind, item) => {
      const key = `${kind}|${f.state}|${item.sel ?? 'page'}`;
      const e = byKey.get(key) || { kind, state: f.state, sel: item.sel ?? 'page', viewports: [], worst: item };
      e.viewports.push(f.viewport);
      if ((item.lostPx ?? item.spillPx ?? item.overlapPx ?? item.hiddenPx ?? item.offBy ?? 0) >
          (e.worst.lostPx ?? e.worst.spillPx ?? e.worst.overlapPx ?? e.worst.hiddenPx ?? e.worst.offBy ?? 0)) e.worst = item;
      byKey.set(key, e);
    };
    f.crushed.forEach((i) => add('CRUSHED', i));
    f.spill.forEach((i) => add('SPILL', i));
    f.overlap.forEach((i) => add('OVERLAP', i));
    f.clippedText.forEach((i) => add('CLIPPED TEXT', i));
    f.offscreen.forEach((i) => add('UNREACHABLE', i));
    if (f.pageOverflowX > 0) add('PAGE SCROLLS SIDEWAYS', { px: f.pageOverflowX });
  }
  for (const e of [...byKey.values()].sort((a, b) => b.viewports.length - a.viewports.length)) {
    console.log(`\n${e.kind}  ${e.state} › ${e.sel}`);
    console.log(`  ${JSON.stringify(e.worst)}`);
    console.log(`  at ${e.viewports.join(', ')}`);
  }
}
process.exit(findings.length ? 1 : 0);
