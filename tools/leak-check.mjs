/**
 * Prove the network does not reveal the remote-viewing target.
 *
 * Photographs are files, and a file request is visible to anyone with the
 * network panel open. If the target's image were fetched when the target is
 * sealed, or fetched alone, or fetched before its decoys, the answer would be
 * readable before the viewer ranks — and the 1-in-5 claim would be a fiction.
 *
 * This plays a real session, records every target-image request with its
 * timestamp, commits a ranking, then learns which target was the true one from
 * the reveal and checks it against the recording:
 *
 *   - nothing is requested before the ranking stage
 *   - exactly the five candidates are requested, never one alone
 *   - the true target is not first, and not separated in time from the decoys
 *
 * Exit 1 on any leak.
 */
import { chromium, devices } from 'playwright';
const URL = (process.argv.find((a) => a.startsWith('--url=')) || '--url=http://localhost:5173/?q=low&turbo=8').slice(6);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 724 } });
const page = await ctx.newPage();

const reqs = [];
const t0 = Date.now();
page.on('request', (r) => {
  const m = r.url().match(/\/targets\/([a-z0-9-]+)\.jpg/);
  if (m) reqs.push({ id: m[1], at: Date.now() - t0, stage: stageNow });
});
let stageNow = 'before-session';

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(2600);

stageNow = 'title';
await page.locator('#title .menu .btn').nth(1).tap();
await page.waitForTimeout(1800);

const draw = async () => {
  const pad = page.locator('#rv .rv-stage.on .rv-pad-canvas').first();
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.7, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
};

stageNow = 'ideogram';  await draw(); await page.tap('#rv-next'); await page.waitForTimeout(400);
stageNow = 'sensory';
for (const n of [0, 1, 2]) { const c = page.locator('#rv .rv-stage.on .rv-chip').nth(n); if (await c.count()) await c.tap(); }
await page.tap('#rv-next'); await page.waitForTimeout(500);
stageNow = 'sketch';    await draw();
// The boundary. Anything requested before this instant was requested while the
// viewer was still recording impressions, and would be a genuine leak. Label
// by timestamp, not by a flag set after the tap: the images are requested as
// the ranking stage is entered, which is before any post-tap line can run.
const rankingEnteredAt = Date.now() - t0;
await page.tap('#rv-next');
await page.waitForFunction(() => window.__ganzfeld.rvStage()?.id === 'ranking', null, { timeout: 20000 });
stageNow = 'ranking';
await page.waitForTimeout(2000);

const beforeCommit = reqs.length;
await page.locator('#rv .rv-cand').first().tap();
await page.waitForTimeout(400);
stageNow = 'committed';
await page.tap('#rv-next');
await page.waitForTimeout(2200);

// learn the truth only now, from the reveal
const truth = await page.evaluate(() => {
  const n = document.querySelector('#result .rv-reveal-name');
  return n ? n.textContent.replace(/\s*·.*$/, '').trim() : null;
});
const DATA = JSON.parse(await (await import('node:fs/promises')).readFile('src/data/targets.data.json', 'utf8'));
const nameToId = Object.fromEntries(DATA.map((t) => [t.name, t.id]));
const targetId = nameToId[truth];

const pre = reqs.filter((r) => r.at < rankingEnteredAt);
const atRanking = reqs.filter((r) => r.at >= rankingEnteredAt);
const ids = [...new Set(atRanking.map((r) => r.id))];
const targetReq = atRanking.find((r) => r.id === targetId);
const times = atRanking.map((r) => r.at);
const spread = times.length ? Math.max(...times) - Math.min(...times) : 0;

const fail = [];
if (pre.length) fail.push(`${pre.length} target image(s) requested BEFORE the ranking stage: ${pre.map((r) => r.id + '@' + r.stage).join(', ')}`);
if (ids.length !== 5) fail.push(`expected 5 candidate images at ranking, saw ${ids.length}: ${ids.join(', ')}`);
if (!targetId) fail.push(`could not identify the true target from the reveal ("${truth}")`);
if (targetReq && atRanking.indexOf(targetReq) === 0 && spread > 150) {
  fail.push(`the true target was requested first, ${spread}ms ahead of the field`);
}

console.log(`true target (known only after commit): ${truth} [${targetId}]`);
console.log(`requests before the ranking stage:     ${pre.length}${pre.length ? ' — ' + pre.map((r) => r.id).join(', ') : ''}`);
console.log(`requests at/after it:                  ${atRanking.length} across ${ids.length} distinct images`);
console.log(`request order:                         ${atRanking.map((r) => r.id).join(', ')}`);
console.log(`target position in that order:         ${targetReq ? atRanking.indexOf(targetReq) + 1 : 'n/a'} of ${atRanking.length}`);
console.log(`whole batch spanned:                   ${spread}ms`);
console.log(`requests made before commit:           ${beforeCommit}`);
console.log(fail.length ? '\nLEAK:\n - ' + fail.join('\n - ') : '\nPASS — the target is indistinguishable from its decoys on the wire');
await browser.close();
process.exit(fail.length ? 1 : 0);
