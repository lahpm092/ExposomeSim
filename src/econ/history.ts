// =============================================================================
// history.ts — EconHistory: the run's macro time series, t0 → now, plus the
// notable-event stream. The Economy Observatory (render/econviz.ts) draws it.
//
// One compact sample per econ tick (~1 sim-hour). Memory is BOUNDED by
// pair-merge decimation: when the buffer hits CAP the whole series is merged
// pairwise (values averaged, cumulative/level fields keep the later value is
// unnecessary — averaging is fine at this resolution) and the stride doubles,
// so the series always spans the WHOLE run at a resolution that degrades
// gracefully as the run grows (1h → 2h → 4h …). 1440 samples ≈ 60 days at
// full resolution.
//
// Persistence: serialized (rounded to 5 significant digits to keep the
// localStorage branch nodes small) in EconJSON via toJSON/loadJSON, so the
// Observatory's past survives reload, branching and jumps.
// =============================================================================

import type { EconEvent, EconEventKind, EconHistoryView } from './types';

/** Row names, index-aligned with the data matrix. The Observatory addresses
 *  rows by these keys, so treat the list as append-only. */
export const HIST_FIELDS = [
  't',              // abs sim-hours (sample time)
  'cpi',            // reported CPI (goods × price level)
  'goodsCpi',       // tâtonnement-only CPI
  'piAnnual',       // annualized inflation (the Fed's Phillips path)
  'unemployment',
  'gdp',            // per-hour output rate
  'boom',           // -1..1 cycle indicator
  'meanWage',
  'homeless',
  'gini',
  'policyRate',
  'lendRate',       // avg commercial lending rate
  'baseMoney',
  'broadMoney',
  'creditCreated',  // per tick
  'creditRepaid',   // per tick
  'writeOffs',      // per tick (defaults hitting bank capital)
  'depositInterest',// per tick
  'bankCapital',    // Σ bank equity
  'bankCapRatio',   // min capital ratio across banks (the binding gate)
  'consumerDebt',   // Σ household loans
  'defaults',       // cumulative consumer defaults
  'firmsAlive',
  'firmBirths',     // cumulative
  'firmDeaths',     // cumulative
  'vacancies',
  'employed',
  'laborForce',
  'priceFood', 'priceGroceries', 'priceSoftware', 'priceUtilities', 'priceRetail',
  'shortFood', 'shortGroceries', 'shortSoftware', 'shortUtilities', 'shortRetail',
  'rent',
  'housingVacancy',
  'dwellings',
  'inventory',      // Σ firm finished-goods stock
  'smFill',         // supermarket shelf fill 0..1
  'wealthP10', 'wealthP25', 'wealthP50', 'wealthP75', 'wealthP90',
  // ---- phase 5 (append-only; old saves zero-fill by name) ----
  'priceHomegoods', 'priceApparel',
  'shortHomegoods', 'shortApparel',
  'wholesaleBakery',   // bakery wholesale clearing price
  'wholesaleFurniture',
  'pendingPremises',   // entrants queueing for a commercial unit
  'commercialUnits',   // total premises units minted
  'makerCount',
  'retailCount',
  // ---- phase 6: mobility + civic (append-only; old saves zero-fill) ----
  'priceTransit', 'priceVehicles',
  'shortTransit', 'shortVehicles',
  'carOwners',         // households owning a car
  'bikeOwners',
  'commuteDemand',     // fare-demand units per tick
  'fareSpend',         // fares debited per tick (shadow)
  'taxTake',           // levies collected per tick
  'treasury',          // gov treasury balance
  'govStaff',          // Σ public-roster headcount
] as const;

export type HistField = (typeof HIST_FIELDS)[number];

const CAP = 1440;          // samples before a decimation pass (≈60 days at 1h)
const EVENT_CAP = 240;     // notable events kept

/** eviction/expansion drama ranks below births/deaths/defaults/policy moves. */
const EVENT_PRIORITY: Record<EconEventKind, number> = {
  found: 3, bankrupt: 3, default: 2, policy: 2, boom: 2, bust: 2, evict: 1,
  tax: 2, 'founded-public': 3,
};

export class EconHistory {
  private data: number[][];
  private events: EconEvent[] = [];
  private _version = 0;
  private _stride = 1;               // sim-hours per sample after decimation
  private idx = new Map<string, number>();

  constructor() {
    this.data = HIST_FIELDS.map(() => []);
    HIST_FIELDS.forEach((f, i) => this.idx.set(f, i));
  }

  get version(): number { return this._version; }
  get n(): number { return this.data[0].length; }

  /** append one sample; `s` must hold every field (missing keys record 0). */
  record(s: Partial<Record<HistField, number>>): void {
    for (let i = 0; i < HIST_FIELDS.length; i++) {
      const v = s[HIST_FIELDS[i]];
      this.data[i].push(typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }
    if (this.data[0].length > CAP) this.decimate();
    this._version++;
  }

  /** notable event for the Observatory's event lane. */
  event(t: number, kind: EconEventKind, label: string, mag?: number): void {
    this.events.push(mag === undefined ? { t, kind, label } : { t, kind, label, mag });
    if (this.events.length > EVENT_CAP) this.evictEvent();
    this._version++;
  }

  /** live, read-only view (the snapshot hands this straight to the render). */
  view(): EconHistoryView {
    return {
      version: this._version,
      n: this.n,
      stride: this._stride,
      fields: HIST_FIELDS,
      data: this.data,
      events: this.events,
    };
  }

  series(f: HistField): readonly number[] { return this.data[this.idx.get(f) ?? 0]; }

  // ---- bounding -------------------------------------------------------------
  /** merge adjacent pairs across every field: the span (t0→now) is preserved,
   *  the resolution halves, the stride doubles. */
  private decimate(): void {
    for (let fi = 0; fi < this.data.length; fi++) {
      const src = this.data[fi];
      const half = src.length >> 1;
      const dst = new Array<number>(half + (src.length & 1));
      for (let i = 0; i < half; i++) dst[i] = (src[2 * i] + src[2 * i + 1]) / 2;
      if (src.length & 1) dst[half] = src[src.length - 1];
      this.data[fi] = dst;
    }
    this._stride *= 2;
  }

  /** drop the oldest lowest-priority event so the drama that matters survives. */
  private evictEvent(): void {
    let worst = 0;
    for (let i = 1; i < this.events.length; i++) {
      if (EVENT_PRIORITY[this.events[i].kind] < EVENT_PRIORITY[this.events[worst].kind]) worst = i;
    }
    this.events.splice(worst, 1);
  }

  // ---- persistence ----------------------------------------------------------
  toJSON(): unknown {
    // round to 5 significant digits — halves the JSON footprint in the branch tree.
    const round = (x: number) => (x === 0 || !Number.isFinite(x)) ? 0 : Number(x.toPrecision(5));
    return {
      v: 1,
      stride: this._stride,
      fields: HIST_FIELDS,
      data: this.data.map((row) => row.map(round)),
      events: this.events,
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { v?: number; stride?: number; fields?: string[]; data?: number[][]; events?: EconEvent[] } | null;
    if (!o || !Array.isArray(o.data) || !Array.isArray(o.fields)) return;
    // map saved rows by field NAME so old saves survive field-list growth.
    const fresh = HIST_FIELDS.map(() => [] as number[]);
    const n = o.data[0]?.length ?? 0;
    for (let si = 0; si < o.fields.length; si++) {
      const di = this.idx.get(o.fields[si]);
      if (di !== undefined && Array.isArray(o.data[si])) fresh[di] = o.data[si].slice();
    }
    // any field absent from the save gets zero-fill to keep the matrix rectangular.
    for (let i = 0; i < fresh.length; i++) if (fresh[i].length !== n) fresh[i] = new Array(n).fill(0);
    this.data = fresh;
    this._stride = typeof o.stride === 'number' && o.stride >= 1 ? o.stride : 1;
    this.events = Array.isArray(o.events) ? o.events.slice(0, EVENT_CAP) : [];
    this._version++;
  }
}
