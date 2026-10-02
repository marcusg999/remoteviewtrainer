/**
 * Play-test harness. Drives the real build in a real browser, captures console
 * errors, screenshots key moments, and measures frame time.
 *
 * Usage: node tools/play.mjs [outDir] [--mobile] [--q=low|medium|high]
 *                             [--turbo=N] [--w=px] [--url=...]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import path from 'path';

const outDir = process.argv[2] || '/tmp/play';
const mobile = process.argv.includes('--mobile');
const urlArg = process.argv.find(a => a.startsWith('--url='));
const qArg = process.argv.find(a => a.startsWith('--q='));
const turboArg = process.argv.find(a => a.startsWith('--turbo='));
const q = qArg ? qArg.slice('--q='.length) : 'medium';
const turbo = turboArg ? turboArg.slice('--turbo='.length) : '3';
const wArg = process.argv.find(a => a.startsWith('--w='));
const vw = wArg ? Number(wArg.slice('--w='.length)) : 1280;
const URL = urlArg ? urlArg.slice('--url='.length)
  : `http://localhost:5173/?q=${q}&turbo=${turbo}`;
mkdirSync(outDir, { recursive: true });

const shots = [];
const errors = [];

const run = async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
           '--enable-webgl', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
      : { viewport: { width: vw, height: Math.round(vw * 0.625) }, deviceScaleFactor: 1 }
  );
  const page = await ctx.newPage();

  page.on('console', m => {
    if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
  });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  const shot = async (name) => {
    const p = path.join(outDir, `${String(shots.length).padStart(2, '0')}-${name}.png`);
    await page.screenshot({ path: p });
    shots.push(p);
    return p;
  };

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await shot('title');

  // WebGL sanity
  const gl = await page.evaluate(() => {
    const c = document.getElementById('scene');
    const g = c.getContext('webgl2') || c.getContext('webgl');
    return g ? { ok: true, renderer: g.getParameter(g.RENDERER) } : { ok: false };
  });

  // Enter the Zener run
  await page.click('[data-go="zener"]');
  await page.waitForTimeout(1600);
  await shot('dealt');

  // Play all 25 trials. Wait on the game's own readiness rather than fixed
  // sleeps: under software GL the animations run far slower than wall clock,
  // and pressing keys early just drops the guesses.
  const ready = () => page.waitForFunction(
    () => window.__ganzfeld?.ready() || window.__ganzfeld?.resultOpen(),
    null, { timeout: 90000 }
  );
  await ready();
  for (let i = 0; i < 25; i++) {
    if (await page.evaluate(() => window.__ganzfeld.resultOpen())) break;
    await page.keyboard.press(String(1 + (i % 5)));
    if (i === 0) { await page.waitForTimeout(Math.max(240, 620 / Number(turbo))); await shot('reveal'); }
    if (i === 8) { await page.waitForTimeout(Math.max(240, 620 / Number(turbo))); await shot('midrun'); }
    await ready().catch(() => {});
  }
  await page.waitForFunction(() => window.__ganzfeld?.resultOpen(), null, { timeout: 60000 })
    .catch(() => console.error('WARN: result modal never opened'));
  await page.waitForTimeout(1200);
  await shot('result');

  // read the reported numbers straight out of the DOM
  const result = await page.evaluate(() => {
    const t = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
    const cells = [...document.querySelectorAll('#result-body .statgrid .cell')]
      .map(c => [c.querySelector('.k').textContent, c.querySelector('.v').textContent]);
    return {
      visible: !!document.querySelector('#result.on'),
      heading: t('#result-body h2'),
      verdict: t('#result-body .verdict'),
      cells,
    };
  });

  // frame timing over 3s of idle animation
  const perf = await page.evaluate(() => new Promise(res => {
    const ts = []; let last = performance.now(); let n = 0;
    const tick = (now) => { ts.push(now - last); last = now; if (++n < 180) requestAnimationFrame(tick); else res(ts); };
    requestAnimationFrame(tick);
  }));
  const sorted = perf.slice(10).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];

  // career log
  await page.click('[data-act="stats"]').catch(() => {});
  await page.waitForTimeout(900);
  await shot('career');

  await browser.close();

  console.log(JSON.stringify({
    url: URL, mobile, gl, result,
    fps: { p50: +(1000 / p50).toFixed(1), p95low: +(1000 / p95).toFixed(1), frameP50ms: +p50.toFixed(2), frameP95ms: +p95.toFixed(2) },
    errors, shots,
  }, null, 2));
};

run().catch(e => { console.error('HARNESS FAILED:', e); process.exit(1); });
