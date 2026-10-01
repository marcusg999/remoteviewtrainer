/**
 * Play-test a full remote-viewing session against the real build.
 *
 * Drives every stage in order, draws on the pads, tags impressions, ranks all
 * five candidates and commits, then reads the reveal back out of the DOM.
 *
 * Usage: node tools/play-rv.mjs <outDir> [--mobile]
 *
 * Note: it waits on the mode's own stage index via the read-only test seam,
 * because under software GL the animations run far slower than wall clock.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import path from 'path';
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const mobile = process.argv.includes('--mobile');
const errors = []; let n = 0;

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'],
});
const ctx = await b.newContext(mobile
  ? { viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true, hasTouch:true }
  : { viewport:{width:1000,height:700} });
const page = await ctx.newPage();
page.on('console', m => m.type()==='error' && errors.push('CONSOLE: '+m.text()));
page.on('pageerror', e => errors.push('PAGEERROR: '+e.message));
const shot = async (nm) => page.screenshot({path: path.join(out, `${String(n++).padStart(2,'0')}-${nm}.png`)});
const stage = () => page.evaluate(()=>window.__ganzfeld?.rvStage?.());

await page.goto('http://localhost:5173/?q=low&turbo=6', { waitUntil:'networkidle' });
await page.waitForTimeout(2000);
await page.click('[data-go="rv"]');
await page.waitForSelector('#rv.on', { timeout: 20000 });
await page.waitForTimeout(1200);

const draw = async () => {
  const el = await page.$('#rv canvas:visible');
  if (!el) return false;
  const bb = await el.boundingBox(); if (!bb) return false;
  await page.mouse.move(bb.x+bb.width*0.28, bb.y+bb.height*0.5);
  await page.mouse.down();
  for (let i=0;i<16;i++) await page.mouse.move(bb.x+bb.width*(0.28+i*0.028), bb.y+bb.height*(0.5+Math.sin(i/2.2)*0.2), {steps:2});
  await page.mouse.up();
  return true;
};

// advance until we reach the ranking stage, doing the right thing at each one
for (let guard=0; guard<10; guard++) {
  const st = await stage();
  if (!st) break;
  await shot(st.id);
  if (st.id === 'ideogram' || st.id === 'sketch') { await draw(); await page.waitForTimeout(500); await shot(st.id+'-drawn'); }
  if (st.id === 'sensory') {
    const chips = await page.$$('#rv [class*="chip"]');
    for (const c of chips.slice(0,6)) await c.click({timeout:1500}).catch(()=>{});
    await page.waitForTimeout(400); await shot('sensory-tagged');
  }
  if (st.id === 'rank' || st.id === 'ranking') break;
  // Next may be gated (e.g. the ideogram's timed window); wait for it to enable
  await page.waitForFunction(()=>{const b=document.getElementById('rv-next');return b && !b.disabled;}, null, {timeout:20000}).catch(()=>{});
  await page.click('#rv-next', {timeout:5000}).catch(e=>errors.push('next click: '+e.message.split('\n')[0]));
  await page.waitForTimeout(900);
}

const st = await stage();
console.error('at stage:', JSON.stringify(st));
const cands = await page.$$('#rv .rv-cand');
console.error('candidates:', cands.length);
for (const c of cands) { await c.click({timeout:2500}).catch(e=>errors.push('cand: '+e.message.split('\n')[0])); await page.waitForTimeout(200); }
await page.waitForTimeout(500); await shot('ranked');
await page.waitForFunction(()=>{const b=document.getElementById('rv-next');return b && !b.disabled;}, null, {timeout:15000}).catch(()=>{});
await page.click('#rv-next', {timeout:5000}).catch(e=>errors.push('commit: '+e.message.split('\n')[0]));
await page.waitForFunction(()=>!!document.querySelector('#result.on'), null, {timeout:30000}).catch(()=>errors.push('WARN: result never opened'));
await page.waitForTimeout(1500);
await shot('result');

const res = await page.evaluate(()=>({
  open: !!document.querySelector('#result.on'),
  heading: document.querySelector('#result-body h2')?.textContent,
  lede: document.querySelector('#result-body .lede')?.textContent?.slice(0,160),
  revealCanvases: document.querySelectorAll('#result-body canvas').length,
  chips: [...document.querySelectorAll('#result-body .chip')].map(c=>c.textContent.replace(/\s+/g,' ').trim()),
}));
await b.close();
console.log(JSON.stringify({ errors, res }, null, 1));
