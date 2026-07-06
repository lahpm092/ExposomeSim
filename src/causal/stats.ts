// =============================================================================
// ExposomeSim — VENUE STATS: the evolving probabilistic surrogate.
// -----------------------------------------------------------------------------
// This is the module's centrepiece: a continuously-refit statistical model of
// "what happens at a venue like this, at this hour" — the average causality of
// the system AT ITS CURRENT STAGE. It learns ONLY from HOT episodes (fully
// simulated causal windows, fed in via observe()) and is read by everything
// that must behave plausibly while COLD: fractional flow expectations, ambience
// crowd density, future coarse ticks. Because it is an EMA over live episodes,
// regime changes propagate: a recession observed up close makes the whole cold
// world quieter within a few observed half-lives; a boom loudens it.
//
// Structure, per venue: 24 hour-buckets of EMA arrival rate + an EMA mean
// basket + counts. Alongside, per ARCHETYPE, the same record pooled across all
// its venues. Reads blend the two hierarchically (venue ⇄ archetype ⇄ flat
// prior) by count-based confidence, so a never-visited venue inherits the
// town's average causality and an often-visited one speaks for itself.
//
// Numerics:
//   • EMA half-life ≈ 6 OBSERVED hours per bucket, dt-invariant via
//     lam = 1 − 0.5^(dtH/6) — two 0.5h observations move a bucket exactly as
//     far as one 1h observation at the same rate.
//   • a bucket's FIRST observation is adopted outright (no warm-up bias from
//     blending against the zero it was initialized with).
//   • shape() returns a mean-1 hour multiplier; blends of mean-1 vectors are
//     mean-1, so the hierarchy never distorts totals.
//
// Deterministic (pure arithmetic, no RNG) and allocation-light: records are
// created once per venue/archetype; shape() fills a reused scratch vector.
// =============================================================================

import type { VenueStatsView } from './types';

/** EMA half-life per hour-bucket, in OBSERVED hours. ~6 observations of a
 *  given hour rewrite half of what the model believed about that hour. */
const HALF_LIFE_H = 6;
/** shrinkage constant: venue weight w = nObs/(nObs+K). After K observed hours
 *  the venue's own data and its prior split the say 50/50. */
const K_SHRINK = 12;

const HOURS = 24;

/** one statistical record — used for both a venue and a pooled archetype. */
interface Rec {
  arch: string;              // archetype key ('' for archetype records themselves)
  rate: Float64Array;        // [24] EMA arrivals/hour by hour-of-day
  nB: Float64Array;          // [24] observed hours per bucket (first-obs detection)
  basket: number;            // EMA mean basket (units/arrival); 0 until first arrival
  nBasket: number;           // observed hours with arrivals (basket confidence)
  nObs: number;              // total observed hours → shrinkage confidence
  visits: number;            // cumulative arrivals (integer; the view's counter)
}

function newRec(arch: string): Rec {
  return {
    arch,
    rate: new Float64Array(HOURS),
    nB: new Float64Array(HOURS),
    basket: 0, nBasket: 0, nObs: 0, visits: 0,
  };
}

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;

export class VenueStats {
  private venues = new Map<string, Rec>();
  private archs = new Map<string, Rec>();
  /** bumped on every observe() — lets consumers cache derived views. */
  private ver = 0;
  /** scratch for shape() — one allocation for the module's lifetime. */
  private scratch = new Float64Array(HOURS);

  // ---------------------------------------------------------------------------
  // observe — feed one HOT tick's ground truth into the surrogate.
  //   Called ONLY for hot venues: these are real causal episodes. arrivals may
  //   be 0 — a watched hour in which nobody came is information too (it is what
  //   carves the quiet hours into the shape). Cold ticks must NEVER call this;
  //   their arrivals are generated FROM this model, and feeding them back would
  //   be an echo chamber (see flow.ts).
  // ---------------------------------------------------------------------------
  observe(venueId: string, archetype: string, hour: number, arrivals: number, basket: number, dtH: number): void {
    if (!(dtH > 0)) return;
    const h = ((hour | 0) % HOURS + HOURS) % HOURS;
    const lam = 1 - Math.pow(0.5, dtH / HALF_LIFE_H);
    const rate = arrivals / dtH;

    let v = this.venues.get(venueId);
    if (!v) { v = newRec(archetype); this.venues.set(venueId, v); }
    let a = this.archs.get(archetype);
    if (!a) { a = newRec(''); this.archs.set(archetype, a); }

    updateRec(v, h, lam, rate, arrivals, basket, dtH);
    updateRec(a, h, lam, rate, arrivals, basket, dtH);
    this.ver++;
  }

  // ---------------------------------------------------------------------------
  // shape — the hierarchical hour multiplier (mean 1 over the 24 buckets).
  //   venue shape ⊕ archetype shape ⊕ flat prior, blended by confidence:
  //   wV = nVenue/(nVenue+K) against the archetype layer, which itself stands
  //   on the flat prior by its own wA. Cold everywhere ⇒ exactly 1.
  // ---------------------------------------------------------------------------
  shape(venueId: string, archetype: string, hour: number): number {
    const h = ((hour | 0) % HOURS + HOURS) % HOURS;
    this.shapeInto(venueId, archetype, this.scratch);
    return this.scratch[h];
  }

  /** the full 24-bucket mean-1 shape, into a fresh array (for views/tests). */
  shapeVector(venueId: string, archetype: string): number[] {
    this.shapeInto(venueId, archetype, this.scratch);
    return Array.from(this.scratch);
  }

  /** fill `out[24]` with the blended mean-1 shape. Allocation-free. */
  private shapeInto(venueId: string, archetype: string, out: Float64Array): void {
    const v = this.venues.get(venueId);
    const a = this.archs.get(archetype);
    const wV = v ? v.nObs / (v.nObs + K_SHRINK) : 0;
    const wA = a ? a.nObs / (a.nObs + K_SHRINK) : 0;

    // per-layer normalizers (mean bucket rate). A layer whose observed mean is
    // ~0 has no shape to speak of and degrades to the flat prior.
    const mv = v ? meanRateOf(v) : 0;
    const ma = a ? meanRateOf(a) : 0;
    const invV = mv > 1e-12 ? 1 / mv : 0;
    const invA = ma > 1e-12 ? 1 / ma : 0;

    for (let h = 0; h < HOURS; h++) {
      const sv = invV > 0 ? v!.rate[h] * invV : 1;                 // venue layer (mean 1)
      const sa = invA > 0 ? a!.rate[h] * invA : 1;                 // archetype layer (mean 1)
      const prior = wA * sa + (1 - wA) * 1;                        // archetype ⊕ flat
      out[h] = wV * sv + (1 - wV) * prior;                         // venue ⊕ prior
    }
  }

  // ---------------------------------------------------------------------------
  // expectedArrivals — distribute an externally-computed aggregate flow into an
  // hour-shaped expectation. `aggregateFlow` is the tick's UNSHAPED expected
  // arrival count (the econ tick's exact totals, converted units→customers by
  // the caller). Conservation NEVER depends on this: the flow layer's carry
  // accumulator reconciles whatever the shape redistributes (see flow.ts).
  // ---------------------------------------------------------------------------
  expectedArrivals(venueId: string, archetype: string, hour: number, aggregateFlow: number): number {
    if (!(aggregateFlow > 0)) return 0;
    return aggregateFlow * this.shape(venueId, archetype, hour);
  }

  /** blended mean basket (units/arrival); 0 = "no idea yet" (caller defaults). */
  meanBasket(venueId: string, archetype: string): number {
    const v = this.venues.get(venueId);
    const a = this.archs.get(archetype);
    const vB = v && v.nBasket > 0 ? v.basket : 0;
    const aB = a && a.nBasket > 0 ? a.basket : 0;
    if (vB > 0 && aB > 0) {
      const wV = v!.nObs / (v!.nObs + K_SHRINK);
      return wV * vB + (1 - wV) * aB;
    }
    return vB > 0 ? vB : aB;
  }

  /** the venue's LEVEL — mean EMA arrival rate across the 24 buckets. This is
   *  what a regime shift moves (the shape only says WHEN, the level says HOW
   *  MUCH); smoke tests watch it track a demand collapse. */
  meanRate(venueId: string): number {
    const v = this.venues.get(venueId);
    return v ? meanRateOf(v) : 0;
  }

  /** venue confidence 0..1 — the shrinkage weight its own data carries. */
  confidence(venueId: string): number {
    const v = this.venues.get(venueId);
    return v ? v.nObs / (v.nObs + K_SHRINK) : 0;
  }

  /** compact per-venue readout. hourShape is a distribution (sums to 1). */
  statsView(venueId: string, archetype: string): VenueStatsView {
    this.shapeInto(venueId, archetype, this.scratch);
    const hourShape: number[] = new Array(HOURS);
    for (let h = 0; h < HOURS; h++) hourShape[h] = this.scratch[h] / HOURS;
    const v = this.venues.get(venueId);
    return {
      venueId,
      visits: v ? v.visits : 0,
      hourShape,
      meanBasket: this.meanBasket(venueId, archetype),
      confidence: this.confidence(venueId),
    };
  }

  /** monotone version counter — bumped once per observe(). */
  version(): number { return this.ver; }

  // ---------------------------------------------------------------------------
  // persistence — nVenues×24 floats (rounded) + the pooled archetype records.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      ver: this.ver,
      venues: [...this.venues.entries()].map(([id, r]) => recJSON(id, r)),
      archs: [...this.archs.entries()].map(([id, r]) => recJSON(id, r)),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { ver?: number; venues?: unknown; archs?: unknown } | null;
    if (!o) return;
    if (typeof o.ver === 'number') this.ver = o.ver | 0;
    this.venues.clear();
    this.archs.clear();
    if (Array.isArray(o.venues)) for (const row of o.venues) { const p = recLoad(row); if (p) this.venues.set(p[0], p[1]); }
    if (Array.isArray(o.archs)) for (const row of o.archs) { const p = recLoad(row); if (p) this.archs.set(p[0], p[1]); }
  }
}

// ---- record helpers (module-local) ------------------------------------------

/** EMA update of one record's bucket `h`. First observation of a bucket is
 *  adopted outright — an EMA started at 0 would otherwise spend its first
 *  half-life crawling out of a value it never observed. */
function updateRec(rec: Rec, h: number, lam: number, rate: number, arrivals: number, basket: number, dtH: number): void {
  rec.rate[h] = rec.nB[h] <= 0 ? rate : rec.rate[h] + lam * (rate - rec.rate[h]);
  rec.nB[h] += dtH;
  rec.nObs += dtH;
  rec.visits += arrivals;
  if (arrivals > 0 && basket > 0) {
    rec.basket = rec.nBasket <= 0 ? basket : rec.basket + lam * (basket - rec.basket);
    rec.nBasket += dtH;
  }
}

function meanRateOf(rec: Rec): number {
  let s = 0;
  for (let h = 0; h < HOURS; h++) s += rec.rate[h];
  return s / HOURS;
}

function recJSON(id: string, r: Rec): unknown {
  return {
    id,
    arch: r.arch,
    rate: Array.from(r.rate, r5),
    nB: Array.from(r.nB, r3),
    basket: r5(r.basket),
    nBasket: r3(r.nBasket),
    nObs: r3(r.nObs),
    visits: r.visits,
  };
}

function recLoad(row: unknown): [string, Rec] | null {
  const o = row as { id?: unknown; arch?: unknown; rate?: unknown; nB?: unknown; basket?: unknown; nBasket?: unknown; nObs?: unknown; visits?: unknown } | null;
  if (!o || typeof o.id !== 'string') return null;
  const rec = newRec(typeof o.arch === 'string' ? o.arch : '');
  if (Array.isArray(o.rate)) for (let h = 0; h < Math.min(HOURS, o.rate.length); h++) { const x = o.rate[h]; if (typeof x === 'number') rec.rate[h] = x; }
  if (Array.isArray(o.nB)) for (let h = 0; h < Math.min(HOURS, o.nB.length); h++) { const x = o.nB[h]; if (typeof x === 'number') rec.nB[h] = x; }
  if (typeof o.basket === 'number') rec.basket = o.basket;
  if (typeof o.nBasket === 'number') rec.nBasket = o.nBasket;
  if (typeof o.nObs === 'number') rec.nObs = o.nObs;
  if (typeof o.visits === 'number') rec.visits = o.visits;
  return [o.id, rec];
}
