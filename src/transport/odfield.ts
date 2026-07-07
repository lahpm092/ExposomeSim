// =============================================================================
// ExposomeSim — OD FIELD: learned travel demand + the stop queues.
// -----------------------------------------------------------------------------
// Two layers, kept deliberately separate:
//
//   • LEARNED demand — a VenueStats surrogate (reused verbatim from causal/)
//     of boarding rates per stop per hour-of-day, plus an EMA of executed
//     origin→destination trips. Taught ONLY by hot/executed episodes: real
//     trips the sim completed, and queue arrivals at stops inside the causal
//     radius. Never by anything this module generated from its own beliefs —
//     the stats.ts:79 echo-chamber rule.
//   • SHADOW demand — the commute pulse DERIVED each tick from econ's
//     employed-household aggregates and the 8h/18h mixed-use bumps
//     (city.ts:78 shape). Exogenous ground truth, refreshed, not learned.
//
// The stop queues are conservation-with-carry (flow.ts pattern): the carry IS
// the queue. Over any window, per the audit counters,
//     Σ arrivals == Σ boarded + Σ gaveUp + waiting_now        (to 1e-6)
// Riders whose pair loses service don't vanish — they give up on a patience
// half-life, explicitly counted.
//
// transitplan reads topFlows() (learned ⊕ shadow) — network design emerges
// from demand, not from a route table.
// =============================================================================

import { VenueStats } from '../causal/index';

/** commute bump shape: morning + evening gaussians over a small base. */
const BUMP_BASE = 0.15;
const BUMP_AMP = 2.6;
const BUMP_SIGMA = 1.5;
/** trips per employed household per sim-hour at bump=1 (~2 commutes/day). */
export const TRIPS_PER_EMPLOYED_H = 2 / 24;
/** learned OD flow half-life, sim-hours. */
const OD_HALF_LIFE_H = 48;
/** waiting riders on an unserved pair give up on this half-life. */
const GIVEUP_HALF_LIFE_H = 2;

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** mean-1 diurnal commute multiplier — the 8h/18h pulse. */
export function commuteBump(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const g = (c: number) => Math.exp(-(((h - c) / BUMP_SIGMA) ** 2));
  return (BUMP_BASE + BUMP_AMP * (g(8) + g(18))) / BUMP_NORM;
}
const BUMP_NORM = (() => {
  let s = 0;
  for (let h = 0; h < 24; h++) {
    const g = (c: number) => Math.exp(-(((h - c) / BUMP_SIGMA) ** 2));
    s += BUMP_BASE + BUMP_AMP * (g(8) + g(18));
  }
  return s / 24;
})();

export interface ODFlow { o: string; d: string; flow: number }

export class ODField {
  /** the per-stop hour-shape surrogate — stop ⊕ stop-archetype ⊕ flat. */
  readonly stats = new VenueStats();

  /** executed-trip OD EMA, key `o>d` — event mass with a 48 h half-life. */
  private learned = new Map<string, number>();
  /** shadow commute rates (trips/h), key `o>d` — refreshed each tick. */
  private shadow = new Map<string, number>();
  /** waiting riders, key `o>d` — the carry that IS the queue. */
  private waiting = new Map<string, number>();
  /** per-STOP arrivals accumulated this tick (the observe source when hot). */
  private arrivedTick = new Map<string, number>();

  // audit totals — the conservation invariant's terms.
  arrivalsTotal = 0;
  boardedTotal = 0;
  gaveUpTotal = 0;

  // ---- queues -----------------------------------------------------------------

  /** riders arriving at stop `o` bound for `d` (fractional shadow or whole
   *  executed riders — the aggregate math is identical either way). */
  arrive(o: string, d: string, n: number): void {
    if (!(n > 0) || o === d) return;
    const k = `${o}>${d}`;
    this.waiting.set(k, (this.waiting.get(k) ?? 0) + n);
    this.arrivedTick.set(o, (this.arrivedTick.get(o) ?? 0) + n);
    this.arrivalsTotal += n;
  }

  /** board up to `cap` riders from stop `o` toward any of `dests`, spread
   *  proportionally over the waiting destinations. Returns per-dest amounts. */
  board(o: string, dests: readonly string[], cap: number): { d: string; n: number }[] {
    if (!(cap > 0)) return [];
    let avail = 0;
    for (const d of dests) avail += this.waiting.get(`${o}>${d}`) ?? 0;
    if (avail <= 1e-12) return [];
    const take = Math.min(avail, cap);
    const out: { d: string; n: number }[] = [];
    for (const d of dests) {
      const k = `${o}>${d}`;
      const w = this.waiting.get(k) ?? 0;
      if (w <= 1e-12) continue;
      const n = (w / avail) * take;
      this.waiting.set(k, w - n);
      out.push({ d, n });
      this.boardedTotal += n;
    }
    return out;
  }

  /** decay waiting riders on pairs NO route serves — patience is finite. */
  giveUp(served: ReadonlySet<string>, dtH: number): number {
    const frac = 1 - Math.pow(0.5, dtH / GIVEUP_HALF_LIFE_H);
    let gone = 0;
    for (const [k, w] of this.waiting) {
      if (w <= 1e-12 || served.has(k)) continue;
      const g = w * frac;
      this.waiting.set(k, w - g);
      gone += g;
    }
    this.gaveUpTotal += gone;
    return gone;
  }

  waitingAt(stop: string): number {
    let s = 0;
    const pre = `${stop}>`;
    for (const [k, w] of this.waiting) if (k.startsWith(pre)) s += w;
    return s;
  }

  waitingSum(): number {
    let s = 0;
    for (const w of this.waiting.values()) s += w;
    return s;
  }

  // ---- learning (hot/executed only) --------------------------------------------

  /** an EXECUTED trip completed — ground truth for the OD surface. */
  learnTrip(o: string, d: string): void {
    if (o === d) return;
    const k = `${o}>${d}`;
    this.learned.set(k, (this.learned.get(k) ?? 0) + 1);
  }

  /** decay the learned OD mass — dt-invariant half-life. */
  decay(dtH: number): void {
    if (!(dtH > 0)) return;
    const keep = Math.pow(0.5, dtH / OD_HALF_LIFE_H);
    for (const [k, v] of this.learned) this.learned.set(k, v * keep);
  }

  /** feed a HOT stop's queue arrivals into the hour-shape surrogate. Arrivals
   *  are always exogenous (econ-derived pulse or executed trips) — never
   *  computed from these stats — so observing them is echo-safe; the hot gate
   *  still applies so cold cadence artifacts never teach. */
  observeHot(stop: string, arch: string, hour: number, dtH: number): void {
    this.stats.observe(stop, arch, hour, this.arrivedTick.get(stop) ?? 0, 1, dtH);
  }

  /** clear the per-tick arrival scratch (call at each tick start). */
  beginTick(): void { this.arrivedTick.clear(); }

  // ---- shadow demand -------------------------------------------------------------

  /** refresh the derived commute rates: employed × bump(hour) × pair weight. */
  setShadowRates(rows: readonly { from: string; to: string; weight: number }[] | undefined,
                 employed: number, hour: number): void {
    this.shadow.clear();
    if (!rows || !(employed > 0)) return;
    const bump = commuteBump(hour);
    const base = employed * TRIPS_PER_EMPLOYED_H * bump;
    for (const r of rows) {
      if (!(r.weight > 0) || r.from === r.to) continue;
      // morning flows out, evening flows back — one pulse, two directions.
      const h24 = ((hour % 24) + 24) % 24;
      const morning = Math.exp(-(((h24 - 8) / BUMP_SIGMA) ** 2));
      const evening = Math.exp(-(((h24 - 18) / BUMP_SIGMA) ** 2));
      const split = morning + evening > 1e-9 ? morning / (morning + evening) : 0.5;
      this.addShadow(r.from, r.to, base * r.weight * split);
      this.addShadow(r.to, r.from, base * r.weight * (1 - split));
    }
  }

  private addShadow(o: string, d: string, rate: number): void {
    if (!(rate > 0)) return;
    const k = `${o}>${d}`;
    this.shadow.set(k, (this.shadow.get(k) ?? 0) + rate);
  }

  shadowRates(): ReadonlyMap<string, number> { return this.shadow; }

  // ---- planning input --------------------------------------------------------------

  /** the demand surface transitplan designs against: learned ⊕ shadow, top k.
   *  Deterministic order (flow desc, key asc tie-break). */
  topFlows(k: number): ODFlow[] {
    const merged = new Map<string, number>();
    for (const [key, v] of this.shadow) merged.set(key, v);
    for (const [key, v] of this.learned) merged.set(key, (merged.get(key) ?? 0) + v * 0.05);
    const rows = [...merged.entries()].filter(([, v]) => v > 1e-9);
    rows.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    return rows.slice(0, k).map(([key, flow]) => {
      const [o, d] = key.split('>');
      return { o, d, flow };
    });
  }

  // ---- persistence -----------------------------------------------------------------

  toJSON(): unknown {
    return {
      v: 1,
      stats: this.stats.toJSON(),
      learned: [...this.learned.entries()].map(([k, v]) => [k, r6(v)]),
      waiting: [...this.waiting.entries()].map(([k, v]) => [k, r6(v)]),
      totals: [r6(this.arrivalsTotal), r6(this.boardedTotal), r6(this.gaveUpTotal)],
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { stats?: unknown; learned?: unknown; waiting?: unknown; totals?: unknown } | null;
    if (!o) return;
    this.stats.loadJSON(o.stats);
    this.learned.clear();
    this.waiting.clear();
    this.arrivedTick.clear();
    if (Array.isArray(o.learned)) for (const row of o.learned) {
      if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number') this.learned.set(row[0], row[1]);
    }
    if (Array.isArray(o.waiting)) for (const row of o.waiting) {
      if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'number') this.waiting.set(row[0], row[1]);
    }
    if (Array.isArray(o.totals)) {
      this.arrivalsTotal = num(o.totals[0]);
      this.boardedTotal = num(o.totals[1]);
      this.gaveUpTotal = num(o.totals[2]);
    }
  }
}

const num = (x: unknown): number => (typeof x === 'number' ? x : 0);
