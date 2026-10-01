# Ganzfeld — a parapsychology lab

A browser-based 3D psychic-testing game for desktop and mobile web. You sit at a
candlelit table and test your own psi against honest odds.

## Modes

- **Zener run** — 25 cards, five symbols, chance is 5 hits in 25 (20%).
- **Remote viewing** — an 8-digit coordinate names a hidden target. You record an
  ideogram, sensory impressions and a sketch, then rank 5 candidates. Chance is 20%.
- **Career log** — pooled hit rate against chance with a real z-score.

## The odds are real

This is the part that is not negotiable.

- Targets come from `crypto.getRandomValues` with rejection sampling, so every
  outcome is exactly equally likely. `Math.random` is never used for a scored draw.
- Every target is **sealed with SHA-256 before your guess is accepted**, and the
  salt is published at the end of the run. Recompute `SHA-256(salt + ":" + payload)`
  and you can prove the card did not change after you chose.
- The headline statistic is the **exact binomial p-value**, with the z-score
  reported alongside it. The normal approximation is unreliable at small n and we
  say so rather than hiding it.
- The open deck (default) draws each trial independently, so the binomial is exactly
  the right null. The optional closed deck is *not* independent, so in that mode the
  p-value comes from a 20,000-deal Monte Carlo against your actual guess sequence
  instead of quietly reusing the binomial.
- The career log is append-only. The only deletion offered is wiping everything,
  because selective deletion would corrupt the statistics.

The game will never tell you that you have psi. It reports what the numbers say.

## Running it

```
npm install
npm run dev      # http://localhost:5173
npm test         # statistics test suite
```

URL parameters: `?q=low|medium|high` forces a quality tier, `?turbo=N` speeds
animations for automated testing (it never changes the odds).

## Play-test harness

```
node tools/play.mjs <outDir> [--mobile] [--q=medium] [--turbo=3]
```

Drives the real build in Chromium, captures console errors, screenshots key
moments and measures frame time.
