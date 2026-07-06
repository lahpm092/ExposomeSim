// =============================================================================
// ExposomeSim — ECONOMY / physiological-need dynamics for the shadow population.
// -----------------------------------------------------------------------------
// The cheap "shadow" households (Tier C) have no full soma, yet their demand for
// food and water should still EMERGE from a bodily drive rather than a flat rate.
// So we give each household two scalar drives — hunger & thirst — that rise as
// leaky-integrator ODEs toward saturation and, once past a threshold, trip a
// purchase. Individualized (lognormal) metabolic rates + noise make outcomes
// DIVERGE: some agents get hungry faster, shop more often, buy bigger baskets.
//
// Cost discipline (mirrors ECONOMY_DESIGN.md Tier C, same as shadowpop):
//   • stepped on the COARSE econ clock, never the render frame,
//   • one O(N) sweep of PLAIN FLOATS — every field is a packed typed array, so
//     there are no per-household objects and no allocation in the hot loop,
//   • the only per-tick randomness is the drive noise, drawn from the rng passed
//     to step() so it composes with the orchestrator's shared stream.
//
// Determinism: every per-agent CONSTANT (metabolic/dehydration rate, noise
// amplitude, appetite, initial fill) is drawn ONCE in the constructor from an
// INTERNAL mulberry32 seeded stream — never Math.random, never Date. Given the
// same constructor seed and the same step() rng sequence the field is bit-stable.
// =============================================================================

import { clamp, mulberry32, randn, type RNG } from '../../util/num';

// ---- tuning (local; drives are dimensionless [0,1], rates are per sim-hour) --

/** metabolic rate: hunger's pull toward saturation. Mean ~0.06/hr ⇒ an unfed
 *  household saturates over roughly a day (τ = 1/k ≈ 16h to the knee). */
const K_H_MEAN = 0.06;
/** dehydration rate: thirst climbs faster than hunger (~0.09/hr). */
const K_T_MEAN = 0.09;
/** lognormal spread of the per-agent rates (σ of the underlying gaussian). A big
 *  σ here is what fans the population out into fast/slow metabolisers. */
const RATE_SIGMA = 0.4;

/** per-tick drive noise (mean amplitude), itself lognormally spread per agent so
 *  some households are jittery buyers and others metronomic. */
const NOISE_MEAN = 0.02;
const NOISE_SIGMA = 0.4;

/** appetite = how much a household eats when it shops; stable per agent, unit
 *  mean, clamped to a sane band → diversity of basket size. */
const APPETITE_SIGMA = 0.35;
const APPETITE_LO = 0.5;
const APPETITE_HI = 1.8;

/** Schmitt-trigger thresholds (hysteresis): the drive must climb past the HI mark
 *  to latch "wants to buy", and fall back below the LO mark to release — so a
 *  household sitting on the boundary doesn't chatter buy/not-buy every tick. */
const EAT_HI = 0.62, EAT_LO = 0.30;
const DRINK_HI = 0.58, DRINK_LO = 0.28;

/** default consummatory magnitudes: a big grocery shop nearly fills hunger; a
 *  drink run tops up thirst. Partial acts are allowed via the `amount` arg. */
const EAT_AMOUNT = 0.8;
const DRINK_AMOUNT = 0.7;

// ---- small local numerics ---------------------------------------------------

/** unit-mean lognormal factor: exp(σ·g − σ²/2) has E[·]=1, so mean·factor keeps
 *  the intended mean while spreading multiplicatively (no negative rates). */
function lognorm(rng: RNG, sigma: number): number {
  return Math.exp(sigma * randn(rng) - 0.5 * sigma * sigma);
}

/** copy a persisted number[] into a packed float array, in place, up to the
 *  shorter length — tolerating a missing or size-mismatched source. */
function copyFloats(dst: Float32Array, src: unknown): void {
  if (!Array.isArray(src)) return;
  const m = Math.min(dst.length, src.length);
  for (let i = 0; i < m; i++) { const v = src[i]; if (typeof v === 'number') dst[i] = v; }
}

/** same, for the latch bytes. */
function copyBytes(dst: Uint8Array, src: unknown): void {
  if (!Array.isArray(src)) return;
  const m = Math.min(dst.length, src.length);
  for (let i = 0; i < m; i++) dst[i] = src[i] ? 1 : 0;
}

// =============================================================================
// PhysioView — compact aggregate readout the HUD/economy pulls per econ tick.
// =============================================================================
export interface PhysioView {
  n: number;
  meanHunger: number;   // 0..1
  meanThirst: number;   // 0..1
  hungryFrac: number;   // fraction over the eat threshold (latched)
  thirstyFrac: number;  // fraction over the drink threshold (latched)
}

// =============================================================================
// PhysioField
// =============================================================================
export class PhysioField {
  private n: number;
  private seed: number;

  // per-agent STATE (evolves in step / eat / drink)
  private h: Float32Array;      // hunger drive 0..1
  private t: Float32Array;      // thirst drive 0..1
  private foodLatch: Uint8Array; // hysteresis: currently "wants food"
  private waterLatch: Uint8Array;

  // per-agent CONSTANTS (drawn once from the internal stream, never re-rolled)
  private kH: Float32Array;     // metabolic rate /hr
  private kT: Float32Array;     // dehydration rate /hr
  private sig: Float32Array;    // drive-noise amplitude
  private app: Float32Array;    // appetite multiplier ~[0.5,1.8]

  /**
   * Seed `n` households. Each gets an individualized metabolic rate, dehydration
   * rate, noise amplitude and appetite from the lognormal-spread internal stream,
   * plus a randomized initial fill so first purchases STAGGER rather than clump.
   */
  constructor(n: number, seed: number) {
    const count = Math.max(0, n | 0);
    this.n = count;
    this.seed = seed >>> 0;

    this.h = new Float32Array(count);
    this.t = new Float32Array(count);
    this.foodLatch = new Uint8Array(count);
    this.waterLatch = new Uint8Array(count);
    this.kH = new Float32Array(count);
    this.kT = new Float32Array(count);
    this.sig = new Float32Array(count);
    this.app = new Float32Array(count);

    // Internal stream, used ONLY here for the fixed per-agent constants; the
    // per-tick noise later rides step()'s rng so the two never entangle.
    const r = mulberry32(this.seed);
    for (let i = 0; i < count; i++) {
      this.kH[i] = K_H_MEAN * lognorm(r, RATE_SIGMA);
      this.kT[i] = K_T_MEAN * lognorm(r, RATE_SIGMA);
      this.sig[i] = NOISE_MEAN * lognorm(r, NOISE_SIGMA);
      this.app[i] = clamp(lognorm(r, APPETITE_SIGMA), APPETITE_LO, APPETITE_HI);
      // partial, spread initial fill (0..0.5) → households cross thresholds at
      // different times, so demand isn't a synchronized pulse.
      this.h[i] = 0.5 * r();
      this.t[i] = 0.5 * r();
      // latches start released (initial fills sit below the HI marks).
    }
  }

  // ---------------------------------------------------------------------------
  // step — advance every household's drives one econ tick. O(N), alloc-free.
  // ---------------------------------------------------------------------------
  // Each drive is a leaky integrator toward 1:  dx/dt = k·(1 − x) + σ·ξ.
  // We integrate Euler–Maruyama, so the stochastic term scales with √dt (its
  // variance ∝ elapsed time) — keeping behaviour invariant to the tick size on
  // the coarse clock. Both drives clamp to [0,1]; the Schmitt latch is refreshed
  // inline so wantsFood/wantsWater are ready the instant step() returns.
  step(dtHours: number, rng: RNG): void {
    const n = this.n;
    if (n === 0) return;
    const dt = dtHours;
    const sqrtDt = dt > 0 ? Math.sqrt(dt) : 0;

    const h = this.h, t = this.t;
    const kH = this.kH, kT = this.kT, sig = this.sig;
    const fl = this.foodLatch, wl = this.waterLatch;

    for (let i = 0; i < n; i++) {
      let hi = h[i] + kH[i] * (1 - h[i]) * dt + sig[i] * sqrtDt * randn(rng);
      let ti = t[i] + kT[i] * (1 - t[i]) * dt + sig[i] * sqrtDt * randn(rng);
      hi = hi < 0 ? 0 : hi > 1 ? 1 : hi;
      ti = ti < 0 ? 0 : ti > 1 ? 1 : ti;
      h[i] = hi; t[i] = ti;

      // hysteresis: latch on the HI crossing, release on the LO crossing, hold
      // in the band between (branchless-ish, O(1)).
      if (hi > EAT_HI) fl[i] = 1; else if (hi < EAT_LO) fl[i] = 0;
      if (ti > DRINK_HI) wl[i] = 1; else if (ti < DRINK_LO) wl[i] = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // per-household readouts + purchase triggers
  // ---------------------------------------------------------------------------

  /** current hunger drive 0..1 (0 outside range). */
  hunger(i: number): number {
    return i >= 0 && i < this.n ? this.h[i] : 0;
  }

  /** current thirst drive 0..1 (0 outside range). */
  thirst(i: number): number {
    return i >= 0 && i < this.n ? this.t[i] : 0;
  }

  /** latched "hunger crossed the eat threshold" — the food-purchase trigger. */
  wantsFood(i: number): boolean {
    return i >= 0 && i < this.n ? this.foodLatch[i] === 1 : false;
  }

  /** latched "thirst crossed the drink threshold" — the water-purchase trigger. */
  wantsWater(i: number): boolean {
    return i >= 0 && i < this.n ? this.waterLatch[i] === 1 : false;
  }

  // ---------------------------------------------------------------------------
  // consummatory acts — called when the household actually buys. Resetting the
  // drive (not zeroing a timer) is what makes purchase FREQUENCY emerge from the
  // ODE: a fast metaboliser refills the drive sooner and returns to shop sooner.
  // ---------------------------------------------------------------------------

  /** eat: knock hunger down by `amount` (default a big shop). Releases the latch
   *  once the drive drops below the LO mark. */
  eat(i: number, amount: number = EAT_AMOUNT): void {
    if (i < 0 || i >= this.n) return;
    const v = clamp(this.h[i] - amount, 0, 1);
    this.h[i] = v;
    if (v > EAT_HI) this.foodLatch[i] = 1; else if (v < EAT_LO) this.foodLatch[i] = 0;
  }

  /** drink: knock thirst down by `amount` (default a top-up). */
  drink(i: number, amount: number = DRINK_AMOUNT): void {
    if (i < 0 || i >= this.n) return;
    const v = clamp(this.t[i] - amount, 0, 1);
    this.t[i] = v;
    if (v > DRINK_HI) this.waterLatch[i] = 1; else if (v < DRINK_LO) this.waterLatch[i] = 0;
  }

  /** stable per-agent appetite multiplier ~[0.5,1.8] → basket-size diversity. */
  appetite(i: number): number {
    return i >= 0 && i < this.n ? this.app[i] : 1;
  }

  count(): number { return this.n; }

  /** compact aggregate readout (one O(N) sweep; no allocation beyond the object). */
  view(): PhysioView {
    const n = this.n;
    let sh = 0, st = 0, nh = 0, nt = 0;
    const fl = this.foodLatch, wl = this.waterLatch;
    for (let i = 0; i < n; i++) {
      sh += this.h[i]; st += this.t[i];
      if (fl[i]) nh++;
      if (wl[i]) nt++;
    }
    const inv = n > 0 ? 1 / n : 0;
    return {
      n,
      meanHunger: sh * inv,
      meanThirst: st * inv,
      hungryFrac: nh * inv,
      thirstyFrac: nt * inv,
    };
  }

  // ---------------------------------------------------------------------------
  // persistence — the per-agent CONSTANTS must be saved too (they were rolled
  // from the internal stream in the ctor, which loadJSON does not re-run).
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      seed: this.seed,
      n: this.n,
      h: Array.from(this.h),
      t: Array.from(this.t),
      foodLatch: Array.from(this.foodLatch),
      waterLatch: Array.from(this.waterLatch),
      kH: Array.from(this.kH),
      kT: Array.from(this.kT),
      sig: Array.from(this.sig),
      app: Array.from(this.app),
    };
  }

  /** restore IN PLACE onto the existing arrays; tolerate missing/short/absent
   *  fields (copies only the overlapping prefix, leaves the rest as constructed). */
  loadJSON(j: unknown): void {
    const o = j as {
      seed?: number;
      h?: unknown; t?: unknown; foodLatch?: unknown; waterLatch?: unknown;
      kH?: unknown; kT?: unknown; sig?: unknown; app?: unknown;
    } | null;
    if (!o) return;
    if (typeof o.seed === 'number') this.seed = o.seed >>> 0;
    copyFloats(this.h, o.h);
    copyFloats(this.t, o.t);
    copyBytes(this.foodLatch, o.foodLatch);
    copyBytes(this.waterLatch, o.waterLatch);
    copyFloats(this.kH, o.kH);
    copyFloats(this.kT, o.kT);
    copyFloats(this.sig, o.sig);
    copyFloats(this.app, o.app);
  }
}
