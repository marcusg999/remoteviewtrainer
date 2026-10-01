/**
 * Pre-registration by cryptographic commitment.
 *
 * The obvious objection to any psi test run by software is that the program
 * could choose the target after seeing the guess. This removes that objection:
 * the target is drawn first, then we publish SHA-256(salt : payload) BEFORE the
 * player commits a guess. After the reveal we hand over the salt, and anyone
 * can recompute the digest and confirm the target never changed.
 *
 * This is the honest-odds guarantee made checkable rather than merely asserted.
 */
import { randomHex } from './rng.js';

const enc = new TextEncoder();

async function sha256Hex(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Seal a target. Returns the digest to show now and the proof to show later.
 * `payload` must be a deterministic string describing the target completely.
 */
export async function seal(payload) {
  const salt = randomHex(16);
  const digest = await sha256Hex(`${salt}:${payload}`);
  return {
    digest,
    short: digest.slice(0, 12),
    reveal: { salt, payload, digest },
    sealedAt: Date.now(),
  };
}

/** Recompute and check a revealed commitment. Pure verification. */
export async function verify({ salt, payload, digest }) {
  if (!salt || payload == null || !digest) return false;
  const recomputed = await sha256Hex(`${salt}:${payload}`);
  return recomputed === digest;
}

export { sha256Hex };
