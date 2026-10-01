/**
 * The career log. Every scored trial ever run is kept, including the ones the
 * player would rather forget — selective deletion would destroy the statistics,
 * so the only delete offered is "wipe everything".
 */
import { summarize } from './stats.js';

const KEY = 'psilab.career.v1';
const MAX_SESSIONS = 2000;

const empty = () => ({ version: 1, created: Date.now(), sessions: [] });

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.sessions)) return empty();
    return data;
  } catch {
    return empty();
  }
}

function write(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a completed session. `trials` and `hits` are the only scored fields;
 * everything else is colour. Sessions are append-only.
 */
export function logSession({ mode, trials, hits, chance, detail = {} }) {
  if (!Number.isInteger(trials) || !Number.isInteger(hits)) throw new Error('log: non-integer');
  if (hits < 0 || hits > trials) throw new Error('log: hits out of range');
  const data = read();
  data.sessions.push({
    id: `${Date.now().toString(36)}-${data.sessions.length}`,
    at: Date.now(),
    mode, trials, hits, chance, detail,
  });
  if (data.sessions.length > MAX_SESSIONS) data.sessions = data.sessions.slice(-MAX_SESSIONS);
  write(data);
  return data.sessions[data.sessions.length - 1];
}

export function allSessions() {
  return read().sessions;
}

/** Totals for one mode, or for everything when `mode` is omitted. */
export function career(mode) {
  const sessions = read().sessions.filter((s) => !mode || s.mode === mode);
  if (!sessions.length) return { sessions: [], ...summarize(0, 0, mode === 'rv' ? 0.2 : 0.2), empty: true };
  // Guard: only pool trials that share a chance level.
  const chance = sessions[0].chance;
  const sameChance = sessions.filter((s) => s.chance === chance);
  const trials = sameChance.reduce((a, s) => a + s.trials, 0);
  const hits = sameChance.reduce((a, s) => a + s.hits, 0);
  return { sessions: sameChance, ...summarize(hits, trials, chance), empty: false };
}

/** Running z after each session, for the career graph. */
export function zTrace(mode) {
  const sessions = read().sessions.filter((s) => !mode || s.mode === mode);
  let t = 0, h = 0;
  return sessions.map((s) => {
    t += s.trials; h += s.hits;
    const sum = summarize(h, t, s.chance);
    return { at: s.at, trials: t, hits: h, z: sum.z, rate: sum.rate };
  });
}

export function wipe() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function exportJson() {
  return JSON.stringify(read(), null, 2);
}
