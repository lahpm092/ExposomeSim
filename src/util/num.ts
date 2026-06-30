// Small numeric helpers + a seeded RNG (so a character is reproducible from a seed —
// important for the harness×model tournament).

export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** map an unbounded score to [-1,1] */
export const squash = (x: number) => Math.tanh(x);

/** mulberry32 — tiny deterministic PRNG */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RNG { (): number; }

/** standard-normal sample from a uniform RNG (Box–Muller) */
export function randn(rng: RNG): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** pick from weighted options */
export function weightedPick<T>(rng: RNG, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [item, w] of items) { if ((r -= w) <= 0) return item; }
  return items[items.length - 1][0];
}
