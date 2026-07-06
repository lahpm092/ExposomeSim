// =============================================================================
// ExposomeSim — VENUE FLOW: aggregate demand → discrete arrivals (hot) or
// statistical drift (cold), with exact conservation either way.
// -----------------------------------------------------------------------------
// The econ tick hands each venue its slice of the sector's aggregate demand —
// `units` and `revenue`, already exact. This layer only changes RESOLUTION:
//
//   HOT  → discretize. Convert units→expected customers via the learned mean
//          basket, Poisson-thin into an INTEGER arrival count, and feed the
//          realized episode back into stats.observe(). The per-tick residual
//          (Poisson luck) rides a PER-VENUE CARRY so nothing is ever created
//          or lost — units the night under-serves are the units the morning
//          rush spends. Where does the SHAPE act here? Only on that carry:
//          the fresh inflow already has the true hour structure (the econ
//          tick computed it hour by hour), so shaping it AGAIN would square
//          the diurnal signal — and worse, the learned shape would then feed
//          on its own output, a runaway sharpening loop (verified empirically:
//          the carry dives, arrivals cluster at recovery crossings, learning
//          decorrelates). The carry, by contrast, HAS lost its hour identity,
//          and expectedArrivals() is exactly the tool that re-times a
//          shapeless aggregate — bled back over a ~6h half-life, peak-hours
//          first. A negative carry (a lucky rush overdrew) repays the same
//          shaped way.
//   COLD → same totals, no events. Emit the shaped EXPECTATION as fractional
//          arrivals, with basket = units/arrivals so arrivals×basket == units
//          EXACTLY this tick (any hot leftover carry is flushed into it).
//          Crucially, cold ticks NEVER call stats.observe(): their arrivals
//          are computed FROM the learned shape, and feeding a model its own
//          output back would freeze whatever it currently believes into a
//          self-confirming echo — only hot (watched) episodes may teach.
//
// Conservation invariant, per venue over any window:
//     Σ units_in == Σ (arrivals × basket)_out + carry_now      (exactly)
// — exact per tick for cold, in expectation per tick for hot, exact over the
// run once the carry is counted. Revenue conserves identically via a parallel
// carry, priced pro-rata (out revenue = served units × avail $/unit).
//
// Determinism: all randomness comes from an internal mulberry32 stream seeded
// in the constructor and serialized in toJSON — same seed, same inputs, same
// arrivals, byte-identical saves.
// =============================================================================

import { mulberry32, randn, type RNG } from '../core/util/num';
import type { VenueFlowTick } from './types';
import type { VenueStats } from './stats';

/** units per customer assumed before any basket has ever been observed. */
const DEFAULT_BASKET = 2;
/** cold shape floor: even at the learned dead-of-night, a cold venue's
 *  expectation keeps a trickle so basket = units/arrivals stays well-defined
 *  while units flow (the totals are exact regardless of the floor). */
const COLD_SHAPE_FLOOR = 0.01;
/** half-life (observed hours) over which a hot venue's carry bleeds back into
 *  the arrival expectation — dt-invariant, and slow enough to damp the
 *  shape→arrivals→shape feedback to a gain well below 1. */
const CARRY_HALF_LIFE_H = 6;

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export class VenueFlow {
  private rng: RNG;
  private readonly seed: number;
  private readonly defaultBasket: number;
  /** per-venue residual units/revenue not yet expressed as output. Reused maps
   *  — one entry per venue for the module's lifetime, no per-tick allocation. */
  private carryU = new Map<string, number>();
  private carryR = new Map<string, number>();

  constructor(private stats: VenueStats, seed: number, defaultBasket: number = DEFAULT_BASKET) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.defaultBasket = defaultBasket > 0 ? defaultBasket : DEFAULT_BASKET;
  }

  // ---------------------------------------------------------------------------
  // run — resolve one venue's flow for this tick.
  // ---------------------------------------------------------------------------
  run(venueId: string, archetype: string, units: number, revenue: number,
      hot: boolean, hour: number, dtH: number): VenueFlowTick {
    const availU = units + (this.carryU.get(venueId) ?? 0);
    const availR = revenue + (this.carryR.get(venueId) ?? 0);
    const b = this.stats.meanBasket(venueId, archetype);
    const basketExp = b > 1e-9 ? b : this.defaultBasket;

    if (hot) {
      // ---- discrete path: thin the fresh inflow, re-time the carry ----------
      const fresh = units > 0 ? units / basketExp : 0;    // hour-exact expected customers
      const bleed = 1 - Math.pow(0.5, dtH / CARRY_HALF_LIFE_H);
      const carryFlow = ((availU - units) / basketExp) * bleed; // hour-less residual slice
      const shaped = carryFlow >= 0
        ? this.stats.expectedArrivals(venueId, archetype, hour, carryFlow)
        : carryFlow * this.stats.shape(venueId, archetype, hour); // shaped debt repayment
      const lam = Math.max(0, fresh + shaped);
      const n = poisson(this.rng, lam);
      const served = n * basketExp;                       // units these customers take
      const price = availU > 1e-9 ? availR / availU : 0;  // pro-rata $/unit
      const outR = served * price;
      // the residual (may be briefly negative after a lucky rush — a short
      // position the next ticks repay, since lam clamps at 0 while avail ≤ 0).
      this.carryU.set(venueId, availU - served);
      this.carryR.set(venueId, availR - outR);
      const basket = n > 0 ? served / n : 0;
      // teach the surrogate from this watched episode — INCLUDING n = 0, which
      // is what teaches it that nothing happens here at this hour.
      this.stats.observe(venueId, archetype, hour, n, basket, dtH);
      return { venueId, arrivals: n, basket, revenue: outR, discrete: true };
    }

    // ---- cold path: expectation only, exact totals, NO observe ---------------
    if (availU <= 1e-9) {
      // nothing meaningful to emit (or a negative hot leftover): let the
      // residual ride the carry rather than fabricate a zero-unit "flow".
      this.carryU.set(venueId, availU);
      this.carryR.set(venueId, availR);
      return { venueId, arrivals: 0, basket: 0, revenue: 0, discrete: false };
    }
    const base = availU / basketExp;
    const a = Math.max(this.stats.expectedArrivals(venueId, archetype, hour, base),
                       COLD_SHAPE_FLOOR * base);
    // flush everything: arrivals × basket == availU EXACTLY, revenue likewise.
    this.carryU.set(venueId, 0);
    this.carryR.set(venueId, 0);
    return { venueId, arrivals: a, basket: availU / a, revenue: availR, discrete: false };
  }

  /** current residual units for a venue (0 if unknown) — conservation audits. */
  carryUnits(venueId: string): number { return this.carryU.get(venueId) ?? 0; }

  /** current residual revenue for a venue (0 if unknown). */
  carryRevenue(venueId: string): number { return this.carryR.get(venueId) ?? 0; }

  // ---------------------------------------------------------------------------
  // persistence — the rng cursor + the carries ARE the state.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    const carries: [string, number, number][] = [];
    for (const [id, u] of this.carryU) carries.push([id, r6(u), r6(this.carryR.get(id) ?? 0)]);
    return { v: 1, seed: this.seed, rng: this.rng.save ? this.rng.save() : 0, carries };
  }

  loadJSON(j: unknown): void {
    const o = j as { rng?: number; carries?: unknown } | null;
    if (!o) return;
    if (typeof o.rng === 'number' && this.rng.load) this.rng.load(o.rng);
    if (Array.isArray(o.carries)) {
      this.carryU.clear();
      this.carryR.clear();
      for (const row of o.carries) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        this.carryU.set(row[0], typeof row[1] === 'number' ? row[1] : 0);
        this.carryR.set(row[0], typeof row[2] === 'number' ? row[2] : 0);
      }
    }
  }
}

// ---- local numerics ----------------------------------------------------------

/** Poisson sample. Knuth's product method for the small λ this module lives in
 *  (a venue-tick of a handful of customers); a rounded-normal approximation
 *  past λ=30 keeps the worst case O(1) instead of O(λ). */
function poisson(rng: RNG, lam: number): number {
  if (!(lam > 0)) return 0;
  if (lam > 30) {
    const n = Math.round(lam + Math.sqrt(lam) * randn(rng));
    return n > 0 ? n : 0;
  }
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}
