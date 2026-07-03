// =============================================================================
// ExposomeSim — everyday interests, seeded into the memory GRAPH.
// -----------------------------------------------------------------------------
// Interests are the raw material a conversation EMERGES from: two co-located
// characters who happen to love the same thing have a reason to talk, and that
// reason has to live *in the memory graph* — not in a lookup table — so it is
// recallable, decays like anything else, and can surface when the driver asks
// "what do I care about?". So each interest is written as a durable SEMANTIC
// memory ("I really love <interest>."), the same near-permanent node kind the
// experiosome's formative memories use. Compatibility is then just set overlap.
//
// Pure & deterministic: a character's interests are a reproducible function of a
// seed (mulberry32), so the same roster always likes the same things.
// =============================================================================

import type { Character } from '../harness/character';
import { mulberry32 } from '../util/num';

/** ~16 ordinary, low-stakes interests any two neighbours might share. */
export const INTEREST_POOL: string[] = [
  'football', 'cooking', 'music', 'films', 'video games', 'gardening',
  'books', 'travel', 'coffee', 'cycling', 'painting', 'astronomy',
  'hiking', 'photography', 'history', 'dogs',
];

/**
 * A deterministic k-subset of INTEREST_POOL for a given seed. Uses a seeded
 * mulberry32 and a partial Fisher–Yates shuffle so the same seed always yields
 * the same interests (and the same *order*), independent of pool size.
 */
export function pickInterests(seed: number, k = 3): string[] {
  const rng = mulberry32(seed >>> 0);
  const pool = INTEREST_POOL.slice();
  const n = Math.min(Math.max(0, k), pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/**
 * Write each interest into the character's memory GRAPH as a durable SEMANTIC
 * node — first-person, so it reads like a belief about the self and is retrieved
 * by a cue that mentions the interest. Uses MemoryGraph.seed (the same durable
 * encoding as formative memories), NOT add(), so these persist and do not decay
 * out from under an emergent conversation.
 */
export function seedInterests(ch: Character, interests: string[], clock: number): void {
  if (!interests.length) return;
  ch.memory.seed(interests.map((interest) => `I really love ${interest}.`), clock);
}

/** Set intersection of two interest lists — the basis for a shared topic. */
export function sharedInterests(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of a) {
    if (setB.has(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}
