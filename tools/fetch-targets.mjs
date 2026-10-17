/**
 * Build the remote-viewing target pool from real places.
 *
 * Every image is fetched from Wikimedia Commons and accepted ONLY if its
 * licence permits redistribution without attribution burden we cannot meet in
 * a static build: public domain, PD-old, or CC0. Anything else is rejected and
 * reported, so the pool can never quietly acquire an image we are not allowed
 * to ship. The licence and author of every accepted file are written to
 * targets.licence.json beside the images.
 *
 * Images are normalised hard — same crop, same size, same treatment. That is
 * not cosmetic. Five candidates drawn from real photographs differ in ways
 * that have nothing to do with their content (grading, time of day, people in
 * frame, resolution), and a viewer who latches onto those scores hits for the
 * wrong reason. Normalising removes the cue that would otherwise inflate the
 * hit rate.
 *
 *   node tools/fetch-targets.mjs            # fetch, vet, normalise
 *   node tools/fetch-targets.mjs --dry      # resolve and vet only
 *   node tools/fetch-targets.mjs --limit=3  # trial run
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const UA = 'GanzfeldTargetBuilder/1.0 (https://github.com/marcusg999/remoteviewtrainer; marcusgraydev@gmail.com)';
const API = 'https://commons.wikimedia.org/w/api.php';
const OUT = 'public/targets';
const DRY = process.argv.includes('--dry');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || Infinity;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7) || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Licences we may redistribute, best first. Public domain and CC0 carry no
 * obligation at all; CC BY needs credit; CC BY-SA needs credit and makes the
 * normalised copy share-alike too. We take the best licence available for each
 * place rather than the first match, so the pool is as unencumbered as the
 * commons allows, and every choice is recorded in targets.licence.json.
 */
const LICENCE_RANK = [
  [/^(cc0|public domain|pd-old|pd-us|pd-art|pd-self|pd|no restrictions)/i, 0],
  [/^cc[ -]by[ -]?[0-9.]*$/i, 1],
  [/^cc[ -]by[ -]sa/i, 2],
];
const rankLicence = (lic) => {
  for (const [re, rank] of LICENCE_RANK) if (re.test(lic)) return rank;
  return -1;                                      // not redistributable here
};

/**
 * Reject anything that is not a photograph.
 *
 * Ranking by licence first poisoned the first pool: public-domain media skews
 * heavily to old engravings, lithographs, architectural plans and historic
 * black-and-white, because that is what has fallen out of copyright. The pool
 * came back with a 19th-century engraving of the Brooklyn Bridge, a blueprint
 * of a Chicago railcar and a watercolour of a Venice canal sitting beside
 * modern colour photographs.
 *
 * That is not merely ugly. Five candidates where one is an engraving and four
 * are photographs hand the viewer a cue that has nothing to do with the
 * target's content, and a hit scored on that cue inflates the rate. Medium
 * consistency therefore outranks licence convenience: photo-ness is the
 * primary sort, licence only breaks ties.
 */
const NOT_A_PHOTO = /(engraving|lithograph|drawing|sketch|etching|woodcut|painting|watercolou?r|illustration|map |plan of|blueprint|diagram|schematic|poster|postcard|stamp|coin|logo|coat of arms|seal of|\bart\b|print of|collage|montage|composite|banner|infobox|^File:PD)/i;
const CATEGORY_NOT_A_PHOTO = /(engravings|lithographs|drawings|sketches|paintings|illustrations|maps|plans|diagrams|blueprints|posters|postcards|prints|artworks|collages|photomontages|black[- ]and[- ]white photographs|historical images)/i;

async function api(params, tries = 0) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (res.status === 429 || res.status === 503) {
    if (tries > 5) throw new Error(`rate limited after ${tries} tries`);
    await sleep(4000 * (tries + 1));
    return api(params, tries + 1);
  }
  const text = await res.text();
  if (!text.trim().startsWith('{')) {
    if (tries > 5) throw new Error('non-JSON: ' + text.slice(0, 80));
    await sleep(5000 * (tries + 1));
    return api(params, tries + 1);
  }
  return JSON.parse(text);
}

const plain = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/**
 * A Wikipedia article's lead image is a far better answer to "a representative
 * photograph of this place" than a Commons full-text search, which matches
 * file descriptions and happily returned an antique luggage label for the Dead
 * Sea and a sepia tram for the Chicago Loop. So the article image is tried
 * first and the search is kept only as a fallback.
 */
async function wikipediaLead(place) {
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2',
    titles: place.wiki || place.name, prop: 'pageimages', piprop: 'original', redirects: '1',
  });
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return null;
  const j = await res.json();
  const src = j.query?.pages?.[0]?.original?.source;
  if (!src) return null;
  // the API appends ?utm_source=... to this URL; strip it before the basename
  const bare = src.split('?')[0];
  const file = decodeURIComponent(bare.split('/').pop().replace(/^\d+px-/, ''));
  return 'File:' + file.replace(/_/g, ' ');
}

/** Licence + metadata for named Commons files, best-of ranked like the search. */
async function vet(place, titles) {
  if (!titles.length) return [];
  const info = await api({
    action: 'query', titles: titles.join('|'),
    prop: 'imageinfo|categories', cllimit: '40',
    iiprop: 'url|size|extmetadata', iiurlwidth: '900',
  });
  const pages = info.query?.pages || [];
  const usable = [];
  titles.forEach((title, searchRank) => {
    const p = pages.find((x) => x.title === title);
    const ii = p?.imageinfo?.[0];
    if (!ii) return;
    const m = ii.extmetadata || {};
    const lic = plain(m.LicenseShortName?.value) || plain(m.License?.value);
    const rank = rankLicence(lic);
    if (rank < 0) return;
    if (ii.width < 800 || ii.height < 500) return;
    const cats = [plain(m.Categories?.value), ...(p.categories || []).map((c) => c.title)].join(' ');
    if (NOT_A_PHOTO.test(title) || CATEGORY_NOT_A_PHOTO.test(cats)) return;
    usable.push({
      place, title, notPhoto: 0,
      url: ii.thumburl || ii.url, descriptionUrl: ii.descriptionurl,
      licence: lic, author: plain(m.Artist?.value) || 'unknown', credit: plain(m.Credit?.value) || '',
      width: ii.width, height: ii.height, rank, searchRank,
    });
  });
  return usable;
}

/** Search Commons for a place, return the first file we are allowed to ship. */
async function resolve(place) {
  // the article's own lead image first
  try {
    const lead = await wikipediaLead(place);
    if (lead) {
      await sleep(700);
      const vetted = await vet(place, [lead]);
      if (vetted.length) return { place, candidates: vetted, via: 'wikipedia' };
    }
  } catch (e) { console.log(`\n    (wikipedia lead failed: ${e.message}; falling back to search)`); }
  await sleep(700);

  const search = await api({
    action: 'query', list: 'search', srnamespace: '6', srlimit: '12',
    srsearch: `${place.query} filetype:bitmap`,
  });
  const titles = (search.query?.search || []).map((s) => s.title)
    .filter((t) => /\.(jpe?g|png)$/i.test(t));
  if (!titles.length) return { place, error: 'no files found' };
  await sleep(900);

  const info = await api({
    action: 'query', titles: titles.join('|'),
    prop: 'imageinfo|categories', cllimit: '40',
    iiprop: 'url|size|extmetadata', iiurlwidth: '900',
  });
  const pages = info.query?.pages || [];
  const rejected = [];
  const usable = [];
  titles.forEach((title, searchRank) => {             // keep search ranking
    const p = pages.find((x) => x.title === title);
    const ii = p?.imageinfo?.[0];
    if (!ii) return;
    const m = ii.extmetadata || {};
    const lic = plain(m.LicenseShortName?.value) || plain(m.License?.value);
    const rank = rankLicence(lic);
    if (rank < 0) { rejected.push(`${title} [${lic || 'unknown'}]`); return; }
    if (ii.width < 800 || ii.height < 500) { rejected.push(`${title} [too small]`); return; }
    const cats = [plain(m.Categories?.value), ...(p.categories || []).map((c) => c.title)].join(' ');
    const notPhoto = (NOT_A_PHOTO.test(title) || CATEGORY_NOT_A_PHOTO.test(cats)) ? 1 : 0;
    if (notPhoto) { rejected.push(`${title} [not a photograph]`); return; }
    usable.push({
      place, title, notPhoto,
      url: ii.thumburl || ii.url,
      descriptionUrl: ii.descriptionurl,
      licence: lic,
      author: plain(m.Artist?.value) || 'unknown',
      credit: plain(m.Credit?.value) || '',
      width: ii.width, height: ii.height,
      rank, searchRank,
    });
  });
  if (!usable.length) return { place, error: 'no redistributable file', rejected: rejected.slice(0, 4) };
  // photo-ness first, then licence, then the search ranking
  usable.sort((a, b) => a.notPhoto - b.notPhoto || a.rank - b.rank || a.searchRank - b.searchRank);
  return { place, candidates: usable, via: 'search' };
}

/**
 * One treatment for every image: 4:3 centre crop, 480x360, mild desaturation
 * and a matched contrast curve, metadata stripped. Identical for all, so no
 * photo stands out for a reason unrelated to what it shows.
 */
/**
 * Mean saturation, 0..1. Historic black-and-white and sepia plates survive the
 * title and category filters but are just as much of a style cue as an
 * engraving, so they are measured out of the pool here.
 */
async function colourfulness(file) {
  const { stdout } = await run('convert', [file, '-colorspace', 'HSL', '-format', '%[fx:mean.g]', 'info:']);
  return Number(stdout.trim()) || 0;
}
const MIN_SATURATION = 0.13;

async function normalise(src, dest) {
  await run('convert', [
    src,
    '-auto-orient',
    '-resize', '480x360^',
    '-gravity', 'center', '-extent', '480x360',
    '-modulate', '100,88,100',
    '-brightness-contrast', '-2x6',
    '-strip', '-interlace', 'Plane', '-quality', '78',
    dest,
  ]);
}

const PLACES = JSON.parse(await readFile(new URL('./target-places.json', import.meta.url), 'utf8'));

await mkdir(OUT, { recursive: true });
const manifest = [];
const failures = [];
let n = 0;
for (const place of PLACES) {
  if (ONLY && place.id !== ONLY) continue;
  if (n >= LIMIT) break;
  n++;
  process.stdout.write(`[${String(n).padStart(2)}/${Math.min(PLACES.length, LIMIT)}] ${place.id} … `);
  try {
    const found = await resolve(place);
    if (found.error) {
      console.log(`SKIP (${found.error})${found.rejected ? ' — tried: ' + found.rejected.join(', ') : ''}`);
      failures.push({ id: place.id, ...found, place: undefined });
      await sleep(1100);
      continue;
    }
    // Walk the ranked candidates until one survives the colour check. A single
    // best guess is not enough: the filters catch the medium, not whether the
    // particular file happens to be a faded plate.
    let accepted = null;
    const tried = [];
    for (const r of found.candidates.slice(0, 6)) {
      const tmp = `${OUT}/.tmp-${place.id}`;
      try {
        const res = await fetch(r.url, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error('http ' + res.status);
        await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
        const sat = await colourfulness(tmp);
        if (sat < MIN_SATURATION) { tried.push(`${r.title} [monochrome ${sat.toFixed(2)}]`); await run('rm', ['-f', tmp]); await sleep(700); continue; }
        if (!DRY) await normalise(tmp, `${OUT}/${place.id}.jpg`);
        await run('rm', ['-f', tmp]);
        accepted = { ...r, saturation: sat };
        break;
      } catch (e) {
        tried.push(`${r.title} [${e.message}]`);
        await run('rm', ['-f', tmp]).catch(() => {});
        await sleep(700);
      }
    }
    if (!accepted) {
      console.log(`SKIP (no usable image) — tried: ${tried.join(', ')}`);
      failures.push({ id: place.id, error: 'no usable image', tried });
      await sleep(1100);
      continue;
    }
    const r = accepted;
    manifest.push({
      id: place.id, name: place.name, lat: place.lat, lon: place.lon,
      tags: place.tags, describe: place.describe,
      source: { title: r.title, page: r.descriptionUrl, licence: r.licence, author: r.author, credit: r.credit },
    });
    console.log(`ok  [${r.licence}] sat=${r.saturation.toFixed(2)} via ${found.via}${tried.length ? '  (skipped ' + tried.length + ')' : ''}`);
  } catch (e) {
    console.log('FAIL ' + e.message);
    failures.push({ id: place.id, error: e.message });
  }
  await sleep(1100);
}

if (ONLY && existsSync(`${OUT}/targets.licence.json`)) {
  const prev = JSON.parse(await readFile(`${OUT}/targets.licence.json`, 'utf8'));
  const keep = (prev.images || []).filter((i) => i.id !== ONLY);
  manifest.unshift(...keep.map((i) => ({ id: i.id, name: i.name, source: i })));
}
await writeFile(`${OUT}/targets.licence.json`, JSON.stringify({
  note: 'Every image below is redistributable: public domain / CC0, CC BY, or CC BY-SA. '
      + 'CC BY and CC BY-SA entries require the credit shown; CC BY-SA additionally makes the '
      + 'cropped and graded copy shipped here share-alike. Images are unmodified in content, '
      + 'normalised only in crop, size and grading.',
  generated: new Date().toISOString().slice(0, 10),
  images: manifest.map((m) => ({ id: m.id, name: m.name, ...m.source })),
}, null, 2));
await writeFile('/tmp/claude-0/-home-user-remoteviewtrainer/b4d0cecc-1ec4-5d31-abc0-2e197c1747e0/scratchpad/targets-manifest.json', JSON.stringify(manifest, null, 2));

console.log(`\nresolved ${manifest.length} / ${n}   failures ${failures.length}`);
if (failures.length) console.log(JSON.stringify(failures, null, 1));
