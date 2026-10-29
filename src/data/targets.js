/**
 * The remote-viewing target pool: real places on Earth.
 *
 * These were procedurally drawn illustrations. They are now photographs of
 * actual locations, which is what the original protocol used — an experimenter
 * travelled to a randomly chosen site while the viewer described it, and
 * judges later ranked the transcripts against the real place.
 *
 * ===================================================================
 * TWO THINGS HERE ARE LOAD-BEARING FOR THE ODDS
 * ===================================================================
 *
 * 1. THE NETWORK MUST NOT REVEAL THE TARGET.
 *
 *    With drawn targets nothing touched the network, so there was nothing to
 *    observe. Photographs are files, and a file request is visible in the
 *    network panel. If the target image were fetched when the target is
 *    sealed — the obvious place to put it for performance — anyone could read
 *    the answer off the network tab before ranking.
 *
 *    So there is deliberately NO way to load one target's image. loadSet()
 *    takes the whole candidate set and loads all of them together, and it is
 *    the only loader exported. The target is never requested alone, never
 *    requested first, and never requested earlier than its decoys.
 *
 * 2. THE FIVE CANDIDATES MUST NOT DIFFER IN STYLE.
 *
 *    Photographs differ in ways that have nothing to do with their content:
 *    grading, time of day, medium, resolution. A viewer who latches onto one
 *    of those scores a hit for a reason unrelated to the target, which
 *    inflates the rate. tools/fetch-targets.mjs rejects anything that is not a
 *    colour photograph — engravings, plans, sketches, collages, monochrome
 *    plates — and normalises every accepted image to one crop, one size and
 *    one grade. The first pool built here failed this badly enough to be worth
 *    recording: ranking by licence pulled in a 19th-century engraving of the
 *    Brooklyn Bridge and a blueprint of a Chicago railcar, because those are
 *    what had fallen out of copyright.
 *
 * Nothing here touches the draw itself. chooseTargetSet still picks the target
 * uniformly and the decoys without replacement, so chance is exactly 1/5.
 */
import { randomInt, sample, shuffle } from '../core/rng.js';
import DATA from './targets.data.json';

/** Where the images are served from, base-path aware so Pages works. */
const BASE = `${import.meta.env?.BASE_URL ?? '/'}targets/`.replace(/\/{2,}/g, '/');

/** id -> HTMLImageElement, once loaded. Shared; images never change. */
const loaded = new Map();

/**
 * A target that has no image yet still has to draw something, and what it
 * draws must carry no information. Every unloaded target paints the identical
 * neutral card, so a slow network degrades all five equally rather than
 * singling one out.
 */
function placeholder(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#241e33');
  g.addColorStop(1, '#17121f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Cover-fit, so every target fills its box identically whatever its aspect. */
function drawCover(ctx, img, w, h) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export const TARGETS = DATA.map((t) => ({
  ...t,
  image: `${BASE}${t.id}.jpg`,
  /** Same contract the drawn targets had: fill the box opaquely, no state. */
  render(ctx, w, h) {
    const img = loaded.get(t.id);
    if (img && img.complete && img.naturalWidth) drawCover(ctx, img, w, h);
    else placeholder(ctx, w, h);
  },
}));

export const CANDIDATES = 5;
export const CHANCE = 1 / CANDIDATES;

export const byId = (id) => TARGETS.find((t) => t.id === id) || null;

/**
 * Load the images for a WHOLE candidate set at once.
 *
 * This is the only loader, on purpose — see the note at the top of the file.
 * Taking an array rather than a target is what makes "never fetch the target
 * on its own" a property of the interface instead of a rule someone has to
 * remember. Resolves when every one has settled; a failure is not fatal,
 * because render() falls back to the identical placeholder for all.
 */
export function loadSet(targets) {
  if (!Array.isArray(targets) || targets.length < 2) {
    throw new Error('loadSet: pass the whole candidate set, never one target');
  }
  return Promise.all(targets.map((t) => new Promise((resolve) => {
    if (loaded.has(t.id)) return resolve(loaded.get(t.id));
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { loaded.set(t.id, img); resolve(img); };
    img.onerror = () => resolve(null);
    img.src = t.image;
  })));
}

/** True once this target's bitmap is in hand. For callers that want to wait. */
export const isLoaded = (t) => {
  const img = loaded.get(t.id);
  return !!(img && img.complete && img.naturalWidth);
};

/**
 * Draw the target set.
 *
 * Target uniform over the pool; decoys uniform without replacement from the
 * pool minus the target; display order shuffled independently. A decoy is
 * never the target, no target appears twice, and grid position leaks nothing.
 */
export function chooseTargetSet(pool = TARGETS, count = CANDIDATES) {
  if (!Array.isArray(pool) || pool.length < count) {
    throw new Error(`chooseTargetSet: pool needs at least ${count} targets`);
  }
  const target = pool[randomInt(pool.length)];
  const rest = pool.filter((t) => t.id !== target.id);
  const decoys = sample(rest, count - 1);
  const order = shuffle([target, ...decoys]);
  return { target, decoys, order };
}

/**
 * Paint a target into a canvas element, sizing its backing store for the
 * device pixel ratio. Safe to call repeatedly.
 */
export function paintTarget(canvas, target, dpr) {
  const ratio = Math.min(dpr || globalThis.devicePixelRatio || 1, 2.5);
  const cssW = canvas.clientWidth || canvas.width || 240;
  const cssH = canvas.clientHeight || canvas.height || 170;
  const pw = Math.max(1, Math.round(cssW * ratio));
  const ph = Math.max(1, Math.round(cssH * ratio));
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.save();
  target.render(ctx, pw, ph);
  ctx.restore();
  return canvas;
}

/** Sanity check used by the test script: no duplicate ids, enough targets. */
export function poolIntegrity(pool = TARGETS) {
  const ids = pool.map((t) => t.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const missing = pool.filter((t) => !t.name || !t.describe || typeof t.render !== 'function' || !t.tags?.length);
  return { size: pool.length, dupes, malformed: missing.map((t) => t.id) };
}

/** Every image's author and licence, for the credits screen. */
export const CREDITS = DATA.map((t) => ({ name: t.name, ...t.credit }));
