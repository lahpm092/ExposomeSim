// =============================================================================
// ExposomeSim — CAUSAL FIELD: the one-call facade over gate + stats + flow.
// -----------------------------------------------------------------------------
// Integration surface for town/econ (wired later; nothing imports this yet):
// the caller hands tick() the current causal centers (Tier-A positions + the
// camera), the venue points, and each venue's EXACT aggregate flow slice from
// the econ tick — and gets back per-venue VenueFlowTicks: discrete customer
// events where somebody is watching, conserved statistical drift where nobody
// is. view() is the HUD/observatory readout.
//
// Cadences: tick() runs on the econ clock (ECON_TICK_HOURS); the gate's
// distance sweep is throttled internally to ~once per 0.25 sim-h so callers
// can tick at any dt without paying the (already cheap) sweep more often than
// the hot set can usefully change.
//
// The three parts stay individually reachable (readonly fields) because the
// renderer wants gate.isHot() for interior mounting and the observatory wants
// stats' shapes directly — the facade composes, it does not hide.
// =============================================================================

import { CausalGate } from './gate';
import { VenueStats } from './stats';
import { VenueFlow } from './flow';
import type { CausalCenter, CausalView, VenueFlowInput, VenueFlowTick, VenuePoint } from './types';

export { CausalGate } from './gate';
export { VenueStats } from './stats';
export { VenueFlow } from './flow';
export type {
  CausalCenter, VenuePoint, VenueHeat, VenueFlowInput, VenueFlowTick,
  CausalView, VenueStatsView,
} from './types';

/** minimum sim-hours between gate distance sweeps. */
const GATE_PERIOD_H = 0.25;

export interface CausalFieldOpts {
  radius?: number;         // attention radius, metres (default 55)
  seed?: number;           // flow's Poisson stream seed
  defaultBasket?: number;  // units/customer before anything is learned
}

export class CausalField {
  readonly gate: CausalGate;
  readonly stats: VenueStats;
  readonly flow: VenueFlow;

  /** sim-hour of the last gate sweep (throttle state). */
  private lastGateH: number | null = null;
  /** venueId → archetype, refreshed from the venue list each tick (so view()
   *  can report venues that have never been hot). Reused map. */
  private archOf = new Map<string, string>();

  constructor(opts: CausalFieldOpts = {}) {
    this.gate = new CausalGate(opts.radius);
    this.stats = new VenueStats();
    this.flow = new VenueFlow(this.stats, opts.seed ?? 1, opts.defaultBasket);
  }

  // ---------------------------------------------------------------------------
  // tick — resolve every venue's aggregate flow at the right resolution.
  //   `clock` is absolute sim-hours; `dtH` the elapsed sim-hours (the econ dt).
  // ---------------------------------------------------------------------------
  tick(centers: readonly CausalCenter[], venues: readonly VenuePoint[],
       flows: readonly VenueFlowInput[], clock: number, dtH: number): VenueFlowTick[] {
    if (this.lastGateH === null || clock - this.lastGateH >= GATE_PERIOD_H - 1e-9) {
      this.gate.update(centers, venues, clock);
      this.lastGateH = clock;
    }
    for (const v of venues) this.archOf.set(v.id, v.archetype);

    const hour = hourOf(clock);
    const out: VenueFlowTick[] = [];
    for (const f of flows) {
      const arch = this.archOf.get(f.venueId) ?? 'unknown';
      out.push(this.flow.run(f.venueId, arch, f.units, f.revenue,
                             this.gate.isHot(f.venueId), hour, dtH));
    }
    return out;
  }

  /** compact snapshot: radius, current hot set, per-venue surrogate stats. */
  view(): CausalView {
    const stats: CausalView['stats'] = [];
    for (const [id, arch] of this.archOf) stats.push(this.stats.statsView(id, arch));
    return { radius: this.gate.radius, hot: [...this.gate.hotList()], stats };
  }

  // ---------------------------------------------------------------------------
  // persistence — compose the parts + the throttle cursor + the venue roster.
  // ---------------------------------------------------------------------------
  toJSON(): unknown {
    return {
      v: 1,
      lastGateH: this.lastGateH === null ? null : Math.round(this.lastGateH * 1e3) / 1e3,
      venues: [...this.archOf.entries()],
      gate: this.gate.toJSON(),
      stats: this.stats.toJSON(),
      flow: this.flow.toJSON(),
    };
  }

  loadJSON(j: unknown): void {
    const o = j as { lastGateH?: unknown; venues?: unknown; gate?: unknown; stats?: unknown; flow?: unknown } | null;
    if (!o) return;
    this.lastGateH = typeof o.lastGateH === 'number' ? o.lastGateH : null;
    if (Array.isArray(o.venues)) {
      this.archOf.clear();
      for (const row of o.venues) {
        if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string') this.archOf.set(row[0], row[1]);
      }
    }
    this.gate.loadJSON(o.gate);
    this.stats.loadJSON(o.stats);
    this.flow.loadJSON(o.flow);
  }
}

/** hour-of-day bucket for an absolute sim-hour clock. */
function hourOf(clock: number): number {
  return ((Math.floor(clock) % 24) + 24) % 24;
}
