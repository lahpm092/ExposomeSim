// =============================================================================
// history.ts — TransportHistory: the network's macro time series, t0 → now,
// plus notable events (replans, jams, stranded riders). The observatory and
// the gov module read it; one compact sample per transport tick (~1 sim-h).
//
// Memory bounded by pair-merge decimation (the EconHistory pattern): at CAP
// the whole series merges pairwise and the stride doubles, so the series
// always spans the run at gracefully degrading resolution.
// =============================================================================

import type { TransportEvent, TransportEventKind, TransportHistoryView } from './types';

export const THIST_FIELDS = [
  't',              // abs sim-hours
  'tripsStarted',
  'tripsArrived',
  'shareWalk', 'shareBike', 'shareCar', 'shareTaxi', 'shareBus',
  'congestion',     // mean BPR factor
  'commuteCost',    // the gov-facing index
  'boarded',        // riders boarded this tick
  'aboard',         // riders in transit now
  'waiting',        // riders queued at stops now
  'taxiUtil',
  'taxiWaitH',
  'fare',           // fare revenue commanded this tick
  'routes',
] as const;

export type THistField = (typeof THIST_FIELDS)[number];

const CAP = 1440;
const EVENT_CAP = 160;

const EVENT_PRIORITY: Record<TransportEventKind, number> = {
  replan: 3, service: 3, jam: 2, strand: 1,
};

export class TransportHistory {
  private data: number[][];
  private events: TransportEvent[] = [];
  private _version = 0;
  private _stride = 1;

  constructor() {
    this.data = THIST_FIELDS.map(() => []);
  }

  get version(): number { return this._version; }
  get n(): number { return this.data[0].length; }

  record(s: Partial<Record<THistField, number>>): void {
    for (let i = 0; i < THIST_FIELDS.length; i++) {
      const v = s[THIST_FIELDS[i]];
      this.data[i].push(typeof v === 'number' && Number.isFinite(v) ? v : 0);
    }
    if (this.data[0].length > CAP) this.decimate();
    this._version++;
  }

  event(t: number, kind: TransportEventKind, label: string): void {
    this.events.push({ t, kind, label });
    if (this.events.length > EVENT_CAP) this.evictEvent();
    this._version++;
  }

  view(): TransportHistoryView {
    return {
      version: this._version,
      n: this.n,
      stride: this._stride,
      fields: THIST_FIELDS,
      data: this.data,
      events: this.events,
    };
  }

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

  toJSON(): unknown {
    const round = (x: number) => (x === 0 || !Number.isFinite(x)) ? 0 : Number(x.toPrecision(5));
    return {
      v: 1,
      stride: this._stride,
      fields: THIST_FIELDS,
      data: this.data.map((row) => row.map(round)),
      events: this.events,
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { stride?: number; fields?: string[]; data?: number[][]; events?: TransportEvent[] } | null;
    if (!o || !Array.isArray(o.data) || !Array.isArray(o.fields)) return;
    const fresh = THIST_FIELDS.map(() => [] as number[]);
    const n = o.data[0]?.length ?? 0;
    for (let si = 0; si < o.fields.length; si++) {
      const di = (THIST_FIELDS as readonly string[]).indexOf(o.fields[si]);
      if (di >= 0 && Array.isArray(o.data[si])) fresh[di] = o.data[si].slice();
    }
    for (let i = 0; i < fresh.length; i++) if (fresh[i].length !== n) fresh[i] = new Array(n).fill(0);
    this.data = fresh;
    this._stride = typeof o.stride === 'number' && o.stride >= 1 ? o.stride : 1;
    this.events = Array.isArray(o.events) ? o.events.slice(0, EVENT_CAP) : [];
    this._version++;
  }
}
