// =============================================================================
// ExposomeSim — CONGESTION: BPR-style edge delay from a learned load EMA.
// -----------------------------------------------------------------------------
// Every executed car/taxi trip and every shadow commute vehicle deposits load
// on the edges it traverses; per tick the deposits become a vehicles/hour rate
// and relax into a dt-invariant EMA (λ_eff = 1 − 0.5^(dtH/HL)). The classic
// Bureau-of-Public-Roads delay then multiplies each edge's travel time:
//
//     factor(e) = 1 + α · (load_e / capacity)^β        (≥ 1, free flow = 1)
//
// That factor feeds A* edge costs, so congestion prices itself into mode
// choice — and into gov's commuteCostIndex — with no scripted rush hour: the
// jam IS the 8h/18h commute pulse arriving through real trips.
//
// A quantized REGIME (mean factor in 1/24 steps) versions the router's cached
// all-pairs matrices: costEstimate stays O(1) between regime changes and only
// rebuilds when congestion has actually moved.
//
// Deterministic (no RNG). Pending deposits are serialized so a save between
// deposit and tick stays byte-identical.
// =============================================================================

/** BPR parameters — α steeper than the textbook 0.15 so a small town's rush
 *  hour is felt within a handful of edges. */
const ALPHA = 0.9;
const BETA = 3;
/** nominal edge capacity, vehicles/sim-hour. */
const CAP_VEH_H = 55;
/** load EMA half-life, sim-hours — a jam decays over an afternoon. */
const HALF_LIFE_H = 3;

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export class Congestion {
  private load: Float64Array;      // EMA vehicles/hour per edge
  private pending: Float64Array;   // vehicle-entries deposited since last tick
  private regimeQ = 0;             // quantized mean factor
  private regimeVer = 0;           // bumped on regime change → router cache key

  constructor(private nEdges: number) {
    this.load = new Float64Array(nEdges);
    this.pending = new Float64Array(nEdges);
    this.regimeQ = 24;             // mean factor 1.0 × 24
  }

  /** deposit `vehicles` entering edge `e` (executed trip start or shadow flow). */
  addLoad(e: number, vehicles: number): void {
    if (e >= 0 && e < this.nEdges && vehicles > 0) this.pending[e] += vehicles;
  }

  /** relax the EMA toward this tick's arrival rate; requantize the regime. */
  tick(dtH: number): void {
    if (!(dtH > 0)) return;
    const lam = 1 - Math.pow(0.5, dtH / HALF_LIFE_H);
    let sumF = 0;
    for (let e = 0; e < this.nEdges; e++) {
      const rate = this.pending[e] / dtH;
      this.load[e] += lam * (rate - this.load[e]);
      this.pending[e] = 0;
      sumF += this.factor(e);
    }
    const q = Math.round((this.nEdges > 0 ? sumF / this.nEdges : 1) * 24);
    if (q !== this.regimeQ) { this.regimeQ = q; this.regimeVer++; }
  }

  /** BPR delay multiplier for edge `e` — ≥ 1, 1 at free flow. The v/c ratio
   *  caps at 4 (total gridlock) so a pathological pulse can't send costs to
   *  numerical infinity. */
  factor(e: number): number {
    const x = Math.min(this.load[e] / CAP_VEH_H, 4);
    return 1 + ALPHA * Math.pow(x, BETA);
  }

  loadOf(e: number): number { return this.load[e]; }

  meanFactor(): number {
    if (this.nEdges === 0) return 1;
    let s = 0;
    for (let e = 0; e < this.nEdges; e++) s += this.factor(e);
    return s / this.nEdges;
  }

  /** cache-invalidation key: changes only when quantized congestion moves. */
  regimeVersion(): number { return this.regimeVer; }

  toJSON(): unknown {
    return {
      v: 1,
      regimeQ: this.regimeQ,
      regimeVer: this.regimeVer,
      load: Array.from(this.load, r6),
      pending: Array.from(this.pending, r6),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { regimeQ?: number; regimeVer?: number; load?: unknown; pending?: unknown } | null;
    if (!o) return;
    if (typeof o.regimeQ === 'number') this.regimeQ = o.regimeQ | 0;
    if (typeof o.regimeVer === 'number') this.regimeVer = o.regimeVer | 0;
    if (Array.isArray(o.load)) for (let e = 0; e < Math.min(this.nEdges, o.load.length); e++) {
      const x = o.load[e]; if (typeof x === 'number') this.load[e] = x;
    }
    if (Array.isArray(o.pending)) for (let e = 0; e < Math.min(this.nEdges, o.pending.length); e++) {
      const x = o.pending[e]; if (typeof x === 'number') this.pending[e] = x;
    }
  }
}
