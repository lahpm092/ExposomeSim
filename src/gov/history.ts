// =============================================================================
// ExposomeSim — GOV HISTORY: the polity's time series, t0 → now (EconHistory
// pattern: bounded by pair-merge decimation, resolution degrades gracefully).
// -----------------------------------------------------------------------------
// One compact sample per gov tick (~1 sim-hour) + a priority-evicted stream of
// notable civic events, for the Observatory. Persisted rounded so the branch
// tree stays small.
// =============================================================================

import type { GovEvent, GovEventKind, GovHistoryView, InstitutionState } from './types';

export const GOV_HIST_FIELDS = [
  't',              // abs sim-hours (sample time)
  'state',          // InstitutionState ordinal (STATE_CODE)
  'mass',           // movement mass EMA
  'salience',       // max Tier-A civic salience
  'tierSupport',    // mean Tier-A support
  'shadowSupport',  // mean shadow support
  'shadowGrievance',
  'agitation',
  'legitimacy',
  'treasury',       // ledger balance
  'payrollTax',     // levy rate in force
  'spendOrdered',   // per tick
  'turnout',        // last resolved ballot's cast count (held between ballots)
  'yesShare',       // last resolved ballot's yes/(yes+no)
  'rivalMass',
] as const;

export type GovHistField = (typeof GOV_HIST_FIELDS)[number];

/** ordinal per state — history stores numbers, the Observatory labels them. */
export const STATE_CODE: Record<InstitutionState, number> = {
  dormant: 0, stirring: 1, 'assembly-called': 2, chartered: 3, elected: 4,
  insolvent: 5, recalled: 6, dissolved: 7,
};

const CAP = 1440;          // samples before a decimation pass (≈60 days at 1h)
const EVENT_CAP = 160;

/** petitions are noise next to charters; dissolution outranks everything. */
const EVENT_PRIORITY: Record<GovEventKind, number> = {
  petition: 1, stir: 2, wane: 2, 'quorum-fail': 2, 'charter-fail': 2,
  'election-fail': 2, 'recall-fail': 2, spend: 1, hire: 2, levy: 3,
  assembly: 3, charter: 4, election: 4, recall: 4, insolvent: 4, recover: 3,
  rival: 3, dissolve: 4,
};

export class GovHistory {
  private data: number[][];
  private events: GovEvent[] = [];
  private _version = 0;
  private _stride = 1;
  private idx = new Map<string, number>();

  constructor() {
    this.data = GOV_HIST_FIELDS.map(() => []);
    GOV_HIST_FIELDS.forEach((f, i) => this.idx.set(f, i));
  }

  get version(): number { return this._version; }
  get n(): number { return this.data[0].length; }

  record(s: Partial<Record<GovHistField, number>>): void {
    for (let i = 0; i < GOV_HIST_FIELDS.length; i++) {
      const v = s[GOV_HIST_FIELDS[i]];
      this.data[i].push(typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }
    if (this.data[0].length > CAP) this.decimate();
    this._version++;
  }

  event(t: number, kind: GovEventKind, label: string, mag?: number): void {
    this.events.push(mag === undefined ? { t, kind, label } : { t, kind, label, mag });
    if (this.events.length > EVENT_CAP) this.evictEvent();
    this._version++;
  }

  view(): GovHistoryView {
    return {
      version: this._version,
      n: this.n,
      stride: this._stride,
      fields: GOV_HIST_FIELDS,
      data: this.data,
      events: this.events,
    };
  }

  series(f: GovHistField): readonly number[] { return this.data[this.idx.get(f) ?? 0]; }
  eventList(): readonly GovEvent[] { return this.events; }

  /** merge adjacent pairs across every field: span preserved, stride doubles. */
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

  private evictEvent(): void {
    let worst = 0;
    for (let i = 1; i < this.events.length; i++) {
      if (EVENT_PRIORITY[this.events[i].kind] < EVENT_PRIORITY[this.events[worst].kind]) worst = i;
    }
    this.events.splice(worst, 1);
  }

  // ---- persistence ----------------------------------------------------------
  toJSON(): unknown {
    const round = (x: number) => (x === 0 || !Number.isFinite(x)) ? 0 : Number(x.toPrecision(5));
    return {
      v: 1,
      stride: this._stride,
      fields: GOV_HIST_FIELDS,
      data: this.data.map((row) => row.map(round)),
      events: this.events,
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { stride?: number; fields?: string[]; data?: number[][]; events?: GovEvent[] } | null;
    if (!o || !Array.isArray(o.data) || !Array.isArray(o.fields)) return;
    const fresh = GOV_HIST_FIELDS.map(() => [] as number[]);
    const n = o.data[0]?.length ?? 0;
    for (let si = 0; si < o.fields.length; si++) {
      const di = this.idx.get(o.fields[si]);
      if (di !== undefined && Array.isArray(o.data[si])) fresh[di] = o.data[si].slice();
    }
    for (let i = 0; i < fresh.length; i++) if (fresh[i].length !== n) fresh[i] = new Array(n).fill(0);
    this.data = fresh;
    this._stride = typeof o.stride === 'number' && o.stride >= 1 ? o.stride : 1;
    this.events = Array.isArray(o.events) ? o.events.slice(0, EVENT_CAP) : [];
    this._version++;
  }
}
