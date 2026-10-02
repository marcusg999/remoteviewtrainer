/**
 * Hit-map: what does a tap at each point on screen ACTUALLY reach?
 *
 * Written after a bug that four passes of ordinary play-testing missed. The
 * screens are stacked absolutely and were hidden with opacity:0 plus
 * pointer-events:none on the container — but pointer-events does not lock a
 * subtree, and `.btn` sets pointer-events:auto, so every button on every
 * hidden screen stayed hit-testable on top of the visible one. On the Zener
 * screen, after one completed run, the dismissed result modal's "Leave"
 * button sat directly above the middle symbol and nothing else:
 *
 *     "Leave"        x 149-240, y 572-612   -> teardownRuns(); show('title')
 *     middle symbol  x 164-226, y 648-710
 *
 * So pressing the middle symbol kicked the player out to the home screen,
 * and only the middle one, and only after a run had been completed. Nothing
 * about the guess path was wrong; the tap never got there.
 *
 * This walks a grid over the viewport, asks document.elementFromPoint what is
 * really on top, and fails if any point on a playable screen resolves to a
 * control belonging to a screen that is not the current one.
 *
 *   node tools/hitmap.mjs                       # dev server, default viewport
 *   node tools/hitmap.mjs --url=... --h=664     # any build, any height
 *   node tools/hitmap.mjs --print               # also draw the map
 *
 * Exit code 1 if any tap is stolen, so it can gate a release.
 */
import { chromium, devices } from 'playwright';

const arg = (name, dflt) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};
const URL = arg('url', 'http://localhost:5173/?q=low&turbo=8');
const WIDTH = Number(arg('w', 390));
const HEIGHTS = arg('h', '724,664,620').split(',').map(Number);
const PRINT = process.argv.includes('--print');
const EXEC = arg('chrome', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');

const browser = await chromium.launch({
  executablePath: EXEC,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failures = 0;

for (const height of HEIGHTS) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: WIDTH, height } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2400);

  // The state that matters: one run completed and left, so the result modal
  // exists. On a fresh page the modal is empty and the map looks clean —
  // which is exactly why this was missed for so long.
  await page.locator('#title .menu .btn').nth(0).tap();
  for (let i = 0; i < 25; i++) {
    await page.waitForFunction('window.__ganzfeld.ready() || window.__ganzfeld.resultOpen()', null, { timeout: 25000 });
    if (await page.evaluate(() => window.__ganzfeld.resultOpen())) break;
    await page.locator('#z-picker .sym').nth(i % 5).tap({ force: true });
    await page.waitForTimeout(140);
  }
  await page.waitForFunction('window.__ganzfeld.resultOpen()', null, { timeout: 30000 });
  await page.tap('#result [data-act="menu"]');
  await page.waitForTimeout(1000);
  await page.locator('#title .menu .btn').nth(0).tap();
  await page.waitForFunction('window.__ganzfeld.ready()', null, { timeout: 20000 });

  const map = await page.evaluate(() => {
    const rows = [];
    const stolen = [];
    for (let y = 4; y < innerHeight; y += 8) {
      let line = '';
      for (let x = 6; x < innerWidth; x += 13) {
        const el = document.elementFromPoint(x, y);
        if (!el) { line += '.'; continue; }
        const act = el.closest?.('[data-act]');
        const go = el.closest?.('[data-go]');
        let ch;
        if (act) { ch = 'X'; stolen.push({ x, y, what: `modal button data-act="${act.dataset.act}" ("${act.textContent.trim()}")` }); }
        else if (go) { ch = 'X'; stolen.push({ x, y, what: `title button data-go="${go.dataset.go}" ("${go.textContent.trim()}")` }); }
        else if (el.closest?.('#z-picker .sym')) ch = '#';
        else if (el.closest?.('#z-back')) ch = 'B';
        else if (el.closest?.('#z-mute')) ch = 'M';
        else if (el.id === 'scene') ch = ' ';
        else ch = '-';
        line += ch;
      }
      rows.push(String(y).padStart(4) + ' ' + line);
    }
    const sym = [...document.querySelectorAll('#z-picker .sym')].map((b) => {
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    });
    return { rows, stolen, sym, innerHeight };
  });

  if (PRINT) {
    console.log(`\n--- ${WIDTH}x${map.innerHeight}  (# symbol, B back, M mute, X STOLEN, - page, ' ' canvas)`);
    console.log(map.rows.join('\n'));
  }

  if (!map.stolen.length) {
    console.log(`PASS  ${WIDTH}x${map.innerHeight}  every tap reaches the screen it looks like it should`);
  } else {
    failures++;
    const byWhat = new Map();
    for (const s of map.stolen) {
      const e = byWhat.get(s.what) || { xs: [], ys: [] };
      e.xs.push(s.x); e.ys.push(s.y); byWhat.set(s.what, e);
    }
    console.log(`FAIL  ${WIDTH}x${map.innerHeight}  ${map.stolen.length} points are stolen by controls on hidden screens:`);
    for (const [what, e] of byWhat) {
      console.log(`        ${what}`);
      console.log(`          covers x ${Math.min(...e.xs)}-${Math.max(...e.xs)}, y ${Math.min(...e.ys)}-${Math.max(...e.ys)}`);
      map.sym.forEach((s, i) => {
        const over = Math.min(...e.xs) <= s.right && Math.max(...e.xs) >= s.x
                  && Math.min(...e.ys) <= s.bottom && Math.max(...e.ys) >= s.y;
        if (over) console.log(`          OVERLAPS symbol ${i + 1} (x ${s.x}-${s.right}, y ${s.y}-${s.bottom})`);
      });
    }
  }
  await ctx.close();
}

await browser.close();
process.exit(failures ? 1 : 0);
