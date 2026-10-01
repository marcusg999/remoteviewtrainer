/**
 * Zener card run: 25 trials, five symbols, chance = 5 hits in 25 (20%).
 *
 * PROTOCOL — this is the part that must not be fudged:
 *
 * Open deck (default). Each trial draws one of the five symbols uniformly and
 * independently from the OS CSPRNG. Trials are therefore i.i.d. Bernoulli(0.2)
 * and the binomial p-value and z-score we report are exactly correct.
 *
 * Closed deck (optional). A shuffled 25-card deck with five of each symbol,
 * dealt without replacement — Rhine's original. Expected hits are still 5, but
 * the trials are NOT independent, so the binomial is the wrong null. In that
 * mode we compute the null by Monte Carlo against the player's actual guess
 * sequence instead of quietly reusing the binomial. See nullForClosedDeck().
 *
 * The target for every trial is drawn and cryptographically committed BEFORE
 * the guess is accepted, and the salt is published at the end of the run.
 */
import * as THREE from 'three';
import { SYMBOLS } from '../scene/cardArt.js';
import { Card, CARD_W, CARD_H } from '../scene/card.js';
import { randomInt, shuffle } from '../core/rng.js';
import { seal } from '../core/commit.js';
import { summarize } from '../core/stats.js';
import * as audio from '../juice/audio.js';
import { makeBackCanvas } from '../scene/cardArt.js';

let _deckBackTex = null;
function deckBackTexture() {
  if (!_deckBackTex) {
    _deckBackTex = new THREE.CanvasTexture(makeBackCanvas());
    _deckBackTex.colorSpace = THREE.SRGBColorSpace;
  }
  return _deckBackTex;
}
import { easeOutCubic, easeOutBack, easeInOutCubic } from '../juice/easing.js';

export const TRIALS = 25;
export const CHANCE = 1 / 5;

/** Monte Carlo null for a closed deck, conditioned on the real guess sequence. */
export function nullForClosedDeck(guesses, iterations = 20000) {
  const deck = [];
  for (const s of SYMBOLS) for (let i = 0; i < 5; i++) deck.push(s);
  const counts = new Array(TRIALS + 2).fill(0);
  const work = deck.slice();
  for (let it = 0; it < iterations; it++) {
    // Math.random is fine here: this is our own analysis, not a scored draw.
    for (let i = work.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = work[i]; work[i] = work[j]; work[j] = t;
    }
    let h = 0;
    for (let i = 0; i < guesses.length; i++) if (work[i] === guesses[i]) h++;
    counts[h]++;
  }
  return { counts, iterations };
}

export class ZenerRun {
  /**
   * @param {object} ctx { scene, particles, floatText, director, tweens, onUpdate }
   */
  constructor(ctx, { closedDeck = false } = {}) {
    this.ctx = ctx;
    this.closedDeck = closedDeck;
    this.group = new THREE.Group();
    ctx.scene.add(this.group);

    this.index = 0;
    this.hits = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.results = [];      // { guess, target, hit }
    this.commitments = [];
    this.guesses = [];
    this.targets = [];
    this.busy = false;
    this.finished = false;
    this.startedAt = Date.now();

    if (closedDeck) {
      this.deck = [];
      for (const s of SYMBOLS) for (let i = 0; i < 5; i++) this.deck.push(s);
      shuffle(this.deck);
    }

    this.tableau = [];      // revealed cards still on the table
    this.active = null;     // the face-down card awaiting a guess
    this.pending = null;    // sealed target for the active card

    this._buildDeckStack();
  }

  /** A visible stack of remaining cards, so the run has a physical quantity. */
  _buildDeckStack() {
    this.stack = new THREE.Group();
    this.stack.position.set(2.45, 0.04, 0.35);
    this.stack.rotation.x = -Math.PI / 2 + 0.05;
    this.stack.rotation.z = 0.08;
    const geo = new THREE.BoxGeometry(CARD_W * 0.78, CARD_H * 0.78, 0.012);
    const edge = new THREE.MeshStandardMaterial({ color: 0xd8cdb4, roughness: 0.85 });
    const back = new THREE.MeshStandardMaterial({ map: deckBackTexture(), roughness: 0.55, metalness: 0.06 });
    const mat = [edge, edge, edge, edge, back, back];
    this.stackCards = [];
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.z = i * 0.015;
      m.rotation.z = (Math.random() - 0.5) * 0.035;
      m.castShadow = true;
      this.stack.add(m);
      this.stackCards.push(m);
    }
    this.group.add(this.stack);
  }

  _syncStack() {
    const remaining = TRIALS - this.index;
    const show = Math.ceil((remaining / TRIALS) * this.stackCards.length);
    this.stackCards.forEach((m, i) => { m.visible = i < show; });
  }

  /** Draw the next target, commit to it, and deal a face-down card. */
  async nextTrial() {
    if (this.finished || this.busy) return;
    this.busy = true;

    const target = this.closedDeck ? this.deck[this.index] : SYMBOLS[randomInt(SYMBOLS.length)];
    // Commit BEFORE the player can act. The salt is withheld until the run ends.
    this.pending = { target, commitment: await seal(`zener:${this.index}:${target}`) };
    this.targets.push(target);

    const card = new Card(target);
    card.setHome(0, 0.84, -0.55);
    card.group.rotation.x = -0.10;
    this.group.add(card.group);
    this.active = card;

    // deal: slide in from the deck with a small arc
    card.group.position.set(2.45, 0.12, 0.35);
    card.group.scale.setScalar(0.82);
    audio.sfxDeal();
    const from = card.group.position.clone();
    const to = new THREE.Vector3(0, 0.84, -0.55);
    await this.ctx.tweens.add({
      dur: 0.42, ease: easeOutCubic,
      onUpdate: (_, e) => {
        card.group.position.lerpVectors(from, to, e);
        card.group.position.y += Math.sin(e * Math.PI) * 0.45;
        card.group.scale.setScalar(0.82 + 0.18 * e);
      },
    });
    card.setHome(0, 0.84, -0.55);
    audio.sfxLand();
    this.ctx.director.addTrauma(0.09);
    this._syncStack();
    this.busy = false;
  }

  /** Accept a guess, reveal, and score. Returns the trial result. */
  async guess(symbol) {
    if (this.busy || this.finished || !this.active || !this.pending) return null;
    this.busy = true;
    audio.sfxCommit();

    const target = this.pending.target;
    const hit = symbol === target;
    this.guesses.push(symbol);
    this.commitments.push(this.pending.commitment);

    const card = this.active;

    // a beat of anticipation before the turn — the pause is the point
    await this.ctx.tweens.add({ dur: 0.16 });
    this.ctx.director.pushIn(0.30, new THREE.Vector3(0, 0.95, -0.5), 9);
    audio.sfxFlip();
    card.flip(true, 0.5);
    await this.ctx.tweens.add({ dur: 0.5 });

    // --- the reveal lands here ---
    const anchor = new THREE.Vector3(0, 1.62, -0.5);
    if (hit) {
      this.hits++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      card.pop();
      audio.sfxHit(this.streak - 1);
      this.ctx.director.addTrauma(Math.min(0.55, 0.26 + this.streak * 0.07));
      this.ctx.particles.burst(new THREE.Vector3(0, 0.95, -0.5), {
        count: 34 + this.streak * 7,
        speed: 3.1, spread: 1.5, size: 11, life: 1.0,
        colors: [0x49d17c, 0xe8a33d, 0xfff0cf, 0x9fe8bd],
      });
      this.ctx.floatText.spawn(anchor, 'HIT', { kind: 'hit' });
      if (this.streak >= 3) {
        this.ctx.floatText.spawn(
          new THREE.Vector3(1.05, 1.95, -0.5), `${this.streak} IN A ROW`,
          { kind: 'streak', dur: 0.75, drift: 0.8 }
        );
      }
    } else {
      this.streak = 0;
      audio.sfxMiss();
      this.ctx.director.addTrauma(0.06);
      this.ctx.floatText.spawn(anchor, SYMBOL_NAME(target), { kind: 'miss' });
    }

    this.results.push({ guess: symbol, target, hit, commitment: this.pending.commitment });
    this.index++;
    this.pending = null;
    this.ctx.onUpdate?.(this.snapshot());

    await this.ctx.tweens.add({ dur: hit ? 0.5 : 0.3 });
    this.ctx.director.release(4);

    // retire the card to the tableau
    this._retire(card, hit);
    this.active = null;
    this.busy = false;

    if (this.index >= TRIALS) {
      this.finished = true;
      return { hit, target, guess: symbol, done: true };
    }
    return { hit, target, guess: symbol, done: false };
  }

  /** Revealed cards fan out to the left and shrink; the oldest drops away. */
  _retire(card, hit) {
    card.setOutcome(hit);
    this.tableau.push({ card, hit });
    const MAXT = 7;
    if (this.tableau.length > MAXT) {
      const old = this.tableau.shift();
      const g = old.card.group;
      this.ctx.tweens.add({
        dur: 0.4, ease: easeOutCubic,
        onUpdate: (_, e) => { g.position.y = 0.22 - e * 0.4; g.position.z = 0.62 + e * 1.8; g.scale.setScalar(0.37 * (1 - e * 0.85)); },
        onComplete: () => { this.group.remove(g); old.card.dispose(); },
      });
    }
    const n = this.tableau.length;
    this.tableau.forEach((t, i) => {
      const k = i - (n - 1) / 2;
      const tx = k * 0.50;
      const tz = 0.62 - Math.abs(k) * 0.04;
      const ty = 0.22;
      // lean them back toward the camera so the symbol still reads
      t.card.layFlat = true;
      const c = t.card;
      const from = c.group.position.clone();
      const fromS = c.group.scale.x;
      this.ctx.tweens.add({
        dur: 0.4, ease: easeOutCubic,
        onUpdate: (_, e) => {
          c.home.set(
            from.x + (tx - from.x) * e,
            from.y + (ty - from.y) * e,
            from.z + (tz - from.z) * e
          );
          const s = fromS + (0.37 - fromS) * e;
          c.targetScale = s; c.scale = s;
        },
      });
    });
  }

  snapshot() {
    const s = summarize(this.hits, this.index, CHANCE);
    return {
      index: this.index, trials: TRIALS, hits: this.hits,
      streak: this.streak, bestStreak: this.bestStreak,
      results: this.results, ...s,
    };
  }

  /** Final readout, including the proof that the targets were pre-committed. */
  report() {
    const base = summarize(this.hits, TRIALS, CHANCE);
    const out = {
      ...base,
      mode: this.closedDeck ? 'zener-closed' : 'zener',
      bestStreak: this.bestStreak,
      results: this.results,
      durationMs: Date.now() - this.startedAt,
      proof: this.commitments.map((c, i) => ({ i, ...c.reveal })),
    };
    if (this.closedDeck) {
      const mc = nullForClosedDeck(this.guesses);
      let ge = 0;
      for (let k = this.hits; k < mc.counts.length; k++) ge += mc.counts[k];
      out.pExact = ge / mc.iterations;
      out.pNote = 'closed deck: p from 20,000 Monte Carlo deals against your guess sequence';
    }
    return out;
  }

  dispose() {
    for (const t of this.tableau) { this.group.remove(t.card.group); t.card.dispose(); }
    if (this.active) { this.group.remove(this.active.group); this.active.dispose(); }
    this.ctx.scene.remove(this.group);
  }
}

function SYMBOL_NAME(s) {
  return { circle: 'CIRCLE', cross: 'CROSS', waves: 'WAVES', square: 'SQUARE', star: 'STAR' }[s] || s;
}
